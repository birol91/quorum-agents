import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bus, MAX_AGENTS } from '../bus.ts';
import { SdkSession } from '../session.ts';
import { buildSystemPrompt, DECISION_PROTOCOL, teamMemoryDigest } from '../protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../tools.ts';
import { DecisionStore } from '../decisions.ts';
import { TaskBoard } from '../tasks.ts';
import type { AgentView, LayoutMap, ModelName, PermissionMode, PermissionRequest, QuorumEvent } from '../shared/ipc.ts';
import { MODELS, MODEL_CLI_ID } from '../shared/ipc.ts';
import type { BusMessage } from '../types.ts';
import { PermissionBroker } from './permissions.ts';
import { readProjectClaudeMd } from './claudeMd.ts';
import { rosterOf, saveTeam, type Team } from './team.ts';

/**
 * The orchestrator: stands up the P0-P2 core (bus + sessions + decision store)
 * from a team definition and streams live state to the renderer. It carries
 * messages and state; it never generates content or calls a model (brief §3.3).
 */
export class QuorumManager {
  readonly bus: Bus;
  readonly store: DecisionStore;
  readonly tasks: TaskBoard;
  private readonly sessions = new Map<string, SdkSession>();
  // Per-agent settings, mutable via updateAgent (model + permission mode).
  private readonly settings = new Map<string, { model: ModelName; permissionMode: PermissionMode }>();
  private readonly broker: PermissionBroker;
  private readonly emit: (e: QuorumEvent) => void;

  private readonly team: Team;
  private readonly cwd: string;
  private readonly stateDir: string;
  private readonly agentsDir: string;
  private layout: LayoutMap = {};

  constructor(team: Team, cwd: string, decisionsDir: string, emit: (e: QuorumEvent) => void, agentsDir?: string) {
    this.team = team;
    this.cwd = cwd;
    this.stateDir = decisionsDir;
    this.agentsDir = agentsDir ?? join(cwd, '.claude', 'agents');
    this.emit = emit;
    this.store = new DecisionStore(decisionsDir);
    this.tasks = new TaskBoard(decisionsDir);
    const layoutPath = join(decisionsDir, 'layout.json');
    if (existsSync(layoutPath)) {
      try {
        this.layout = JSON.parse(readFileSync(layoutPath, 'utf8')) as LayoutMap;
      } catch {
        this.layout = {};
      }
    }
    for (const m of team.members) {
      const model = (MODELS as readonly string[]).includes(m.model) ? (m.model as ModelName) : 'haiku';
      this.settings.set(m.name, { model, permissionMode: m.permissionMode ?? 'write' });
    }
    this.broker = new PermissionBroker(
      (r) => emit({ type: 'permissionRequest', request: r }),
      (id) => emit({ type: 'permissionResolved', id }),
    );

    this.bus = new Bus({
      roster: rosterOf(team),
      onUserMessage: (m) => emit({ type: 'message', message: m }),
      // Truthful "what is it doing" labels: delivery outcomes, not tool intent.
      onAgentActivity: (name, activity) => emit({ type: 'agentActivity', name, activity }),
      onNote: () => {},
      trace: () => {},
    });
    // Every routed message (agent->agent and user->agent) is mirrored to the UI.
    const originalDeliver = this.bus.deliver.bind(this.bus);
    this.bus.deliver = (m: BusMessage) => {
      if (m.to !== 'user') emit({ type: 'message', message: { ...m, at: Date.now() } });
      originalDeliver(m);
    };
  }

  /**
   * Spawn the child sessions. Separate from the constructor because building a
   * quorum MCP server requires the ESM-only SDK (dynamic import → async).
   * Skipped entirely in the no-sessions dev/demo mode.
   */
  private started = false;

  async start(): Promise<void> {
    this.started = true;
    for (const member of this.team.members) await this.spawnOne(member.name);
  }

