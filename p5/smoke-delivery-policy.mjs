// P5 live smoke — mode-aware delivery policy (2026-07-16):
//   single target -> the addressed agent answers the user itself (no lead relay)
//   group task    -> EACH participant answers exactly once (bus-enforced budget)
// Team: ai-engineer (lead), data-engineer, prompt-engineer — live sonnet sessions.
import { Bus } from '../src/bus.ts';
import { SdkSession } from '../src/session.ts';
import { buildSystemPrompt, DECISION_PROTOCOL } from '../src/protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../src/tools.ts';
import { TaskBoard } from '../src/tasks.ts';
import { DecisionStore } from '../src/decisions.ts';
import { rmSync } from 'node:fs';

const OUT = new URL('./out/delivery/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });

const ROSTER = [
  { name: 'ai-engineer', desc: 'ML/AI systems engineer; RAG, agents, vector search', lead: true },
  { name: 'data-engineer', desc: 'Data infra engineer; owns the Postgres fleet & pipelines' },
  { name: 'prompt-engineer', desc: 'Prompt engineering; chain-of-thought, system prompts, LLM optimization' },
];
const PERSONAS = {
  'ai-engineer': 'You build ML/AI products end to end (RAG, agent orchestration, vector search integration).',
  'data-engineer': 'You own data infrastructure: Postgres, ingestion pipelines, vector storage, retrieval performance.',
  'prompt-engineer': 'You design prompts and LLM interaction strategies: chain-of-thought, system-prompt structure, eval.',
};

async function runScenario({ key, text, selected = [], expectRepliers, deadlineMs = 360_000 }) {
  console.log(`\n############ ${key} ############`);
  const board = new TaskBoard(`${OUT}${key}/`);
  const store = new DecisionStore(`${OUT}${key}/`);
  const delivered = []; // messages that actually REACHED the user
  const bounced = [];
  const bus = new Bus({
    roster: ROSTER.map((r) => ({ ...r })),
    turnBudget: 10,
    trace: (l) => console.log(l),
    onUserMessage: (m) => delivered.push(m),
    onDrop: (m, reason) => reason === 'user-reply-budget' && bounced.push(m.from),
  });

  const sessions = [];
  for (const r of ROSTER) {
    const server = await quorumServerFor(r.name, () => bus.roster, (m) => bus.deliver(m), {
      recordDecision: (d) => store.record(d),
      taskBoard: board,
    });
    const s = new SdkSession({
      name: r.name,
      model: 'sonnet',
      systemPrompt: buildSystemPrompt(r.name, `${PERSONAS[r.name]}\n\n${DECISION_PROTOCOL}`, bus.roster),
      mcpServers: { quorum: server },
      allowedTools: QUORUM_TOOL_NAMES,
      canUseTool: async (t) => ({ behavior: 'deny', message: `${t} not allowed in smoke` }),
    });
    bus.register(s);
    sessions.push(s);
  }

  const t0 = Date.now();
  for (const m of bus.routeUserInput(text, selected)) bus.deliver(m);

  const deadline = t0 + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const who = [...new Set(delivered.map((m) => m.from))];
    console.log(`  [${key}] delivered=${delivered.length} by=[${who.join(',')}] bounced=${bounced.length} ${Math.round((Date.now() - t0) / 1000)}s`);
    if (expectRepliers.every((n) => who.includes(n))) break;
  }
  await bus.drain(90_000).catch(() => {});
  for (const s of sessions) await s.close().catch(() => {});

  console.log(`\n---- ${key}: messages the user actually received ----`);
  for (const m of delivered) {
    console.log(`\n· ${m.from} (+${(((m.at ?? t0) - t0) / 1000).toFixed(0)}s): ${m.content.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  return { key, delivered, bounced, elapsed: Math.round((Date.now() - t0) / 1000) };
}

const results = [];

results.push(await runScenario({
  key: 'SINGLE-TARGET',
  text: '@data-engineer In one short paragraph: for ~5M vectors in pgvector, HNSW or IVFFlat, and why?',
  expectRepliers: ['data-engineer'],
}));

results.push(await runScenario({
  key: 'GROUP-SELECTED',
  text: 'Between the two of you, agree on the 3 metadata fields we store next to each embedding row and how the retrieval prompt references them — then each of you report your own part.',
  selected: ['data-engineer', 'prompt-engineer'],
  expectRepliers: ['data-engineer', 'prompt-engineer'],
}));

results.push(await runScenario({
  key: 'GROUP-EVERYONE',
  text: '@everyone From your own specialty: name the single biggest risk in our RAG support-chatbot plan. Converge on where you overlap, then each report your own angle.',
  expectRepliers: ['ai-engineer', 'data-engineer', 'prompt-engineer'],
}));

console.log('\n\n================ VERDICTS ================');
let allPass = true;
for (const r of results) {
  const byAgent = {};
  for (const m of r.delivered) byAgent[m.from] = (byAgent[m.from] ?? 0) + 1;
  let pass;
  if (r.key === 'SINGLE-TARGET') {
    // The addressed agent answered the user itself; nobody else got through.
    pass = (byAgent['data-engineer'] ?? 0) >= 1 && Object.keys(byAgent).every((n) => n === 'data-engineer');
  } else {
    // Every participant delivered EXACTLY one reply; non-participants none.
    const participants = r.key === 'GROUP-SELECTED'
      ? ['data-engineer', 'prompt-engineer']
      : ['ai-engineer', 'data-engineer', 'prompt-engineer'];
    pass = participants.every((n) => byAgent[n] === 1) && Object.keys(byAgent).every((n) => participants.includes(n));
  }
  allPass &&= pass;
  console.log(`${r.key}: delivered=${JSON.stringify(byAgent)} bounced-from=[${r.bounced.join(', ')}] ${r.elapsed}s -> ${pass ? 'PASS' : 'FAIL'}`);
}
console.log(allPass ? '\nDELIVERY-POLICY SMOKE: ALL PASS' : '\nDELIVERY-POLICY SMOKE: FAIL');
process.exit(allPass ? 0 : 1);
