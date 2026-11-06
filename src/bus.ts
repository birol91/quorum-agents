import type { BusMessage, RosterEntry, SessionLike } from './types.ts';

export const BUS_NOTE =
  '[bus note]: This exchange has exceeded the turn budget without a decision. ' +
  'Converge now — state KABUL and settle it, or escalate to the user via send_message(\"user\", ...).';

export const SILENT_TURN_NOTE =
  '[bus note]: Your last turn ended without calling send_message, so nobody received a reply. ' +
  'If you have an answer, send it now (to the sender, or to "user"). If you are intentionally done, reply to "user" saying so.';

export const REPLY_BUDGET_NOTE =
  '[bus note]: NOT DELIVERED — this task\'s user-reply budget is spent (or you were not an addressee of the current task). ' +
  'The user already has the team\'s replies. Do not resend or acknowledge; if something important is missing, ' +
  'tell a teammate who still owes the user a reply. Do not reply to this note.';

/** Hard cap on team size, enforced at the bus (mechanism, not prompt). */
export const MAX_AGENTS = 5;

/**
 * Delivery policy — who may speak to the user — follows how the user addressed
 * the team (the 3 modes of brief §14): plain → lead synthesizes (one voice),
 * @name / single selection → that agent speaks for itself, group task → each
 * participant sends exactly one reply. Set by routeUserInput on every input.
 */
export type DeliveryMode = 'lead' | 'direct' | 'group';

export interface BusOptions {
  roster: RosterEntry[];
  /** Consecutive same-pair messages before a note is injected (default 8). */
  turnBudget?: number;
  onUserMessage?: (m: BusMessage) => void;
  onNote?: (pairKey: string, m: BusMessage) => void;
  onDrop?: (m: BusMessage, reason: string) => void;
  /**
   * An agent finished a turn without sending anything, so its work never left
   * the session. Surfaced (not just traced) because the waiting side otherwise
   * sees only silence: `replies()` returns empty with nobody busy, and the user
   * keeps waiting for an answer that was never handed to the bus.
   */
  onSilentTurn?: (name: string) => void;
  /**
   * An agent overheard traffic it was not addressed in. Fired per recipient
   * so the UI can show who is listening — the bus knows this first-hand (it
   * made the delivery), which is what keeps the signal honest.
   */
  onOverheard?: (name: string, from: string, to: string) => void;
  /**
   * Live "what is this agent doing" label, emitted from DELIVERY OUTCOMES —
   * the bus knows the truth first-hand (who really received what, what was
   * rerouted or bounced), unlike stream-derived tool-call intent.
   */
  onAgentActivity?: (name: string, activity: string) => void;
  trace?: (line: string) => void;
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|');

/**
 * Message bus (brief §4.2): routing, per-target FIFO queueing while busy or
 * offline, turn budget for agent pairs, user-input routing rules (brief §14).
 * Delivery guarantees live HERE, in mechanism — never in prompts (brief §3.4).
 */
export class Bus {
  readonly log: BusMessage[] = [];
  roster: RosterEntry[];
  private readonly opts: BusOptions;
  private readonly sessions = new Map<string, SessionLike>();
  private readonly queues = new Map<string, { text: string; expectReply: boolean }[]>();
  private readonly pairChain = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();
  // Silent-turn tracking: an agent we delivered to owes a reply until it sends
  // any message; if a turn ends still owing, nudge it once (not repeatedly).
  private readonly awaitingReply = new Set<string>();
  private readonly nudged = new Set<string>();
  // Delivery policy for the CURRENT user input (replaced on every routeUserInput).
  private deliveryMode: DeliveryMode = 'lead';
  private readonly userReplyGrants = new Map<string, number>();
  // Which channel asked the current question. A reply to the user is shown
  // with this origin, because composer traffic never passes through the Team
  // Lead — labelling such a reply "-> Team Lead" misstates where it went.
  private userChannel: 'bridge' | 'composer' = 'bridge';

  constructor(opts: BusOptions) {
    if (opts.roster.length > MAX_AGENTS) {
      throw new Error(`team has ${opts.roster.length} agents; MAX_AGENTS is ${MAX_AGENTS}`);
    }
    this.opts = opts;
    this.roster = opts.roster;
  }

