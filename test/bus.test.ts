import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bus, BUS_NOTE, SILENT_TURN_NOTE, REPLY_BUDGET_NOTE, MAX_AGENTS } from '../src/bus.ts';
import type { BusMessage, RosterEntry, SessionState } from '../src/types.ts';

class FakeSession extends EventEmitter {
  readonly name: string;
  state: SessionState = 'idle';
  written: string[] = [];
  constructor(name: string) {
    super();
    this.name = name;
  }
  write(text: string): void {
    if (this.state !== 'idle') throw new Error('write while busy');
    this.state = 'busy';
    this.written.push(text);
  }
  overheard: string[] = [];
  overhear(text: string): void {
    this.overheard.push(text); // no state change: hearing is not working
  }
  finishTurn(): void {
    this.state = 'idle';
    this.emit('idle');
  }
  die(): void {
    this.state = 'offline';
    this.emit('offline');
  }
}

const ROSTER: RosterEntry[] = [
  { name: 'a', desc: 'agent a', lead: true },
  { name: 'b', desc: 'agent b' },
];

// Fresh roster per test: Bus mutates roster (setLead/addRoster/removeRoster),
// so a shared array would leak state across tests.
const freshRoster = (): RosterEntry[] => ROSTER.map((r) => ({ ...r }));

function setup(opts: Partial<ConstructorParameters<typeof Bus>[0]> = {}) {
  const bus = new Bus({ roster: freshRoster(), ...opts });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);
  return { bus, a, b };
}

test('idle target gets the message immediately, with sender prefix', () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'hello' });
  assert.deepEqual(a.written, ['[from user]: hello']);
  assert.equal(a.state, 'busy');
});

test('messages to a busy agent queue FIFO and none are lost', () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'm1' });
  bus.deliver({ from: 'user', to: 'a', content: 'm2' });
  bus.deliver({ from: 'b', to: 'a', content: 'm3' });
  assert.equal(a.written.length, 1); // m2, m3 queued while busy

  a.finishTurn(); // the whole queue is handed over in one turn, order intact
  assert.equal(a.written.length, 2);
  const delivered = a.written[1]!;
  assert.ok(delivered.indexOf('[from user]: m2') < delivered.indexOf('[from b]: m3'), 'FIFO order');
  assert.ok(delivered.includes('[from user]: m2') && delivered.includes('[from b]: m3'), 'none lost');

  // Nothing left to drain; the next silent turn is the nudge's business,
  // not the queue's.
  a.finishTurn();
  assert.ok(a.written[2]!.includes(SILENT_TURN_NOTE));
});

test('messages to an offline agent are retained, not dropped', () => {
  const { bus, a } = setup();
  a.die();
  bus.deliver({ from: 'user', to: 'a', content: 'while dead' });
  assert.equal(a.written.length, 0);
  // Revival: the session comes back and reports idle -> queue flushes.
  a.state = 'idle';
  a.emit('idle');
  assert.deepEqual(a.written, ['[from user]: while dead']);
});

test('unknown target is reported, not thrown', () => {
  const drops: string[] = [];
  const { bus } = setup({ onDrop: (m, reason) => drops.push(`${m.to}:${reason}`) });
  bus.deliver({ from: 'a', to: 'ghost', content: 'x' });
  assert.deepEqual(drops, ['ghost:unknown-target']);
});

// Simulate a normal agent turn: on delivery the agent replies (which clears its
// silent-turn debt), then its turn ends. `finishTurn` alone would look silent.
function replyThenFinish(bus: Bus, from: string, to: string, content: string, sender: FakeSession): void {
  bus.deliver({ from, to, content }); // this delivery IS the agent's reply
  sender.finishTurn();
}

test('turn budget: note injected at Nth consecutive pair message, repeats every N', () => {
  const notes: number[] = [];
  const { bus, a, b } = setup({ turnBudget: 4, onNote: () => notes.push(bus.log.length) });
  for (let i = 1; i <= 9; i++) {
    const [from, to, sender] = i % 2 === 1 ? ['a', 'b', a] : ['b', 'a', b];
    replyThenFinish(bus, from!, to!, `msg ${i}`, sender as FakeSession);
  }
  const withNote = [...a.written, ...b.written].filter((t) => t.includes(BUS_NOTE));
  assert.equal(withNote.length, 2); // at pair message 4 and 8, both b->a deliveries
  assert.ok(a.written[1]!.includes(BUS_NOTE)); // pair msg 4
  assert.ok(a.written[3]!.includes(BUS_NOTE)); // pair msg 8
  assert.ok(b.written.every((t) => !t.includes(BUS_NOTE)));
  assert.equal(notes.length, 2);
});

