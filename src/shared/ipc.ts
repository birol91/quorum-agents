// The typed contract between renderer and main. Pattern lifted from AgentBoard:
// invoke() returns an envelope; a separate one-way event channel streams live
// state to the renderer. The app never generates content — it transports and
// visualizes (brief §3.3).
import type { Decision } from '../decisions.ts';
import type { BusMessage } from '../types.ts';
import type { CatalogAgent } from '../main/agentCatalog.ts';

export type { CatalogAgent };

/** Per-agent tool policy: what the agent may do without/with the user. */
export type PermissionMode = 'read' | 'write' | 'both';
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ModelName = (typeof MODELS)[number];

/** Reasoning effort passed to the Agent SDK; 'high' is the SDK default. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORTS)[number];

/** UI label → value the `claude` CLI accepts (alias, or full id where no alias). */
export const MODEL_CLI_ID: Record<ModelName, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'claude-fable-5',
};

export interface AgentView {
  name: string;
  desc: string;
  lead: boolean;
  state: 'idle' | 'busy' | 'offline';
  sessionId: string | null;
  model: ModelName;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  usage: { in: number; out: number; turns: number };
}

/** A pending permission request surfaced from a session's canUseTool callback. */
export interface PermissionRequest {
  id: string;
  agent: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** One-way events pushed from main to renderer (channel "quorum:event"). */
export type QuorumEvent =
  | { type: 'roster'; agents: AgentView[] }
  | { type: 'agentState'; name: string; state: AgentView['state']; usage: AgentView['usage'] }
  | { type: 'agentActivity'; name: string; activity: string }
  | { type: 'agentUpdated'; agent: AgentView }
  | { type: 'message'; message: BusMessage }
  | { type: 'permissionRequest'; request: PermissionRequest }
  | { type: 'permissionResolved'; id: string }
  | { type: 'decision'; decision: Decision }
  | { type: 'decisionsCleared' }
  // The external Team Lead's activity level: 'driving' = bridge traffic
  // (first-party), 'working' = live session-hook claims for this project
  // (secondary telemetry, cosmetic only), 'off' = neither.
  | { type: 'leadState'; level: 'off' | 'working' | 'driving' }
  /**
   * Replies waiting for a lead that has not called replies() yet. MCP gives
   * a server no way to wake its client, so the count is the honest signal:
   * the app cannot nudge the lead, but it can show you what is unread.
   */
  | { type: 'pendingReplies'; count: number }
  /** An agent overheard traffic it was not addressed in (no turn spent). */
  | { type: 'agentOverheard'; name: string }
  /** Listening to the user's own lead conversation: on/off + how much landed. */
  | { type: 'listening'; on: boolean; heard: number };

export type LayoutMap = Record<string, { x: number; y: number }>;

export interface IpcContract {
  'app:health': { input: void; output: { ok: true; version: string } };
  'quorum:snapshot': {
    input: void;
    output: {
      agents: AgentView[];
      messages: BusMessage[];
      decisions: Decision[];
      layout: LayoutMap;
      project: { name: string; dir: string };
    };
  };
  // Native folder picker; switches the app to that project (state under
  // <project>/.quorum) and reloads the renderer. opened=false when canceled.
  'quorum:openProject': { input: void; output: { ok: true; opened: boolean } };
  // Welcome screen: recent projects (existing dirs, most recent first).
  'quorum:recentProjects': { input: void; output: { projects: { dir: string; name: string }[] } };
  // Welcome screen: open a known project dir directly (no dialog).
  'quorum:openProjectPath': { input: { dir: string }; output: { ok: true; opened: boolean } };
  // ESC: abort every busy session's in-flight turn (SDK interrupt()).
  'quorum:interrupt': { input: void; output: { ok: true; interrupted: string[] } };
  // Stop ONE agent's in-flight turn, leaving the rest of the team running.
  'quorum:interruptAgent': { input: { name: string }; output: { ok: true; interrupted: boolean } };
  // Restart an agent with a clean slate: no --resume, so it forgets the
  // conversation so far. The cure for an agent that keeps returning to a
  // thread the user has already abandoned.
  'quorum:resetAgent': { input: { name: string }; output: { ok: true } };
  // Listen mode: relay the user's own Claude Code conversation into the room.
  // Off by default — it is the one source that is bulky and not always relevant.
  'quorum:setListening': { input: { on: boolean }; output: { ok: true; on: boolean } };
  'quorum:saveLayout': { input: { layout: LayoutMap }; output: { ok: true } };
  // Reset saved block positions; blocks fall back to the default row.
  'quorum:clearLayout': { input: void; output: { ok: true } };
  // User input from the meeting room; routed by the bus (@name / @everyone /
  // selected group / lead). `selected` = canvas multi-selection, if any.
  'quorum:sendUserInput': { input: { text: string; selected?: string[] }; output: { ok: true; routed: number } };
  'quorum:resolvePermission': {
    input: { id: string; behavior: 'allow' | 'deny' };
    output: { ok: true };
  };
  // Permanently clear the decisions store (jsonl + md) and the panel.
  'quorum:clearDecisions': { input: void; output: { ok: true } };
  // Change an agent's model and/or permission mode; restarts its session
  // (via --resume so history is preserved).
  'quorum:updateAgent': {
    input: { name: string; model?: ModelName; permissionMode?: PermissionMode; effort?: EffortLevel };
    output: { ok: true };
  };
  // Marketplace: the full catalog of installed agent definitions (metadata only).
  'marketplace:list': { input: void; output: { agents: CatalogAgent[] } };
  // Add a catalog agent to the live team (spawns a session for it).
  'quorum:addAgent': { input: { file: string }; output: { ok: true; name: string } };
  // Remove an agent from the team: close its session, drop it from roster + layout.
  'quorum:removeAgent': { input: { name: string }; output: { ok: true } };
  // Set or clear the lead. name=null clears the lead entirely.
  'quorum:setLead': { input: { name: string | null }; output: { ok: true } };
}

export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = IpcContract[C]['input'];
export type IpcOutput<C extends IpcChannel> = IpcContract[C]['output'];

export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

/**
 * Display name for the shared 'user' channel. Composer traffic is YOU in
 * both directions: it never crosses the bridge, so neither the question nor
 * the reply ever reached the Team Lead — labelling it otherwise tells the
 * user something untrue about where their message went. Bridge traffic
 * really is the lead's own Claude Code session.
 */
export function userChannelName(via: 'bridge' | 'composer' | undefined): string {
  return via === 'composer' ? 'you' : 'Team Lead';
}