  /**
   * Add an agent to the roster at runtime (marketplace "add to team").
   * Returns false when the team is already at MAX_AGENTS.
   */
  addRosterEntry(entry: RosterEntry): boolean {
    if (this.roster.some((r) => r.name === entry.name)) return true;
    if (this.roster.length >= MAX_AGENTS) return false;
    this.roster.push(entry);
    return true;
  }

  /** Remove an agent from routing (also drops any pending queue for it). */
  removeRosterEntry(name: string): void {
    this.roster = this.roster.filter((r) => r.name !== name);
    this.sessions.delete(name);
    this.queues.delete(name);
    this.awaitingReply.delete(name);
    // Both halves of the silent-turn bookkeeping go, or a fresh agent added
    // under the same name inherits the old one's spent nudge.
    this.nudged.delete(name);
  }

  /**
   * Drop an agent's pending mail without removing it from the team. Used when
   * an agent is reset: the queued messages belong to the conversation being
   * abandoned, and delivering them would walk the fresh session right back
   * into it.
   */
  clearQueue(name: string): void {
    this.queues.set(name, []);
    this.awaitingReply.delete(name);
    this.nudged.delete(name);
  }

  /** Set the lead (name) or clear it (null); exactly one lead at a time. */
  setLead(name: string | null): void {
    for (const r of this.roster) r.lead = name !== null && r.name === name;
  }

  /**
   * Retire a session ahead of its replacement (updateAgent's close+respawn).
   * Its queue is KEPT — pending mail belongs to the agent, not the process —
   * but nothing is written to it again, so a turn ending during the handover
   * cannot drain the queue into the session on its way out.
   */
  unregister(session: SessionLike): void {
    if (this.sessions.get(session.name) === session) this.sessions.delete(session.name);
  }

  register(session: SessionLike): void {
    this.sessions.set(session.name, session);
    if (!this.queues.has(session.name)) this.queues.set(session.name, []);
    session.on('idle', () => {
      // A respawn (updateAgent: model/effort change) replaces the session for
      // this name. The OLD session keeps its listener, and its final turn ends
      // while close() is awaited — before the new session registers. Acting on
      // it would flush the queue into the session being retired: the message is
      // lost to the new one, and write() makes the old session busy again, so
      // close() keeps waiting. A superseded session drives nothing.
      if (this.sessions.get(session.name) !== session) return;
      // Silent turn: the agent finished a turn still owing a reply and its queue
      // is empty (nothing more coming). Nudge it once.
      const queue = this.queues.get(session.name);
      if (this.awaitingReply.has(session.name) && (!queue || queue.length === 0) && !this.nudged.has(session.name)) {
        this.nudged.add(session.name);
        this.awaitingReply.delete(session.name);
        this.opts.trace?.(`[bus] silent turn — nudging ${session.name}`);
        this.opts.onSilentTurn?.(session.name);
        // Deliver as a normal turn so state tracking stays consistent.
        this.deliverText(session.name, SILENT_TURN_NOTE);
        return;
      }
      this.flush(session.name);
      this.notifyIfIdle();
    });
    session.on('offline', () => this.opts.trace?.(`[bus] ${session.name} offline; queue retained`));
    // A replacement session inherits the queue its predecessor left behind
    // (respawn, or an agent that came back). Nothing else would deliver it:
    // flush only ever runs off an 'idle' event, and a fresh session emits none
    // until it has taken a turn.
    this.flush(session.name);
  }

