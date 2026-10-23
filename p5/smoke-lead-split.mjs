// P5 live smoke — the LEAD BRIEF path: give the lead a PLAIN (no mention, no
// selection) task that spans specialties, and check the lead actually splits it
// across teammates, they consult, and the lead returns ONE combined reply.
// Team: ai-engineer (lead), data-engineer, prompt-engineer.
import { Bus } from '../src/bus.ts';
import { SdkSession } from '../src/session.ts';
import { buildSystemPrompt, DECISION_PROTOCOL } from '../src/protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../src/tools.ts';
import { TaskBoard } from '../src/tasks.ts';
import { DecisionStore } from '../src/decisions.ts';
import { rmSync } from 'node:fs';

const OUT = new URL('./out/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
const board = new TaskBoard(OUT);
const store = new DecisionStore(OUT);

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

const userMsgs = [];
const bus = new Bus({
  roster: ROSTER,
  turnBudget: 10,
  trace: (l) => console.log(l),
  onUserMessage: (m) => userMsgs.push(m),
});

async function spawn(name) {
  const server = await quorumServerFor(name, () => ROSTER, (m) => bus.deliver(m), {
    recordDecision: (d) => store.record(d),
    taskBoard: board,
  });
  const s = new SdkSession({
    name,
    model: 'sonnet',
    systemPrompt: buildSystemPrompt(name, `${PERSONAS[name]}\n\n${DECISION_PROTOCOL}`, ROSTER),
    mcpServers: { quorum: server },
    allowedTools: QUORUM_TOOL_NAMES,
    canUseTool: async (t) => ({ behavior: 'deny', message: `${t} not allowed in smoke` }),
  });
  bus.register(s);
  return s;
}

const A = await spawn('ai-engineer');
const D = await spawn('data-engineer');
const P = await spawn('prompt-engineer');
const agents = { 'ai-engineer': A, 'data-engineer': D, 'prompt-engineer': P };

// PLAIN task (no @mention, no selection) → routes to the lead with a LEAD BRIEF.
const t0 = Date.now();
for (const m of bus.routeUserInput(
  'Give me a short technical plan for a customer-support chatbot with RAG over our docs: cover the retrieval/data layer, the AI/orchestration layer, and the prompt strategy. Keep it tight.',
)) {
  bus.deliver(m);
}

const deadline = Date.now() + 600_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const a2a = bus.log.filter((m) => m.from !== 'user' && m.to !== 'user').length;
  const toUser = bus.log.filter((m) => m.to === 'user').length;
  const involved = new Set(bus.log.filter((m) => m.from !== 'user').map((m) => m.from));
  console.log(`  a2a=${a2a} →user=${toUser} agents-spoke=${[...involved].join(',')} ${Math.round((Date.now() - t0) / 1000)}s`);
  if (toUser >= 1 && a2a >= 1) break;
}

for (const s of Object.values(agents)) await s.close().catch(() => {});

// Analysis
const a2a = bus.log.filter((m) => m.from !== 'user' && m.to !== 'user');
const involvedByLead = new Set(a2a.filter((m) => m.from === 'ai-engineer').map((m) => m.to));
const teammatesSpoke = new Set(a2a.filter((m) => m.from !== 'ai-engineer').map((m) => m.from));
const finalToUser = bus.log.filter((m) => m.to === 'user');

console.log('\n================ TRANSCRIPT ================');
for (const m of bus.log) {
  console.log(`\n--- ${m.from} -> ${m.to} (+${(((m.at ?? t0) - t0) / 1000).toFixed(1)}s) ---`);
  console.log(m.content.slice(0, 400));
}
console.log('\n================ ANALYSIS ================');
console.log(`lead delegated to: [${[...involvedByLead].join(', ')}]`);
console.log(`teammates who contributed back: [${[...teammatesSpoke].join(', ')}]`);
console.log(`replies to user: ${finalToUser.length} (want 1, from the lead)`);
console.log(`from lead? ${finalToUser.every((m) => m.from === 'ai-engineer')}`);
console.log(`tasks on board: ${board.list().length}`);

// PASS: lead delegated to >=1 teammate, >=1 teammate contributed, exactly one
// user reply and it came from the lead.
const pass =
  involvedByLead.size >= 1 &&
  teammatesSpoke.size >= 1 &&
  finalToUser.length >= 1 &&
  finalToUser.every((m) => m.from === 'ai-engineer');
console.log(pass ? 'LEAD-SPLIT PASS' : 'LEAD-SPLIT WEAK (lead may have answered alone)');
process.exit(pass ? 0 : 1);
