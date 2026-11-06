// E5 — two live sessions + full message round over the bus:
// user -> A, A -> B (send_message), B -> A (reply), A -> user (summary),
// then the user talks to B directly. Measures leg latency and token usage.
import { startTeamAgent, deliverTo, makeBus, saveLog } from './lib.mjs';

const ROSTER = [
  { name: 'ai-engineer', desc: 'ML/AI systems engineer' },
  { name: 'data-engineer', desc: 'Data infrastructure engineer; owns the Postgres fleet' },
];

const agents = new Map();
const bus = makeBus(agents);

const debugEvent = (agent, msg) => {
  const kind = `${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`;
  let detail = '';
  if (msg.type === 'assistant') {
    detail = (msg.message?.content ?? [])
      .map((b) => (b.type === 'text' ? `text:"${b.text?.slice(0, 80)}"` : `${b.type}:${b.name ?? ''}`))
      .join(' | ');
  }
  if (msg.type === 'result') detail = `"${String(msg.result).slice(0, 120)}"`;
  console.log(`  [${agent.name}] ${kind} ${detail}`);
};

const A = startTeamAgent({
  name: 'ai-engineer',
  persona: 'Background: you build ML/AI systems and integrate vector search into products.',
  roster: ROSTER,
  deliver: bus.deliver,
  onEvent: debugEvent,
});
const B = startTeamAgent({
  name: 'data-engineer',
  persona: 'Background: you run the company data infrastructure. If asked to recommend a Postgres extension for vector search, recommend pgvector with one sentence of reasoning.',
  roster: ROSTER,
  deliver: bus.deliver,
  onEvent: debugEvent,
});
agents.set('ai-engineer', A);
agents.set('data-engineer', B);

// Attach all watchers BEFORE kickoff to avoid races.
const legAtoB = bus.waitFor((m) => m.from === 'ai-engineer' && m.to === 'data-engineer', 300_000, 'A->B');
const legBtoA = bus.waitFor((m) => m.from === 'data-engineer' && m.to === 'ai-engineer', 300_000, 'B->A');
const legAtoUser = bus.waitFor((m) => m.from === 'ai-engineer' && m.to === 'user', 300_000, 'A->user');

const t0 = Date.now();
deliverTo(
  A,
  '[from user]: Ask data-engineer (via send_message) which Postgres extension they recommend for vector search. When their answer arrives as a "[from data-engineer]" message, send a one-line summary of it to "user" via send_message.',
);

const m1 = await legAtoB;
console.log(`LEG user->A->B   ${m1.at - t0} ms`);
const m2 = await legBtoA;
console.log(`LEG B(reply)->A  ${m2.at - m1.at} ms`);
const m3 = await legAtoUser;
console.log(`LEG A(summary)->user ${m3.at - m2.at} ms`);
console.log(`ROUND TRIP total ${m3.at - t0} ms`);

// Direct user -> B conversation on the same live session.
const pong = bus.waitFor((m) => m.from === 'data-engineer' && m.to === 'user', 300_000, 'B->user PONG');
deliverTo(B, '[from user]: Reply with exactly "PONG" to user via send_message.');
const m4 = await pong;

A.input.close();
B.input.close();
await Promise.allSettled([A.done, B.done]);

saveLog('e5-ai-engineer.jsonl', A.events);
saveLog('e5-data-engineer.jsonl', B.events);

console.log('---');
console.log(`ai-engineer   session=${A.sessionId} turns=${A.usage.turns} tokens in=${A.usage.in} out=${A.usage.out}`);
console.log(`data-engineer session=${B.sessionId} turns=${B.usage.turns} tokens in=${B.usage.in} out=${B.usage.out}`);
console.log(`bus log: ${bus.log.length} messages`);

const pass =
  m3.content.toLowerCase().includes('pgvector') &&
  m4.content.includes('PONG') &&
  A.sessionId && B.sessionId && A.sessionId !== B.sessionId;
console.log(pass ? 'E5 PASS' : 'E5 FAIL');
