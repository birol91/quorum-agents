// P2 live smoke — roadmap criterion: "a contentious question ends with the
// agents deciding on their own", now with a PERMANENT decision record:
// negotiation -> mutual KABUL -> record_decision -> decisions.jsonl/md -> user report.
import { Bus } from '../src/bus.ts';
import { SdkSession } from '../src/session.ts';
import { buildSystemPrompt, DECISION_PROTOCOL } from '../src/protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../src/tools.ts';
import { DecisionStore } from '../src/decisions.ts';
import { rmSync } from 'node:fs';

const OUT = new URL('./out/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
const store = new DecisionStore(OUT);

const ROSTER = [
  { name: 'ai-engineer', desc: 'ML/AI systems engineer', lead: true },
  { name: 'data-engineer', desc: 'Data infrastructure engineer; owns the Postgres fleet' },
];

const userMsgs = [];
const bus = new Bus({
  roster: ROSTER,
  trace: (line) => console.log(line),
  onUserMessage: (m) => userMsgs.push(m),
});
const pairCount = () => bus.log.filter((m) => m.from !== 'user' && m.to !== 'user').length;

async function makeAgent(name, persona) {
  const s = new SdkSession({
    name,
    model: 'sonnet',
    systemPrompt: buildSystemPrompt(name, `${persona}\n\n${DECISION_PROTOCOL}`, ROSTER),
    mcpServers: {
      quorum: await quorumServerFor(name, () => ROSTER, (m) => bus.deliver(m), {
        recordDecision: (d) => {
          const entry = store.record(d);
          console.log(`[decision] ${d.decidedBy} recorded: ${d.topic} -> ${d.decision}`);
          return entry;
        },
      }),
    },
    allowedTools: QUORUM_TOOL_NAMES,
    canUseTool: async (t) => ({ behavior: 'deny', message: `${t} not allowed in smoke` }),
  });
  bus.register(s);
  return s;
}

const A = await makeAgent(
  'ai-engineer',
  'Background: you build ML/AI products. You have been burned by self-hosting vector infrastructure at scale (index rebuilds, memory pressure), so you lean toward managed services like Pinecone. You are honest about their costs.',
);
const B = await makeAgent(
  'data-engineer',
  "Background: you own the company Postgres fleet. You strongly prefer consolidating on Postgres (pgvector): no new vendor, no new billing, data stays put. You are honest about pgvector's scale limits.",
);

// Escalations (brief §5) are answered by this user proxy, max twice.
const CANNED_ANSWER =
  'Write pattern: bulk initial load (~2M embeddings), then continuous trickle upserts around 50k/day with occasional import spikes. Read-heavy overall (~99% reads). Now finalize the decision with your teammate, record it with record_decision, and send it to "user".';
let answered = 0;

const t0 = Date.now();
bus.deliver({
  from: 'user',
  to: 'ai-engineer',
  content:
    'Team decision needed: pgvector or Pinecone as the vector store for our product? Context: startup, ~2M embeddings today, projected ~50M in 2 years, 3-person infra team, cost-sensitive, Postgres already in our stack. Negotiate with data-engineer using the decision protocol; when you both agree, record the decision and send it to "user".',
});

const deadline = Date.now() + 600_000;
let stagnantSince = null;
while (Date.now() < deadline && pairCount() < 14) {
  await new Promise((r) => setTimeout(r, 2_000));
  const pendingQuestion = userMsgs.length > answered && store.decisions.length === 0 && answered < 2;
  if (pendingQuestion && bus.idle()) {
    const q = userMsgs[userMsgs.length - 1];
    console.log(`[user-proxy] answering escalation from ${q.from}`);
    answered += 1;
    bus.deliver({ from: 'user', to: q.from, content: CANNED_ANSWER });
    continue;
  }
  // Decision recorded and the post-decision report reached the user: done.
  if (store.decisions.length > 0 && userMsgs.length > answered && bus.idle()) break;
  if (bus.idle()) {
    stagnantSince ??= Date.now();
    if (Date.now() - stagnantSince > 20_000) {
      console.log('[smoke] bus idle 20s — stopping');
      break;
    }
  } else {
    stagnantSince = null;
  }
}
await bus.drain(120_000).catch((e) => console.log(`drain: ${e.message}`));
await Promise.allSettled([A.close(), B.close()]);

console.log('\n================ TRANSCRIPT ================');
for (const m of bus.log) {
  console.log(`\n--- ${m.from} -> ${m.to} (+${(((m.at ?? t0) - t0) / 1000).toFixed(1)}s) ---`);
  console.log(m.content);
}
console.log('\n================ METRICS ================');
const kabulA = bus.log.some((m) => m.from === 'ai-engineer' && m.to === 'data-engineer' && m.content.includes('KABUL'));
const kabulB = bus.log.some((m) => m.from === 'data-engineer' && m.to === 'ai-engineer' && m.content.includes('KABUL'));
console.log(`decisions recorded: ${store.decisions.length}`);
if (store.decisions[0]) console.log(JSON.stringify(store.decisions[0], null, 2));
console.log(`pair messages: ${pairCount()} | KABUL: A=${kabulA} B=${kabulB} | user msgs: ${userMsgs.length}`);
console.log(`duration ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`ai-engineer   turns=${A.usage.turns} out=${A.usage.out} | data-engineer turns=${B.usage.turns} out=${B.usage.out}`);

const reloaded = new DecisionStore(OUT);
const pass =
  store.decisions.length === 1 &&
  reloaded.decisions.length === 1 &&
  kabulA &&
  kabulB &&
  userMsgs.length > 0;
console.log(pass ? 'SMOKE-DECISION PASS' : 'SMOKE-DECISION FAIL');
process.exit(pass ? 0 : 1);