  private async spawnOne(name: string, resume?: string): Promise<void> {
    const roster = rosterOf(this.team);
    const member = this.team.members.find((m) => m.name === name)!;
    const settings = this.settings.get(name)!;
    // Live roster provider — list_agents reflects agents added after this spawn.
    const server = await quorumServerFor(name, () => this.bus.roster, (msg) => this.bus.deliver(msg), {
      recordDecision: (d) => {
        const entry = this.store.record(d);
        this.emit({ type: 'decision', decision: entry });
      },
      decisions: () => this.store.decisions,
      taskBoard: this.tasks,
    });
    const session = new SdkSession({
      name,
      model: MODEL_CLI_ID[settings.model],
      cwd: this.cwd,
      resume,
      // Re-read CLAUDE.md on every spawn so edits reach new/restarted agents.
      systemPrompt: buildSystemPrompt(
        name,
        `${member.persona}\n\n${DECISION_PROTOCOL}`,
        roster,
        readProjectClaudeMd(this.cwd) ?? undefined,
        // Prime a fresh session with the team's persistent memory (.quorum):
        // recorded decisions + the live board — restarts don't lobotomize.
        teamMemoryDigest(this.store.decisions, this.tasks.list()),
      ),
      mcpServers: { quorum: server },
      allowedTools: QUORUM_TOOL_NAMES,
      canUseTool: this.broker.callbackFor(name, () => this.settings.get(name)!.permissionMode),
    });
    const pushState = () =>
      this.emit({ type: 'agentState', name, state: session.state, usage: session.usage });
    session.on('init', pushState);
    session.on('busy', pushState);
    session.on('idle', pushState);
    session.on('offline', pushState);
    session.on('activity', (activity: string) => this.emit({ type: 'agentActivity', name, activity }));
    this.sessions.set(name, session);
    this.bus.register(session);
  }

  snapshot(): { agents: AgentView[]; messages: BusMessage[]; decisions: DecisionStore['decisions']; layout: LayoutMap; project: { name: string; dir: string } } {
    return {
      agents: this.roster(),
      messages: this.bus.log,
      decisions: this.store.decisions,
      layout: this.layout,
      project: { name: this.team.project, dir: this.cwd },
    };
  }

  /**
   * Persist the live team (composition + per-agent model/permission) to the
   * project's state dir, so reopening the project restores the same team.
   */
  private persistTeam(): void {
    for (const m of this.team.members) {
      const st = this.settings.get(m.name);
      if (!st) continue;
      m.model = st.model;
      m.permissionMode = st.permissionMode;
    }
    saveTeam(join(this.stateDir, 'team.json'), this.team);
  }

  roster(): AgentView[] {
    return this.bus.roster.map((entry) => {
      const s = this.sessions.get(entry.name);
      const st = this.settings.get(entry.name)!;
      return {
        name: entry.name,
        desc: entry.desc,
        lead: !!entry.lead,
        state: s?.state ?? 'offline',
        sessionId: s?.sessionId ?? null,
        model: st.model,
        permissionMode: st.permissionMode,
        usage: s?.usage ?? { in: 0, out: 0, turns: 0 },
      };
    });
  }

  clearDecisions(): void {
    this.store.clear();
    this.emit({ type: 'decisionsCleared' });
  }

  /** Remove an agent from the team: close its session, drop it everywhere. */
  async removeAgent(name: string): Promise<void> {
    const s = this.sessions.get(name);
    if (s) await s.close().catch(() => {});
    this.sessions.delete(name);
    this.settings.delete(name);
    this.team.members = this.team.members.filter((m) => m.name !== name);
    this.bus.removeRosterEntry(name);
    if (this.layout[name]) {
      delete this.layout[name];
      this.saveLayout(this.layout);
    }
    this.persistTeam();
    this.emit({ type: 'roster', agents: this.roster() });
  }

  /** Set the lead (or clear it with null); exactly one lead at a time. */
  setLead(name: string | null): void {
    this.bus.setLead(name);
    for (const m of this.team.members) m.lead = name !== null && m.name === name;
    this.persistTeam();
    this.emit({ type: 'roster', agents: this.roster() });
  }