test('turn budget chain resets when the user gets involved', () => {
  const { bus, a, b } = setup({ turnBudget: 4 });
  for (let i = 1; i <= 3; i++) {
    const [from, to, sender] = i % 2 === 1 ? ['a', 'b', a] : ['b', 'a', b];
    replyThenFinish(bus, from!, to!, `msg ${i}`, sender as FakeSession);
  }
  bus.deliver({ from: 'a', to: 'user', content: 'escalating' }); // breaks the chain
  for (let i = 4; i <= 6; i++) {
    const [from, to, sender] = i % 2 === 1 ? ['a', 'b', a] : ['b', 'a', b];
    replyThenFinish(bus, from!, to!, `msg ${i}`, sender as FakeSession);
  }
  const withNote = [...a.written, ...b.written].filter((t) => t.includes(BUS_NOTE));
  assert.equal(withNote.length, 0); // 3 + 3 messages, never 4 consecutive
});

test('user messages route: default to lead, @name to agent, @everyone to all', () => {
  const { bus } = setup();
  // Plain text goes to the lead (a), wrapped in a [LEAD BRIEF] coordination frame.
  const toLead = bus.routeUserInput('hello team');
  assert.equal(toLead.length, 1);
  assert.equal(toLead[0].to, 'a');
  assert.ok(toLead[0].content.startsWith('[LEAD BRIEF]'));
  assert.ok(toLead[0].content.includes('USER TASK: hello team'));
  assert.deepEqual(bus.routeUserInput('@b just you'), [{ from: 'user', to: 'b', content: 'just you' }]);
  // @everyone broadcasts with a [TEAM TASK] coordination envelope to all agents.
  const all = bus.routeUserInput('@everyone ship it');
  assert.equal(all.length, 2);
  assert.ok(all.every((m) => m.content.startsWith('[TEAM TASK — participants: a, b] ship it')));
  assert.deepEqual(all.map((m) => m.to).sort(), ['a', 'b']);
  assert.deepEqual(bus.routeUserInput('@ghost hi'), []); // unknown mention
  assert.deepEqual(bus.routeUserInput('   '), []);
});

test('selected group routing: one selected → direct, many → group task, none → lead', () => {
  const { bus } = setup();
  // single selection: plain delivery to that agent
  assert.deepEqual(bus.routeUserInput('do it', ['b']), [{ from: 'user', to: 'b', content: 'do it' }]);
  // multi selection: a group task naming the participants, to exactly those agents
  const grp = bus.routeUserInput('talk it over', ['a', 'b']);
  assert.equal(grp.length, 2);
  assert.ok(grp.every((m) => m.content.startsWith('[TEAM TASK — participants: a, b]')));
  assert.deepEqual(grp.map((m) => m.to).sort(), ['a', 'b']);
  // no selection: falls back to the lead (with the [LEAD BRIEF] frame)
  const lead = bus.routeUserInput('hey', []);
  assert.equal(lead[0].to, 'a');
  assert.ok(lead[0].content.includes('USER TASK: hey'));
  // a plain task without a consult cue does NOT force cross-consultation
  assert.ok(!lead[0].content.includes('CROSS-CONSULTATION IS MANDATORY'));
  // a task that asks them to consult/compare DOES force it (TR cue: "danış")
  const consult = bus.routeUserInput('bunu araştırıp birbirinize danışın', []);
  assert.ok(consult[0].content.includes('CROSS-CONSULTATION IS MANDATORY'));
  // an explicit @mention overrides any selection
  assert.deepEqual(bus.routeUserInput('@b only you', ['a']), [{ from: 'user', to: 'b', content: 'only you' }]);
});

test('addRosterEntry adds a runtime agent to routing', () => {
  const { bus } = setup();
  bus.addRosterEntry({ name: 'c', desc: 'agent c' });
  assert.ok(bus.roster.some((r) => r.name === 'c'));
  bus.addRosterEntry({ name: 'c', desc: 'dup' }); // no duplicate
  assert.equal(bus.roster.filter((r) => r.name === 'c').length, 1);
});

