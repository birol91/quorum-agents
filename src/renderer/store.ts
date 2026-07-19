import { useSyncExternalStore } from 'react';
import type { AgentView, LayoutMap, PermissionRequest, QuorumEvent } from '../shared/ipc.ts';
import type { Decision } from '../decisions.ts';
import type { BusMessage } from '../types.ts';

export interface Activity {
  text: string; // what the agent is doing right now
  since: number; // ms timestamp when it went busy
}

/** One line in an agent's terminal window (received / sent / doing). */
export interface TermEntry {
  at: number;
  kind: 'in' | 'out' | 'act' | 'state';
  label: string; // "from Team Lead", "to data-engineer", tool/state text
  text: string; // message body ('' for activity lines)
}

const TERM_CAP = 300;

function pushTerm(terms: Record<string, TermEntry[]>, name: string, e: TermEntry): Record<string, TermEntry[]> {
  const list = [...(terms[name] ?? []), e];
  return { ...terms, [name]: list.length > TERM_CAP ? list.slice(-TERM_CAP) : list };
}

/** Display name for the shared user channel (Team Lead / you). */
const chanName = (m: BusMessage, side: 'from' | 'to'): string => {
  const raw = side === 'from' ? m.from : m.to;
  if (raw !== 'user') return raw;
  return side === 'from' && m.via === 'composer' ? 'you' : 'Team Lead';
};

/** Fold a bus message into the sender's and recipient's terminal feeds. */
function termsWithMessage(terms: Record<string, TermEntry[]>, m: BusMessage, agents: AgentView[]): Record<string, TermEntry[]> {
  const at = m.at ?? Date.now();
  const isAgent = (n: string): boolean => agents.some((a) => a.name === n);
  let next = terms;
  if (isAgent(m.to)) next = pushTerm(next, m.to, { at, kind: 'in', label: `from ${chanName(m, 'from')}`, text: m.content });
  if (isAgent(m.from)) next = pushTerm(next, m.from, { at, kind: 'out', label: `to ${chanName(m, 'to')}`, text: m.content });
  return next;
}

export interface State {
  agents: AgentView[];
  messages: BusMessage[];
  decisions: Decision[];
  permissions: PermissionRequest[];
  layout: LayoutMap;
  activity: Record<string, Activity>; // by agent name; only while busy
  project: { name: string; dir: string } | null; // the open project (null = scratch)
  leadLevel: 'off' | 'working' | 'driving'; // external Team Lead activity
  terminals: Record<string, TermEntry[]>; // per-agent live console feed
}

let state: State = { agents: [], messages: [], decisions: [], permissions: [], layout: {}, activity: {}, project: null, leadLevel: 'off', terminals: {} };
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const l of listeners) l();
}

export function apply(event: QuorumEvent): void {
  switch (event.type) {
    case 'roster':
      set({ ...state, agents: event.agents });
      break;
    case 'agentState': {
      const prev = state.agents.find((a) => a.name === event.name);
      const activity = { ...state.activity };
      if (event.state === 'busy') {
        // Start (or keep) the busy clock; label defaults until an activity lands.
        if (prev?.state !== 'busy') activity[event.name] = { text: 'working…', since: Date.now() };
      } else {
        delete activity[event.name]; // idle/offline → clear the indicator
      }
      set({
        ...state,
        activity,
        agents: state.agents.map((a) =>
          a.name === event.name ? { ...a, state: event.state, usage: event.usage } : a,
        ),
      });
      break;
    }
    case 'agentActivity': {
      const cur = state.activity[event.name];
      set({
        ...state,
        activity: { ...state.activity, [event.name]: { text: event.activity, since: cur?.since ?? Date.now() } },
        terminals: pushTerm(state.terminals, event.name, { at: Date.now(), kind: 'act', label: event.activity, text: '' }),
      });
      break;
    }
    case 'message':
      set({
        ...state,
        messages: [...state.messages, event.message],
        terminals: termsWithMessage(state.terminals, event.message, state.agents),
      });
      break;
    case 'permissionRequest':
      set({ ...state, permissions: [...state.permissions, event.request] });
      break;
    case 'permissionResolved':
      set({ ...state, permissions: state.permissions.filter((p) => p.id !== event.id) });
      break;
    case 'decision':
      set({ ...state, decisions: [...state.decisions, event.decision] });
      break;
    case 'decisionsCleared':
      set({ ...state, decisions: [] });
      break;
    case 'leadState':
      set({ ...state, leadLevel: event.level });
      break;
    case 'agentUpdated':
      set({
        ...state,
        agents: state.agents.map((a) => (a.name === event.agent.name ? event.agent : a)),
      });
      break;
  }
}

export function hydrate(snapshot: { agents: AgentView[]; messages: BusMessage[]; decisions: Decision[]; layout: LayoutMap; project?: { name: string; dir: string } }): void {
  // Rebuild terminal feeds from the message history (activity is live-only).
  let terminals: Record<string, TermEntry[]> = {};
  for (const m of snapshot.messages) terminals = termsWithMessage(terminals, m, snapshot.agents);
  set({ ...state, ...snapshot, project: snapshot.project ?? null, terminals });
}

/** Clear one agent's terminal feed (the window's "clear" button). */
export function clearTerminal(name: string): void {
  set({ ...state, terminals: { ...state.terminals, [name]: [] } });
}

// Local layout update (drag). Persisted to disk via IPC by the caller.
export function setLayout(layout: LayoutMap): void {
  set({ ...state, layout });
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

// Imperative read for event handlers (drag) that need the latest layout.
export function getState(): State {
  return state;
}
