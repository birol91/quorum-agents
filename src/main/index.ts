import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { QuorumManager } from './manager.ts';
import { QuorumBridge } from './bridge.ts';
import { ensureProjectClaudeMd } from './claudeMd.ts';
import { loadTeam, type Team } from './team.ts';
import { MAX_AGENTS } from '../bus.ts';
import { readAgentCatalog } from './agentCatalog.ts';
import type { IpcChannel, IpcEnvelope, QuorumEvent } from '../shared/ipc.ts';

// Dev loads the Vite server; set QUORUM_PROD=1 to load the built bundle instead.
const isDev = !app.isPackaged && process.env.QUORUM_PROD !== '1';

// The agent catalog (marketplace) lives at the repo root .claude/agents.
const AGENTS_DIR = path.join(__dirname, '../../.claude/agents');

// Quorum works per PROJECT, like an editor: you open a folder, the agents run
// with that folder as cwd, and all state (team, decisions, tasks, layout)
// persists under <project>/.quorum/ so reopening restores the same team.
// Resolution order: QUORUM_PROJECT env (scripts) > last opened project >
// the per-user scratch dir (userData — no project opened yet).
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function recentProjects(): string[] {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { lastProject?: string; recentProjects?: string[] };
    const list = s.recentProjects ?? (s.lastProject ? [s.lastProject] : []);
    return list.filter((d) => existsSync(d));
  } catch {
    return [];
  }
}

function rememberProject(dir: string): void {
  if (dir === app.getPath('userData')) return; // the scratch dir is not a project
  try {
    const list = [dir, ...recentProjects().filter((d) => d !== dir)].slice(0, 8);
    writeFileSync(SETTINGS_FILE, `${JSON.stringify({ lastProject: dir, recentProjects: list }, null, 2)}\n`);
  } catch (err) {
    console.error('could not persist settings:', err);
  }
}

/**
 * Team for a project dir: the persisted live team (.quorum/team.json) wins;
 * a root team.json seeds a fresh project (example/, script fixtures); no file
 * at all → empty team, build it from the marketplace.
 */
function teamFor(projectDir: string): Team {
  for (const file of [path.join(projectDir, '.quorum', 'team.json'), path.join(projectDir, 'team.json')]) {
    if (!existsSync(file)) continue;
    try {
      const team = loadTeam(file);
      if (team.members.length > MAX_AGENTS) {
        dialog.showErrorBox('Quorum', `${file} has ${team.members.length} agents; max is ${MAX_AGENTS}. Starting empty.`);
        break;
      }
      return team;
    } catch (err) {
      dialog.showErrorBox('Quorum', `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}. Starting empty.`);
      break;
    }
  }
  return { project: path.basename(projectDir), members: [] };
}

let manager: QuorumManager | null = null;
let win: BrowserWindow | null = null;

// Claude Code bridge (brief §14 "dış lead"): an external Claude Code session
// drives the team over MCP while the app visualizes. User-bound deliveries
// are teed into the bridge inbox so its replies() long-poll can hand them out.
const bridge = new QuorumBridge({
  ask: (text, selected) => manager?.sendUserInput(text, selected, 'bridge') ?? 0,
  roster: () => manager?.roster() ?? [],
  projectDir: () => manager?.snapshot().project.dir ?? '',
  onActivity: (level) => emit({ type: 'leadState', level }),
  // The lead interrupted its in-flight bridge call (ESC in Claude Code):
  // mirror the in-app ESC — abort busy agents, cancel their reply debts.
  onLeadInterrupt: () => {
    void manager?.interruptBusy().then((names) => {
      if (names.length > 0) console.log(`[bridge] interrupted with the lead: ${names.join(', ')}`);
    });
  },
  trace: (l) => console.log(l),
});

function emit(event: QuorumEvent): void {
  if (event.type === 'message' && event.message.to === 'user') bridge.pushReply(event.message);
  win?.webContents.send('quorum:event', event);
}

function startSessions(): void {
  // QUORUM_NO_SESSIONS=1 renders roster/panels without spawning claude (no quota).
  if (process.env.QUORUM_NO_SESSIONS !== '1') {
    manager?.start().catch((err) => console.error('session start failed:', err));
  }
}

/** Tear down the current project (if any) and stand up the given one. */
async function initManager(projectDir: string, opts: { spawnSessions?: boolean } = {}): Promise<void> {
  await manager?.shutdown().catch(() => {});
  const team = teamFor(projectDir);
  // The scratch dir is not a real project — make the header badge say so.
  if (projectDir === app.getPath('userData')) team.project = 'no project';
  else if (ensureProjectClaudeMd(projectDir, team.project)) {
    // First open of a CLAUDE.md-less project: scaffold the team instruction
    // file. The lead reads it natively; agents get it injected at spawn.
    console.log(`[claude-md] scaffolded ${path.join(projectDir, 'CLAUDE.md')}`);
  }
  manager = new QuorumManager(team, projectDir, path.join(projectDir, '.quorum'), emit, AGENTS_DIR);
  emit({ type: 'roster', agents: manager.roster() });
  if (opts.spawnSessions !== false) startSessions();
}