  /**
   * Change an agent's model and/or permission mode. Permission mode takes
   * effect immediately (the canUseTool callback reads it live). A model change
   * requires a fresh session, so we close the old one and resume it with the
   * new model — conversation history is preserved via --resume.
   */
  async updateAgent(name: string, model?: ModelName, permissionMode?: PermissionMode): Promise<void> {
    const st = this.settings.get(name);
    if (!st) return;
    const modelChanged = model !== undefined && model !== st.model;
    if (permissionMode !== undefined) st.permissionMode = permissionMode;
    if (model !== undefined) st.model = model;

    // Only restart a real running session. In no-sessions mode we just record
    // the new model so it applies whenever sessions do start.
    if (modelChanged && this.started) {
      const old = this.sessions.get(name);
      const resume = old?.sessionId ?? undefined;
      if (old) await old.close().catch(() => {});
      await this.spawnOne(name, resume);
    }
    this.persistTeam();
    const view = this.roster().find((a) => a.name === name);
    if (view) this.emit({ type: 'agentUpdated', agent: view });
  }

  /**
   * Add a catalog agent (.claude/agents/<file>.md) to the live team: read its
   * definition, register it on the roster + settings, and spawn its session.
   * Its role/rules come from its own .md body (per the design decision).
   */
  async addAgentFromCatalog(file: string): Promise<string> {
    const path = join(this.agentsDir, file);
    const raw = readFileSync(path, 'utf8');
    const fmEnd = raw.indexOf('\n---', 3);
    const front = raw.startsWith('---') && fmEnd !== -1 ? raw.slice(3, fmEnd) : '';
    const body = fmEnd !== -1 ? raw.slice(fmEnd + 4).trim() : raw.trim();
    const nameM = front.match(/^name:\s*"?(.+?)"?\s*$/m);
    const modelM = front.match(/^model:\s*(\S+)\s*$/m);
    const descM = front.match(/^description:\s*"?(.+?)"?\s*$/m);
    const name = (nameM?.[1] ?? file.replace(/\.md$/, '')).trim();
    if (this.settings.has(name)) return name; // already on the team

    // Speed default: catalog files often pin heavy models (opus) — every add
    // starts on haiku; upgrade per-agent via the inspector when depth matters.
    void modelM;
    const model: ModelName = 'haiku';
    const desc = (descM?.[1] ?? '').trim().slice(0, 120);
    // The bus is the authority on team size — refuse past MAX_AGENTS.
    if (!this.bus.addRosterEntry({ name, desc, lead: false })) {
      throw new Error(`Team is full — max ${MAX_AGENTS} agents. Remove one before adding.`);
    }
    this.team.members.push({ name, desc, persona: body, model, lead: false, permissionMode: 'write' });
    this.settings.set(name, { model, permissionMode: 'write' });
    this.persistTeam();

    if (this.started) await this.spawnOne(name);
    this.emit({ type: 'roster', agents: this.roster() });
    return name;
  }

  getLayout(): LayoutMap {
    return this.layout;
  }

  saveLayout(layout: LayoutMap): void {
    this.layout = layout;
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(join(this.stateDir, 'layout.json'), JSON.stringify(layout));
  }

  clearLayout(): void {
    this.layout = {};
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(join(this.stateDir, 'layout.json'), '{}');
  }

  sendUserInput(text: string, selected: string[] = [], via: 'bridge' | 'composer' = 'composer'): number {
    const routed = this.bus.routeUserInput(text, selected);
    for (const m of routed) this.bus.deliver({ ...m, via });
    return routed.length;
  }

  resolvePermission(id: string, behavior: 'allow' | 'deny'): void {
    this.broker.resolve(id, behavior);
  }

  /**
   * User interrupt (ESC): abort every busy session's in-flight turn and
   * cancel its reply debt so the silent-turn nudge doesn't re-engage it.
   * Queued messages stay queued — interrupt stops work, it doesn't drop mail.
   */
  async interruptBusy(): Promise<string[]> {
    const interrupted: string[] = [];
    for (const [name, s] of this.sessions) {
      if (s.state !== 'busy') continue;
      interrupted.push(name);
      this.bus.cancelReplyDebt(name);
      await s.interrupt();
    }
    return interrupted;
  }

  async shutdown(): Promise<void> {
    this.broker.denyAll();
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()));
  }
}

export type { PermissionRequest };