test('removeRosterEntry drops an agent from routing', () => {
  const { bus } = setup();
  bus.removeRosterEntry('b');
  assert.ok(!bus.roster.some((r) => r.name === 'b'));
  // a message to a removed agent is dropped (unknown target), not delivered
  const drops: string[] = [];
  const bus2 = new Bus({ roster: freshRoster(), onDrop: (m, r) => drops.push(`${m.to}:${r}`) });
  bus2.register(new FakeSession('a'));
  bus2.register(new FakeSession('b'));
  bus2.removeRosterEntry('b');
  bus2.deliver({ from: 'a', to: 'b', content: 'gone' });
  assert.deepEqual(drops, ['b:unknown-target']);
});

test('setLead assigns exactly one lead; null clears it; routing follows', () => {
  const { bus } = setup();
  // a is lead by default (ROSTER). Move lead to b.
  bus.setLead('b');
  assert.equal(bus.roster.find((r) => r.name === 'b')?.lead, true);
  assert.equal(bus.roster.find((r) => r.name === 'a')?.lead, false);
  // unmentioned message now routes to b
  assert.equal(bus.routeUserInput('hey')[0].to, 'b');
  // clear the lead → the composer talks to AGENTS only (the lead lives
  // outside the app): plain text becomes a group task to the whole team.
  bus.setLead(null);
  assert.ok(!bus.roster.some((r) => r.lead));
  const plain = bus.routeUserInput('hey');
  assert.equal(plain.length, 2);
  assert.ok(plain.every((m) => m.content.startsWith('[TEAM TASK — participants: a, b]')));
  assert.deepEqual(plain.map((m) => m.to).sort(), ['a', 'b']);
  assert.equal(bus.routeUserInput('@a hey')[0]!.to, 'a');
});

test('lead isolation: a non-lead agent\'s user message is rerouted to the lead', () => {
  // b tries to talk to the user → should go to the lead (a), not to onUserMessage.
  const userSeen: { content: string }[] = [];
  const bus2 = new Bus({ roster: freshRoster(), onUserMessage: (m) => userSeen.push(m) });
  const a2 = new FakeSession('a');
  const b2 = new FakeSession('b');
  bus2.register(a2);
  bus2.register(b2);
  bus2.deliver({ from: 'b', to: 'user', content: 'my findings' });
  assert.equal(userSeen.length, 0); // did NOT reach the user
  assert.equal(a2.written.length, 1); // reached the lead instead
  assert.ok(a2.written[0].includes('my findings'));
  // the lead itself CAN reach the user
  bus2.deliver({ from: 'a', to: 'user', content: 'combined answer' });
  assert.equal(userSeen.length, 1);
  assert.equal(userSeen[0].content, 'combined answer');
});

test('direct mode: the addressed agent owns the user channel; others bounce', () => {
  const userSeen: { from: string; content: string }[] = [];
  const bus = new Bus({ roster: freshRoster(), onUserMessage: (m) => userSeen.push(m) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);
  for (const m of bus.routeUserInput('@b just you')) bus.deliver(m);

  // b (the addressee) reaches the user directly — no reroute to the lead (a).
  bus.deliver({ from: 'b', to: 'user', content: 'my answer' });
  assert.equal(userSeen.length, 1);
  assert.equal(userSeen[0]!.from, 'b');
  // ...and keeps the channel for a follow-up (not a one-shot budget).
  bus.deliver({ from: 'b', to: 'user', content: 'one addendum' });
  assert.equal(userSeen.length, 2);
  assert.ok(a.written.every((t) => !t.includes('my answer'))); // lead never saw it

  // the lead was NOT addressed — its user message bounces back with a note.
  bus.deliver({ from: 'a', to: 'user', content: 'me too' });
  assert.equal(userSeen.length, 2);
  assert.ok(a.written.at(-1)!.includes(REPLY_BUDGET_NOTE));
});

test('group mode: one user reply per participant; extras bounce without a nudge loop', () => {
  const userSeen: { from: string }[] = [];
  const drops: string[] = [];
  const bus = new Bus({
    roster: freshRoster(),
    onUserMessage: (m) => userSeen.push(m),
    onDrop: (m, reason) => drops.push(`${m.from}:${reason}`),
  });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);
  for (const m of bus.routeUserInput('@everyone go')) bus.deliver(m); // a, b now busy

  // Each participant's single reply passes — including the lead's, as a peer.
  bus.deliver({ from: 'a', to: 'user', content: 'a piece' });
  bus.deliver({ from: 'b', to: 'user', content: 'b piece' });
  assert.deepEqual(userSeen.map((m) => m.from).sort(), ['a', 'b']);

  // A second reply from b is past budget: bounced to b, reported as a drop.
  bus.deliver({ from: 'b', to: 'user', content: 'closing chatter' });
  assert.equal(userSeen.length, 2);
  assert.deepEqual(drops, ['b:user-reply-budget']);

  // The bounce note is queued (b busy) and carries NO reply obligation:
  // b goes silent after reading it and must NOT be nudged (no chatter loop).
  b.finishTurn(); // flushes the note
  assert.ok(b.written.at(-1)!.includes(REPLY_BUDGET_NOTE));
  b.finishTurn(); // silent after the note
  assert.ok(b.written.every((t) => !t.includes(SILENT_TURN_NOTE)));
});

