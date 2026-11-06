// E6 — negotiation quality (the product-risk test): two agents with genuinely
// opposing biases must reach a decision via ÖNERİ/İTİRAZ/KABUL, not burn
// tokens in a politeness ping-pong.
// PASS: decision reported to user in <= 12 pair messages, with KABUL from both.
import { startTeamAgent, deliverTo, makeBus, saveLog } from './lib.mjs';

const ROSTER = [
  { name: 'ai-engineer', desc: 'ML/AI systems engineer' },
  { name: 'data-engineer', desc: 'Data infrastructure engineer; owns the Postgres fleet' },
];

const DECISION_PROTOCOL = [
  '',
  '## Decision protocol',
  '- When debating a team decision, tag your messages: "ÖNERİ:" for a proposal, "İTİRAZ:" for an objection (with reasons), "KABUL:" to accept.',
  '- A decision is made when BOTH sides have said KABUL. After that, do not reopen it.',
  '- Argue your genuine position from your background. Concede only to better arguments (cost, ops burden, requirements) — never out of politeness.',
  '- Keep each message under 120 words.',
  '- Once the decision is made, whoever received the user\'s original request sends the final decision + rationale to "user" via send_message.',
].join('\n');

const agents = new Map();
const bus = makeBus(agents);

const A = startTeamAgent({
  name: 'ai-engineer',
  persona:
    'Background: you build ML/AI products. You have been burned by self-hosting vector infrastructure at scale (index rebuilds, memory pressure), so you lean toward managed services like Pinecone. You are honest about their costs.' +
    DECISION_PROTOCOL,
  roster: ROSTER,
  deliver: bus.deliver,
  model: 'sonnet',
});
const B = startTeamAgent({
  name: 'data-engineer',
  persona:
    "Background: you own the company Postgres fleet. You strongly prefer consolidating on Postgres (pgvector): no new vendor, no new billing, data stays put. You are honest about pgvector's scale limits." +
    DECISION_PROTOCOL,
  roster: ROSTER,
  deliver: bus.deliver,
  model: 'sonnet',
});
agents.set('ai-engineer', A);
agents.set('data-engineer', B);

// Agents may legitimately escalate a question to the user (brief §5) before
// deciding — run 1 did exactly that. We answer as the user's proxy (canned
// facts) and keep waiting for the final decision.
const CANNED_ANSWER =
  'Write pattern: bulk initial load (~2M embeddings), then continuous trickle upserts around 50k/day with occasional import spikes. Read-heavy overall (~99% reads). Now finalize the decision with your teammate and send it to "user".';

const bothKabul = () =>
  bus.log.some((m) => m.from === 'ai-engineer' && m.to === 'data-engineer' && m.content.includes('KABUL')) &&
  bus.log.some((m) => m.from === 'data-engineer' && m.to === 'ai-engineer' && m.content.includes('KABUL'));
const pairCount = () => bus.log.filter((m) => m.from !== 'user' && m.to !== 'user').length;

let pairSeen = 0;
const overflowP = bus
  .waitFor((m) => m.from !== 'user' && m.to !== 'user' && ++pairSeen > 12, 3_600_000, 'overflow')
  .then(() => ({ kind: 'overflow' }))
  .catch(() => new Promise(() => {})); // its timeout must never win the race

async function decisionLoop() {
  let answered = 0;
  for (;;) {
    const m = await bus.waitFor((x) => x.to === 'user', 600_000, 'message to user');
    if (bothKabul() || answered >= 2) return { kind: 'decision', m };
    answered += 1;
    console.log(`[user-proxy] answering escalation from ${m.from}`);
    bus.deliver({ from: 'user', to: m.from, content: CANNED_ANSWER });
  }
}

const t0 = Date.now();
deliverTo(
  A,
  '[from user]: Team decision needed: pgvector or Pinecone as the vector store for our product? Context: startup, ~2M embeddings today, projected ~50M in 2 years, 3-person infra team, cost-sensitive, Postgres already in our stack. Negotiate with data-engineer using the decision protocol and send the final decision with rationale to "user" when you both agree.',
);

const finalOutcome = await Promise.race([decisionLoop(), overflowP]).catch((e) => ({ kind: 'timeout', error: e.message }));

A.input.close();
B.input.close();
await Promise.allSettled([A.done, B.done]);
saveLog('e6-ai-engineer.jsonl', A.events);
saveLog('e6-data-engineer.jsonl', B.events);

console.log('\n================ TRANSCRIPT ================');
for (const m of bus.log) {
  console.log(`\n--- ${m.from} -> ${m.to} (+${((m.at - t0) / 1000).toFixed(1)}s) ---`);
  console.log(m.content);
}
console.log('\n================ METRICS ================');
const kabulA = bus.log.some((m) => m.from === 'ai-engineer' && m.to !== 'user' && m.content.includes('KABUL'));
const kabulB = bus.log.some((m) => m.from === 'data-engineer' && m.to !== 'user' && m.content.includes('KABUL'));
console.log(`outcome: ${finalOutcome.kind}`);
console.log(`pair messages: ${pairCount()} (cap 12)`);
console.log(`KABUL said by: ai-engineer=${kabulA} data-engineer=${kabulB}`);
console.log(`duration: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`ai-engineer   turns=${A.usage.turns} tokens in=${A.usage.in} out=${A.usage.out}`);
console.log(`data-engineer turns=${B.usage.turns} tokens in=${B.usage.in} out=${B.usage.out}`);

const pass = finalOutcome.kind === 'decision' && pairCount() <= 12 && kabulA && kabulB;
console.log(pass ? 'E6 PASS' : `E6 FAIL (${finalOutcome.kind}${finalOutcome.error ? ': ' + finalOutcome.error : ''})`);
