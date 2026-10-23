import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bus, MAX_AGENTS } from '../bus.ts';
import { SdkSession } from '../session.ts';
import { buildSystemPrompt, DECISION_PROTOCOL, teamMemoryDigest } from '../protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../tools.ts';
import { DecisionStore } from '../decisions.ts';
import { TaskBoard } from '../tasks.ts';
import type { AgentView, EffortLevel, LayoutMap, ModelName, PermissionMode, PermissionRequest, QuorumEvent } from '../shared/ipc.ts';
import { MODELS, MODEL_CLI_ID, EFFORTS } from '../shared/ipc.ts';
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
  // Per-agent settings, mutable via updateAgent (model + effort + permission mode).
  private readonly settings = new Map<string, { model: ModelName; effort: EffortLevel; permissionMode: PermissionMode }>();
  private readonly broker: PermissionBroker;
  private readonly emit: (e: QuorumEvent) => void;

  private readonly team: Team;
  private readonly cwd: string;
  private readonly stateDir: string;
  private readonly agentsDir: string;
  private layout: LayoutMap = {};

  constructor(
    team: Team,
    cwd: string,
    decisionsDir: string,
    emit: (e: QuorumEvent) => void,
    agentsDir?: string,
    private readonly onSilentTurn?: (name: string) => void,
  ) {
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
      const model = (MODELS as readonly string[]).includes(m.model) ? (m.model as ModelName) : 'sonnet';
      const effort = (EFFORTS as readonly string[]).includes(m.effort) ? (m.effort as EffortLevel) : 'medium';
      this.settings.set(m.name, { model, effort, permissionMode: m.permissionMode ?? 'both' });
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
      // A message the bus refuses to deliver (reply budget spent, unknown
      // target) used to vanish: onDrop was never wired, so `?.` swallowed it
      // and neither the user nor the lead ever learned the reply was lost.
      onDrop: (m, reason) =>
        console.error(`[bus] DROPPED ${m.from} -> ${m.to} (${reason}): ${m.content.slice(0, 200).replace(/\n/g, ' ')}`),
      // A turn that produced no message: tell the UI and the waiting lead, so
      // neither keeps waiting on an answer that was never handed to the bus.
      // Someone else's traffic landed in this agent's transcript. It cost no
      // turn, so the UI marks it with a brief dim pulse rather than the busy
      // glow — listening is not working.
      onOverheard: (name) => this.emit({ type: 'agentOverheard', name }),
      onSilentTurn: (name) => {
        emit({ type: 'agentActivity', name, activity: 'silent turn — no message sent' });
        this.onSilentTurn?.(name);
      },
      trace: (l) => console.log(l),
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
      effort: settings.effort,
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
      m.effort = st.effort;
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
        effort: st.effort,
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
    if (s) {
      this.bus.unregister(s);
      await s.close().catch(() => {});
    }
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
   * Change an agent's model, effort and/or permission mode. Permission mode
   * takes effect immediately (the canUseTool callback reads it live). Model
   * and effort are query-start options, so changing either requires a fresh
   * session — we close the old one and resume it, history preserved via
   * --resume.
   */
  async updateAgent(name: string, model?: ModelName, permissionMode?: PermissionMode, effort?: EffortLevel): Promise<void> {
    const st = this.settings.get(name);
    if (!st) return;
    const modelChanged = model !== undefined && model !== st.model;
    const effortChanged = effort !== undefined && effort !== st.effort;
    if (permissionMode !== undefined) st.permissionMode = permissionMode;
    if (model !== undefined) st.model = model;
    if (effort !== undefined) st.effort = effort;

    // Only restart a real running session. In no-sessions mode we just record
    // the new settings so they apply whenever sessions do start.
    if ((modelChanged || effortChanged) && this.started) {
      const old = this.sessions.get(name);
      const resume = old?.sessionId ?? undefined;
      if (old) {
        // Retire it at the bus FIRST: its final turn ends while close() is
        // awaited, and a still-registered session would drain the queue into
        // the process on its way out (message lost, close() left waiting).
        this.bus.unregister(old);
        await old.close().catch(() => {});
      }
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

    // Catalog files often pin opus; every add starts on the team default
    // instead. Sonnet is the floor because haiku's silent turns (a turn that
    // ends without send_message, so nothing is delivered) cost more than its
    // faster turns save. Upgrade per-agent via the inspector when depth matters.
    void modelM;
    const model: ModelName = 'sonnet';
    const desc = (descM?.[1] ?? '').trim().slice(0, 120);
    // The bus is the authority on team size — refuse past MAX_AGENTS.
    if (!this.bus.addRosterEntry({ name, desc, lead: false })) {
      throw new Error(`Team is full — max ${MAX_AGENTS} agents. Remove one before adding.`);
    }
    this.team.members.push({ name, desc, persona: body, model, effort: 'medium', lead: false, permissionMode: 'both' });
    this.settings.set(name, { model, effort: 'medium', permissionMode: 'both' });
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

  /**
   * Relay the user's own conversation with the lead into the room. Costs no
   * turns (shouldQuery:false); returns how many agents heard it.
   */
  relayToRoom(text: string, label?: string): number {
    return this.bus.overhearExternal(text, label);
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
  /**
   * Stop ONE agent mid-turn and leave the rest of the team working. Same
   * contract as the team-wide interrupt: the turn is aborted, the reply debt
   * is cancelled so the silent-turn nudge does not re-engage it, and queued
   * mail stays queued.
   */
  async interruptAgent(name: string): Promise<boolean> {
    const s = this.sessions.get(name);
    if (!s || s.state !== 'busy') return false;
    this.bus.cancelReplyDebt(name);
    await s.interrupt();
    return true;
  }

  /**
   * Restart an agent with no history: close the session and spawn a fresh one
   * WITHOUT --resume. Its queue is dropped too — pending mail belongs to the
   * conversation being abandoned, and delivering it would walk the new
   * session straight back into the thread the user just cleared.
   */
  async resetAgent(name: string): Promise<void> {
    const old = this.sessions.get(name);
    if (old) {
      this.bus.unregister(old);
      await old.close().catch(() => {});
    }
    this.bus.clearQueue(name);
    await this.spawnOne(name);
    this.emit({ type: 'roster', agents: this.roster() });
  }

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