  deliver(m: BusMessage): void {
    const entry: BusMessage = { ...m, at: Date.now() };
    if (m.from === 'user' && m.via) this.userChannel = m.via;
    this.log.push(entry);
    this.opts.trace?.(`[bus] ${m.from} -> ${m.to}: ${m.content.slice(0, 160).replace(/\n/g, ' ')}`);

    // The sender just spoke, so it no longer owes a reply — clear its debt.
    if (this.sessions.has(m.from)) {
      this.awaitingReply.delete(m.from);
      this.nudged.delete(m.from);
    }

    // Sender's live label reflects the OUTCOME, decided below.
    const senderIsAgent = this.sessions.has(m.from);
    const label = (activity: string): void => {
      if (senderIsAgent) this.opts.onAgentActivity?.(m.from, activity);
    };

    if (m.to === 'user') {
      // Who may speak to the user follows the current delivery mode:
      // - lead: only the lead — a teammate's user message is rerouted to the
      //   lead, who decides whether/how to relay it (one synthesized voice).
      // - direct: the user picked their interlocutor; that agent owns the
      //   user channel until the next user input. Anyone else bounces.
      // - group: every participant gets exactly ONE user reply (their own
      //   specialty slice); past-budget or non-participant messages bounce
      //   back to the sender instead of leaking through the lead.
      if (this.deliveryMode === 'lead') {
        const lead = this.roster.find((r) => r.lead)?.name;
        if (lead && m.from !== lead && m.from !== 'user' && this.sessions.has(lead)) {
          this.opts.trace?.(`[bus] lead isolation: ${m.from}->user rerouted to lead ${lead}`);
          label('reporting to the lead…');
          this.deliverText(
            lead,
            `[from ${m.from} — was addressed to the user, but you are the lead]: ${m.content}\n\n[bus note]: You are the single point of contact with the user. Relay/synthesize this to the user yourself if it's worth surfacing.`,
          );
          return;
        }
      } else if (m.from !== 'user') {
        const grant = this.userReplyGrants.get(m.from) ?? 0;
        if (grant <= 0) {
          this.opts.trace?.(`[bus] reply budget: blocked ${m.from}->user (${this.deliveryMode} mode)`);
          this.opts.onDrop?.(entry, 'user-reply-budget');
          label('reply held — budget spent');
          this.deliverText(m.from, REPLY_BUDGET_NOTE, false);
          return;
        }
        if (Number.isFinite(grant)) this.userReplyGrants.set(m.from, grant - 1);
      }
      // The user is now in the loop — the pair chain is broken.
      label(this.userChannel === 'composer' ? 'replying to you…' : 'replying to the user…');
      this.resetChainsInvolving(m.from);
      this.opts.onUserMessage?.({ ...entry, via: entry.via ?? this.userChannel });
      return;
    }

    const session = this.sessions.get(m.to);
    if (!session) {
      this.opts.onDrop?.(entry, 'unknown-target');
      this.opts.trace?.(`[bus] DROP: no such agent "${m.to}"`);
      label(`message dropped — no agent "${m.to}"`);
      return;
    }
    label(`messaging ${m.to}…`);

    let text = `[from ${m.from}]: ${m.content}`;
    if (m.from === 'user') {
      this.resetChainsInvolving(m.to);
    } else {
      const key = pairKey(m.from, m.to);
      const n = (this.pairChain.get(key) ?? 0) + 1;
      this.pairChain.set(key, n);
      const budget = this.opts.turnBudget ?? 8;
      if (n >= budget && n % budget === 0) {
        text += `\n\n${BUS_NOTE}`;
        this.opts.onNote?.(key, entry);
        this.opts.trace?.(`[bus] turn-budget note injected for ${key} (chain=${n})`);
      }
    }

    // A message from the user jumps the queue: it is a correction or a new
    // direction, and reading it after the chatter it supersedes is worse
    // than useless.
    this.deliverText(m.to, text, true, m.from === 'user');
    this.broadcast(m);
  }

  /**
   * The meeting room: everyone not addressed in a message still hears it.
   * Delivered with shouldQuery:false, so a bystander's context gains the
   * line but no turn starts — hearing the room is free, answering is not.
   * This is what lets an agent say "data-engineer already has that task"
   * instead of silently duplicating work it never knew about.
   */
  private broadcast(m: BusMessage): void {
    for (const [name, session] of this.sessions) {
      if (name === m.from || name === m.to) continue;
      if (!session.overhear) continue;
      session.overhear(`[overheard — ${m.from} → ${m.to}]: ${m.content}`);
      this.opts.onOverheard?.(name, m.from, m.to);
    }
  }

  /**
   * Let the team overhear something that did not come from the bus at all —
   * the user's own conversation with the lead, relayed in. Same contract:
   * no turn, just context.
   */
  overhearExternal(text: string, label = 'you → Team Lead'): number {
    let n = 0;
    for (const [name, session] of this.sessions) {
      if (!session.overhear) continue;
      session.overhear(`[overheard — ${label}]: ${text}`);
      this.opts.onOverheard?.(name, 'you', 'Team Lead');
      n++;
    }
    return n;
  }