test('group mode via selection: the unselected lead cannot speak to the user', () => {
  const userSeen: { from: string }[] = [];
  const roster: RosterEntry[] = [...freshRoster(), { name: 'c', desc: 'agent c' }];
  const bus = new Bus({ roster, onUserMessage: (m) => userSeen.push(m) });
  const a = new FakeSession('a'); // lead, NOT selected
  const b = new FakeSession('b');
  const c = new FakeSession('c');
  bus.register(a);
  bus.register(b);
  bus.register(c);
  for (const m of bus.routeUserInput('talk it over', ['b', 'c'])) bus.deliver(m);

  bus.deliver({ from: 'b', to: 'user', content: 'b piece' });
  bus.deliver({ from: 'c', to: 'user', content: 'c piece' });
  bus.deliver({ from: 'a', to: 'user', content: 'lead relay attempt' });
  assert.deepEqual(userSeen.map((m) => m.from).sort(), ['b', 'c']);
  assert.ok(a.written.at(-1)!.includes(REPLY_BUDGET_NOTE));
});

test('grants accumulate: a second targeted ask must not revoke the first (lead regression)', () => {
  const userSeen: { from: string }[] = [];
  const bus = new Bus({ roster: [{ name: 'a', desc: 'x' }, { name: 'b', desc: 'y' }], onUserMessage: (m) => userSeen.push(m) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  // The exact sequence that lost ev-systems-specialist's answer:
  for (const m of bus.routeUserInput('@a question one')) bus.deliver(m);
  for (const m of bus.routeUserInput('@b question two')) bus.deliver(m);
  // The second dispatch must NOT strip a's right to reply.
  bus.deliver({ from: 'b', to: 'user', content: 'answer two' });
  bus.deliver({ from: 'a', to: 'user', content: 'answer one' });
  assert.deepEqual(userSeen.map((m) => m.from).sort(), ['a', 'b']);

  // Group grants add up: two group tasks -> two owed replies each.
  a.finishTurn(); b.finishTurn();
  for (const m of bus.routeUserInput('@everyone t1')) bus.deliver(m);
  a.finishTurn(); b.finishTurn();
  for (const m of bus.routeUserInput('@everyone t2')) bus.deliver(m);
  bus.deliver({ from: 'b', to: 'user', content: 'r1' });
  bus.deliver({ from: 'b', to: 'user', content: 'r2' });
  assert.equal(userSeen.length, 4); // both b replies delivered (1+1 grants)
});

test('delivery MODE follows the latest input (grants persist)', () => {
  const userSeen: { from: string }[] = [];
  const bus = new Bus({ roster: freshRoster(), onUserMessage: (m) => userSeen.push(m) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  // Group task: b spends its one reply.
  for (const m of bus.routeUserInput('@everyone go')) bus.deliver(m);
  bus.deliver({ from: 'b', to: 'user', content: 'piece' });
  assert.equal(userSeen.length, 1);

  // New direct input to b: fresh policy, b owns the channel again.
  a.finishTurn();
  b.finishTurn();
  for (const m of bus.routeUserInput('@b follow up')) bus.deliver(m);
  bus.deliver({ from: 'b', to: 'user', content: 'follow-up answer' });
  assert.equal(userSeen.length, 2);

  // Plain input restores lead mode: b's user message reroutes to the lead.
  b.finishTurn();
  for (const m of bus.routeUserInput('plain task')) bus.deliver(m);
  bus.deliver({ from: 'b', to: 'user', content: 'should reroute' });
  assert.equal(userSeen.length, 2);
});

test('MAX_AGENTS: constructor rejects an oversized roster', () => {
  const roster: RosterEntry[] = Array.from({ length: MAX_AGENTS + 1 }, (_, i) => ({
    name: `agent${i}`,
    desc: `agent ${i}`,
  }));
  assert.throws(() => new Bus({ roster }), new RegExp(`MAX_AGENTS is ${MAX_AGENTS}`));
});

test('MAX_AGENTS: addRosterEntry refuses past the cap, accepts up to it', () => {
  const { bus } = setup(); // a, b
  assert.equal(bus.addRosterEntry({ name: 'c', desc: 'c' }), true);
  assert.equal(bus.addRosterEntry({ name: 'd', desc: 'd' }), true);
  assert.equal(bus.addRosterEntry({ name: 'e', desc: 'e' }), true); // 5th — at cap
  assert.equal(bus.addRosterEntry({ name: 'f', desc: 'f' }), false); // over cap
  assert.equal(bus.roster.length, MAX_AGENTS);
  // Re-adding an existing member is not a refusal (idempotent).
  assert.equal(bus.addRosterEntry({ name: 'c', desc: 'dup' }), true);
  assert.equal(bus.roster.length, MAX_AGENTS);
});

test('activity labels come from delivery outcomes, not intent', () => {
  const acts: string[] = [];
  const bus = new Bus({
    roster: freshRoster(),
    onUserMessage: () => {},
    onAgentActivity: (name, a) => acts.push(`${name}: ${a}`),
  });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  // agent -> agent: label names the real recipient
  bus.deliver({ from: 'a', to: 'b', content: 'x' });
  assert.equal(acts.at(-1), 'a: messaging b…');
  // lead mode: b's user message reroutes -> label says so (a is lead)
  bus.deliver({ from: 'b', to: 'user', content: 'findings' });
  assert.equal(acts.at(-1), 'b: reporting to the lead…');
  // the lead's own user reply is a real delivery
  bus.deliver({ from: 'a', to: 'user', content: 'answer' });
  assert.equal(acts.at(-1), 'a: replying to the user…');
  // group mode: past-budget reply is held — label tells the truth
  for (const m of bus.routeUserInput('@everyone go')) bus.deliver(m);
  bus.deliver({ from: 'b', to: 'user', content: 'one' });
  assert.equal(acts.at(-1), 'b: replying to the user…');
  bus.deliver({ from: 'b', to: 'user', content: 'two' });
  assert.equal(acts.at(-1), 'b: reply held — budget spent');
  // user-originated deliveries never label an agent
  assert.ok(acts.every((s) => !s.startsWith('user:')));
});

test('interrupt: cancelReplyDebt suppresses the silent-turn nudge', () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'long task' }); // a owes a reply
  bus.cancelReplyDebt('a'); // user hit ESC — the exchange is over
  a.finishTurn(); // aborted turn ends silently
  assert.equal(a.written.length, 1); // no nudge: only the original delivery
  assert.ok(a.written.every((t) => !t.includes(SILENT_TURN_NOTE)));
});

test('silent turn: an agent that ends a turn without replying is nudged once', () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'please answer' });
  assert.equal(a.written.length, 1);

  a.finishTurn(); // ended without sending anything → nudge
  assert.equal(a.written.length, 2);
  assert.ok(a.written[1]!.includes(SILENT_TURN_NOTE));

  a.finishTurn(); // still silent → NO second nudge (no loop)
  assert.equal(a.written.length, 2);
});

