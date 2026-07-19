export interface RosterEntry {
  name: string;
  desc: string;
  /** Unmentioned user messages route to the lead (brief §14). */
  lead?: boolean;
}

export interface BusMessage {
  from: string;
  to: string;
  content: string;
  at?: number;
  /**
   * Display-only origin of a user-channel message: the external lead over
   * the bridge, or the human typing in the composer. Routing ignores this —
   * the channel identity stays 'user'.
   */
  via?: 'bridge' | 'composer';
}

export type SessionState = 'idle' | 'busy' | 'offline';

/**
 * What the bus needs from a session. `write` starts a turn and MUST set state
 * to 'busy' synchronously; 'idle' fires after each completed turn, 'offline'
 * when the underlying process is gone. State is real process knowledge —
 * never inference (brief §3.6).
 */
export interface SessionLike {
  readonly name: string;
  readonly state: SessionState;
  write(text: string): void;
  on(event: 'idle' | 'offline', cb: () => void): unknown;
}