  /**
   * Low-level delivery: mark the target as owing a reply, then write or queue.
   * `expectReply: false` is for infrastructure notices (e.g. a bounced user
   * reply) — staying silent after one must NOT trigger the silent-turn nudge.
   */
  private deliverText(to: string, text: string, expectReply = true, urgent = false): void {
    const session = this.sessions.get(to);
    if (!session) return;
    const queue = this.queues.get(to)!;
    if (session.state === 'idle' && queue.length === 0) {
      if (expectReply) this.awaitingReply.add(to);
      session.write(text);
    } else if (urgent) {
      // Cutting in: the agent is mid-turn and cannot be interrupted with new
      // input, but the user's correction should be the FIRST thing it reads
      // when the turn ends — not buried behind teammate chatter it is about
      // to be told is irrelevant.
      queue.unshift({ text, expectReply });
    } else {
      queue.push({ text, expectReply });
    }
  }

  /**
   * User-input routing (brief §14): @name -> that agent, @everyone -> all,
   * no mention -> lead. When `selected` (canvas multi-select) is non-empty and
   * there is no mention, the message goes to exactly those agents as a group
   * task — the user picked who should work on it.
   */
  routeUserInput(text: string, selected: string[] = []): BusMessage[] {
    const t = text.trim();
    if (!t) return [];
    const mention = t.match(/^@(\S+)\s+([\s\S]+)$/);
    if (t.startsWith('@') && !mention) return [];
    if (mention) {
      const [, name, content] = mention;
      if (name === 'everyone') return this.groupTask(content, [...this.sessions.keys()]);
      if (!this.sessions.has(name)) return [];
      this.setDeliveryPolicy('direct', [[name!, Infinity]]);
      return [{ from: 'user', to: name, content }];
    }
    const active = selected.filter((n) => this.sessions.has(n));
    if (active.length === 1) {
      this.setDeliveryPolicy('direct', [[active[0]!, Infinity]]);
      return [{ from: 'user', to: active[0]!, content: t }];
    }
    if (active.length > 1) return this.groupTask(t, active);
    // With a declared in-app lead (team.json lead flag — example team,
    // scripts) plain text keeps the classic [LEAD BRIEF] route. Without one
    // the lead lives OUTSIDE the app (Claude Code via the bridge): the
    // composer talks to AGENTS only, so unaddressed text goes to the whole
    // team as a group task.
    const lead = this.roster.find((r) => r.lead)?.name;
    if (!lead) {
      const all = [...this.sessions.keys()];
      return all.length > 0 ? this.groupTask(t, all) : [];
    }
    this.setDeliveryPolicy('lead', []);
    return [{ from: 'user', to: lead, content: this.leadBrief(t, lead) }];
  }

  /**
   * Update the user-channel policy. Grants ACCUMULATE across inputs — a new
   * dispatch must never revoke an earlier addressee's right to reply (the
   * lead routinely fires several targeted asks back-to-back; wiping grants
   * silently swallowed the first agent's answer). Group grants add up
   * (two tasks -> two owed replies); a direct address pins Infinity.
   */
  private setDeliveryPolicy(mode: DeliveryMode, grants: [string, number][]): void {
    this.deliveryMode = mode;
    for (const [name, n] of grants) {
      const cur = this.userReplyGrants.get(name) ?? 0;
      this.userReplyGrants.set(name, Number.isFinite(cur) && Number.isFinite(n) ? cur + n : Infinity);
    }
  }

  /**
   * Wrap a plain (unmentioned, unselected) user task for the lead with a light
   * coordination frame, so the lead's "should I split this?" reflex fires on
   * every task instead of being left to chance. It doesn't force a split — the
   * lead decides — but when the work spans specialties it names the teammates
   * available and reminds the lead to use the board and return one reply.
   */
  private leadBrief(content: string, lead: string): string {
    const mates = this.roster.filter((r) => r.name !== lead).map((r) => `${r.name} (${r.desc})`);
    if (mates.length === 0) return content;
    // The user asked for cross-consultation (TR + EN cues) → make it mandatory,
    // not optional. Otherwise agents (reasonably) skip it on cleanly-split work.
    // Substrings, not stems: `danış` also matched "danışman", and bare `birbir`
    // matched "birbirine bağla" (a wiring instruction, not a request to
    // consult). A false positive is expensive — mandatory
    // cross-consultation turns a 2-turn group task into ~6 (each agent must
    // trade drafts before answering). Match Turkish verb forms explicitly and
    // keep the English terms whole-word.
    const wantsConsult =
      /danış(ın|alım|arak|ıp|mak|ma)\b|kıyasla|karşılaştır|tartış(ın|alım|arak|ıp|mak|ma)\b|birbiriyle (danış|tartış|kıyasla|karşılaştır)|müzakere|\b(consult|compare|discuss|cross-check|debate|reconcile)\b/i.test(
        content,
      );
    const lines = [
      `[LEAD BRIEF] You are the lead. A user task follows. Decide: handle it yourself if it's simple,`,
      `or split it across your teammates if it spans their specialties. Your teammates:`,
      ...mates.map((m) => `- ${m}`),
      `If you split it: message each teammate the piece that fits their expertise (use add_task/claim_task`,
      `to avoid overlap), let them work and consult each other, then send ONE combined, high-quality reply to "user".`,
    ];
    if (wantsConsult) {
      lines.push(
        ``,
        `CROSS-CONSULTATION IS MANDATORY for this task (the user asked for it). Instruct each teammate:`,
        `before sending their final piece to you, they MUST send their draft findings to the OTHER teammate`,
        `and state in one line where the two pieces agree and where they conflict. Only then send you the`,
        `reconciled result. Do not accept a piece that skipped this cross-check.`,
      );
    }
    lines.push(``, `USER TASK: ${content}`);
    return lines.join('\n');
  }