test('reply provenance: an answer to composer input is addressed to you, not the lead', () => {
  // Composer traffic never passes through the Team Lead, so labelling the
  // reply "-> Team Lead" told the user something untrue about where it went.
  const seen: BusMessage[] = [];
  const bus = new Bus({ roster: freshRoster(), onUserMessage: (m) => seen.push(m) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  for (const m of bus.routeUserInput('a question', ['a'])) bus.deliver({ ...m, via: 'composer' });
  bus.deliver({ from: 'a', to: 'user', content: 'an answer' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.via, 'composer', 'the reply carries the channel that asked');
});

test('reply provenance: an answer to bridge input stays with the lead', () => {
  const seen: BusMessage[] = [];
  const bus = new Bus({ roster: freshRoster(), onUserMessage: (m) => seen.push(m) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  for (const m of bus.routeUserInput('a question', ['a'])) bus.deliver({ ...m, via: 'bridge' });
  bus.deliver({ from: 'a', to: 'user', content: 'an answer' });

  assert.equal(seen[0]!.via, 'bridge');
});

test('meeting room: a bystander overhears traffic without being woken', () => {
  const heard: string[] = [];
  const bus = new Bus({ roster: freshRoster().concat({ name: 'c', desc: 'agent c' }), onOverheard: (n) => heard.push(n) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  const c = new FakeSession('c');
  bus.register(a);
  bus.register(b);
  bus.register(c);

  bus.deliver({ from: 'a', to: 'b', content: 'I am taking the parser task' });

  assert.equal(b.written.length, 1, 'the addressee gets a real turn');
  assert.equal(c.written.length, 0, 'the bystander is NOT given a turn');
  assert.equal(c.overheard.length, 1, 'but it hears the exchange');
  assert.ok(c.overheard[0]!.includes('I am taking the parser task'));
  assert.ok(c.overheard[0]!.includes('a → b'), 'and knows who said it to whom');
  assert.equal(c.state, 'idle', 'hearing does not make it busy');
  assert.deepEqual(heard, ['c'], 'reported once, for the bystander only');
});

test('meeting room: sender and addressee do not overhear their own exchange', () => {
  const bus = new Bus({ roster: freshRoster() });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  bus.deliver({ from: 'a', to: 'b', content: 'hello' });
  assert.equal(a.overheard.length, 0);
  assert.equal(b.overheard.length, 0);
});

test('meeting room: external traffic reaches everyone, waking nobody', () => {
  const bus = new Bus({ roster: freshRoster() });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  const n = bus.overhearExternal('we dropped the DBC idea');
  assert.equal(n, 2);
  for (const s of [a, b]) {
    assert.equal(s.written.length, 0, 'nobody is given a turn');
    assert.ok(s.overheard[0]!.includes('we dropped the DBC idea'));
  }
});

test('user input jumps the queue ahead of teammate chatter', () => {
  // The user is correcting course. Reading a teammate's draft on the old
  // thread BEFORE the correction is how an agent ends up arguing for an
  // idea the user already dropped.
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'first task' }); // a goes busy
  bus.deliver({ from: 'b', to: 'a', content: 'TEAMMATE-CHATTER' });
  bus.deliver({ from: 'user', to: 'a', content: 'CORRECTION' });

  a.finishTurn();
  const delivered = a.written[1]!;
  assert.ok(
    delivered.indexOf('CORRECTION') < delivered.indexOf('TEAMMATE-CHATTER'),
    'the correction is read first',
  );
});

test('clearQueue drops pending mail without unseating the agent', () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'task' });
  bus.deliver({ from: 'b', to: 'a', content: 'ABANDONED-THREAD' });

  bus.clearQueue('a'); // the agent is being reset
  a.finishTurn();
  assert.ok(a.written.every((t) => !t.includes('ABANDONED-THREAD')));
  assert.equal(a.written.length, 1, 'nothing was delivered after the reset');
});

test('queue coalescing: messages that piled up while busy arrive in ONE turn', () => {
  const bus = new Bus({ roster: freshRoster().concat({ name: 'c', desc: 'agent c' }) });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  const c = new FakeSession('c');
  bus.register(a);
  bus.register(b);
  bus.register(c);

  bus.deliver({ from: 'user', to: 'a', content: 'task' }); // a is now busy
  bus.deliver({ from: 'b', to: 'a', content: 'B-DRAFT' }); // queued
  bus.deliver({ from: 'c', to: 'a', content: 'C-DRAFT' }); // queued
  assert.equal(a.written.length, 1);

  a.finishTurn(); // both queued messages must land together
  assert.equal(a.written.length, 2, 'one turn drains the whole queue');
  assert.ok(a.written[1]!.includes('B-DRAFT'));
  assert.ok(a.written[1]!.includes('C-DRAFT'));
});

test('queue coalescing: a bus note keeps its own turn', () => {
  // Infrastructure notices carry expectReply: false and their own framing;
  // merging them into a teammate's message would blur who is owed a reply.
  const bus = new Bus({ roster: freshRoster() });
  const a = new FakeSession('a');
  const b = new FakeSession('b');
  bus.register(a);
  bus.register(b);

  bus.deliver({ from: 'user', to: 'a', content: 'task' });
  bus.deliver({ from: 'b', to: 'a', content: 'FIRST' });
  bus.deliver({ from: 'b', to: 'a', content: 'SECOND' });
  a.finishTurn();
  assert.ok(a.written[1]!.includes('FIRST') && a.written[1]!.includes('SECOND'));
});

test('lead brief: cross-consultation fires on intent, not on a substring', () => {
  const { bus } = setup();
  const brief = (text: string) => {
    const routed = bus.routeUserInput(text);
    return routed[0]!.content.includes('CROSS-CONSULTATION IS MANDATORY');
  };
  // Asked for → mandatory (a false negative costs the user the consultation).
  assert.ok(brief('bu iki dosyayı karşılaştır'), 'karşılaştır');
  assert.ok(brief('şunu tartışalım'), 'tartışalım');
  assert.ok(brief('compare these logs'), 'compare');
  // Not asked for → must stay off: it roughly triples the turns to an answer.
  assert.ok(!brief('birbirine bağla'), '"birbirine" is wiring, not consulting');
  assert.ok(!brief('danışman lazım'), '"danışman" is a noun, not a request');
  assert.ok(!brief('review this function'), 'plain review');
});

test('respawn: a superseded session stops driving the bus', () => {
  // updateAgent closes the old session and spawns a new one. The old session's
  // own 'idle' listener fires first (registered at first spawn), BEFORE the new
  // session registers — it must not flush the queue into the session being
  // retired, or the message is lost and the old session goes busy again.
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'first' });
  bus.deliver({ from: 'b', to: 'a', content: 'QUEUED' });
  assert.equal(a.written.length, 1); // second one queued while busy

  bus.unregister(a); // updateAgent retires it, then awaits close()
  a.finishTurn(); // old turn ends while the respawn is in flight
  assert.ok(
    a.written.every((t) => !t.includes('QUEUED')),
    'queued message must not be written to the outgoing session',
  );
  assert.equal(a.state, 'idle', 'the retired session must not be made busy again');

  const fresh = new FakeSession('a');
  bus.register(fresh);
  assert.ok(fresh.written.some((t) => t.includes('QUEUED')), 'the new session receives the queued message');
});