function registerIpc(): void {
  const handle = <C extends IpcChannel>(
    channel: C,
    fn: (input: unknown) => unknown,
  ): void => {
    ipcMain.handle(channel, async (_e, input): Promise<IpcEnvelope<unknown>> => {
      try {
        return { ok: true, data: await fn(input) };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    });
  };

  handle('app:health', () => ({ ok: true as const, version: app.getVersion() }));
  handle('quorum:snapshot', () => manager!.snapshot());
  handle('quorum:sendUserInput', (input) => {
    const { text, selected } = input as { text: string; selected?: string[] };
    const routed = manager!.sendUserInput(text, selected ?? []);
    return { ok: true as const, routed };
  });
  handle('quorum:saveLayout', (input) => {
    manager!.saveLayout((input as { layout: import('../shared/ipc.ts').LayoutMap }).layout);
    return { ok: true as const };
  });
  handle('quorum:clearDecisions', () => {
    manager!.clearDecisions();
    return { ok: true as const };
  });
  handle('quorum:clearLayout', () => {
    manager!.clearLayout();
    return { ok: true as const };
  });
  handle('quorum:updateAgent', async (input) => {
    const { name, model, permissionMode, effort } = input as {
      name: string;
      model?: import('../shared/ipc.ts').ModelName;
      permissionMode?: import('../shared/ipc.ts').PermissionMode;
      effort?: import('../shared/ipc.ts').EffortLevel;
    };
    await manager!.updateAgent(name, model, permissionMode, effort);
    return { ok: true as const };
  });
  handle('marketplace:list', () => ({ agents: readAgentCatalog(AGENTS_DIR) }));
  handle('quorum:addAgent', async (input) => {
    const name = await manager!.addAgentFromCatalog((input as { file: string }).file);
    return { ok: true as const, name };
  });
  handle('quorum:removeAgent', async (input) => {
    await manager!.removeAgent((input as { name: string }).name);
    return { ok: true as const };
  });
  handle('quorum:setLead', (input) => {
    manager!.setLead((input as { name: string | null }).name);
    return { ok: true as const };
  });
  handle('quorum:interrupt', async () => {
    const interrupted = await manager!.interruptBusy();
    return { ok: true as const, interrupted };
  });
  // Welcome screen: recent projects (existing dirs only, most recent first).
  handle('quorum:recentProjects', () => ({
    projects: recentProjects().map((dir) => ({ dir, name: path.basename(dir) })),
  }));
  // Welcome screen: open a known project path directly (no native dialog).
  handle('quorum:openProjectPath', async (input) => {
    const { dir } = input as { dir: string };
    if (!existsSync(dir)) return { ok: true as const, opened: false };
    await initManager(dir);
    rememberProject(dir);
    win?.webContents.reload();
    return { ok: true as const, opened: true };
  });
  handle('quorum:openProject', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const dir = res.filePaths[0];
    if (res.canceled || !dir) return { ok: true as const, opened: false };
    await initManager(dir);
    // Only an explicit user pick becomes the remembered project — script
    // launches via QUORUM_PROJECT must not hijack the next manual start.
    rememberProject(dir);
    // Fresh renderer boot: it re-hydrates from the new project's snapshot.
    win?.webContents.reload();
    return { ok: true as const, opened: true };
  });
  handle('quorum:resolvePermission', (input) => {
    const { id, behavior } = input as { id: string; behavior: 'allow' | 'deny' };
    manager!.resolvePermission(id, behavior);
    return { ok: true as const };
  });
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: 'Quorum',
    backgroundColor: '#0a0e1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });
  if (isDev) await win.loadURL('http://localhost:5173');
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from the bundled .icns; in dev, set the Dock
  // icon at runtime so `npm start` shows the logo too. build/icon.png is the
  // macOS-styled version (rounded tile + standard margins), not the raw logo.
  if (!app.isPackaged && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(path.join(__dirname, '../../build/icon.png'));
    } catch {
      /* missing icon must never block launch */
    }
  }
  registerIpc();
  // No auto-open: a plain launch lands on the welcome screen (splash + recent
  // projects) and the user picks. QUORUM_PROJECT (scripts) still boots direct.
  const projectDir = process.env.QUORUM_PROJECT ?? app.getPath('userData');
  // Manager exists before the renderer's first snapshot; sessions start after
  // the window exists so early events reach the renderer.
  await initManager(projectDir, { spawnSessions: false });
  bridge.listen(Number(process.env.QUORUM_BRIDGE_PORT ?? 8484));
  await createWindow();
  startSessions();
});

app.on('before-quit', () => {
  bridge.close();
  void manager?.shutdown();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