  /**
   * Deliver a message to a set of agents as a coordinated group task. The
   * [TEAM TASK] envelope names the participants so they discuss/split among
   * exactly this group (the "you two, talk it over" case) rather than each
   * replying in isolation. Delivery: after coordinating, EACH participant
   * answers the user once, with its own specialty slice — enforced by the
   * per-participant reply budget, not by the prompt alone.
   */
  private groupTask(content: string, to: string[]): BusMessage[] {
    const roster = to.join(', ');
    const wrapped =
      `[TEAM TASK — participants: ${roster}] ${content}\n\n` +
      `[delivery]: Coordinate first — split by specialty, consult, converge on disagreements. ` +
      `Then EACH participant sends "user" exactly ONE reply covering only their own specialty's contribution; ` +
      `do not repeat a teammate's points, and send no closing chatter. The bus enforces one user reply per participant.`;
    this.setDeliveryPolicy('group', to.map((name) => [name, 1]));
    return to.map((name) => ({ from: 'user', to: name, content: wrapped }));
  }

  /**
   * Forget that an agent owes a reply (user interrupt). Without this, the
   * silent-turn nudge would immediately re-engage an agent the user just
   * stopped — the interrupt must actually end the exchange.
   */
  cancelReplyDebt(name: string): void {
    this.awaitingReply.delete(name);
  }

  /** True when every session is idle and every queue is empty. */
  idle(): boolean {
    for (const s of this.sessions.values()) if (s.state === 'busy') return false;
    for (const q of this.queues.values()) if (q.length > 0) return false;
    return true;
  }

  /** Resolves when the bus is fully idle (all turns finished, queues drained). */
  drain(timeoutMs = 300_000): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters.delete(check);
        reject(new Error('bus drain timeout'));
      }, timeoutMs);
      const check = () => {
        if (!this.idle()) return;
        clearTimeout(timer);
        this.idleWaiters.delete(check);
        resolve();
      };
      this.idleWaiters.add(check);
    });
  }

  /**
   * Hand an idle agent everything waiting for it, as ONE turn. Draining a
   * message per turn made mail cost turns: in a 3-agent consultation, two
   * teammates' drafts arriving while an agent worked took 4 turns to read
   * instead of 2 — and each turn is a full model round. Messages are kept
   * separate and labelled inside the turn, so the agent still sees who said
   * what; only the round-trips are merged.
   */
  private flush(name: string): void {
    const session = this.sessions.get(name);
    const queue = this.queues.get(name);
    if (!session || !queue) return;
    if (session.state !== 'idle' || queue.length === 0) return;
    const batch = queue.splice(0);
    if (batch.some((item) => item.expectReply)) this.awaitingReply.add(name);
    const text =
      batch.length === 1
        ? batch[0]!.text
        : `${batch.length} messages arrived while you were working — read them all, then reply.\n\n${batch
            .map((item, i) => `--- message ${i + 1} of ${batch.length} ---\n${item.text}`)
            .join('\n\n')}`;
    session.write(text);
  }

  private notifyIfIdle(): void {
    for (const w of [...this.idleWaiters]) w();
  }

  private resetChainsInvolving(agent: string): void {
    for (const key of this.pairChain.keys()) {
      const [a, b] = key.split('|');
      if (a === agent || b === agent) this.pairChain.delete(key);
    }
  }
}