test('re-added agent: a stale nudge flag does not suppress its first silent turn', () => {
  const reports: string[] = [];
  const { bus, a } = setup({ onSilentTurn: (n) => reports.push(n) });
  bus.deliver({ from: 'user', to: 'a', content: 'task' });
  a.finishTurn(); // silent → nudged, and `nudged` stays set (a never spoke)
  assert.deepEqual(reports, ['a']);

  bus.removeRosterEntry('a');
  bus.addRosterEntry({ name: 'a', desc: 'a again' });
  const fresh = new FakeSession('a');
  bus.register(fresh);
  bus.deliver({ from: 'user', to: 'a', content: 'task' });
  fresh.finishTurn();

  assert.deepEqual(reports, ['a', 'a'], 'the fresh agent gets its own silent-turn report');
  assert.ok(fresh.written.some((t) => t.includes(SILENT_TURN_NOTE)), 'and its own nudge');
});

test('silent turn: onSilentTurn reports the agent, so waiters stop waiting', () => {
  const seen: string[] = [];
  const { bus, a } = setup({ onSilentTurn: (name) => seen.push(name) });
  bus.deliver({ from: 'user', to: 'a', content: 'please answer' });

  a.finishTurn(); // ended without sending anything
  assert.deepEqual(seen, ['a']);

  // Reported once per silent turn, in step with the single nudge.
  a.finishTurn();
  assert.deepEqual(seen, ['a']);
});

test('silent turn: no nudge when the agent actually replied', () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'answer me' });
  bus.deliver({ from: 'a', to: 'user', content: 'here is my answer' }); // a spoke
  a.finishTurn();
  assert.equal(a.written.length, 1); // only the original delivery; no nudge
});

test('drain resolves once all turns finish and queues empty', async () => {
  const { bus, a } = setup();
  bus.deliver({ from: 'user', to: 'a', content: 'm1' });
  bus.deliver({ from: 'user', to: 'a', content: 'm2' });
  let drained = false;
  const p = bus.drain(5_000).then(() => (drained = true));
  bus.deliver({ from: 'a', to: 'user', content: 'reply 1' }); // a replies (clears silent-turn debt)
  a.finishTurn(); // m2 flushes from the queue
  assert.equal(drained, false); // m2 still in flight
  bus.deliver({ from: 'a', to: 'user', content: 'reply 2' });
  a.finishTurn();
  await p;
  assert.equal(drained, true);
});
