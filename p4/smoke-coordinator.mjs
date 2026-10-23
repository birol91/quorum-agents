// P4 live smoke — coordinator pattern with the shared task board:
// a coordinator splits a job into two tasks (add_task); two workers each claim
// (claim_task) a DISTINCT task — no double work — and complete it. PASS: 2 done
// tasks, each claimed by a different worker.
import { Bus } from '../src/bus.ts';
import { SdkSession } from '../src/session.ts';
import { buildSystemPrompt } from '../src/protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../src/tools.ts';
import { TaskBoard } from '../src/tasks.ts';
import { rmSync } from 'node:fs';

const OUT = new URL('./out/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
const board = new TaskBoard(OUT);

const ROSTER = [
  { name: 'coordinator', desc: 'Splits work into tasks and reports results', lead: true },
  { name: 'worker-a', desc: 'Does tasks from the board' },
  { name: 'worker-b', desc: 'Does tasks from the board' },
];

const TASK_RULES =
  '\n\n## Task board\n- add_task(title, description) puts work on the shared board.\n' +
  '- list_tasks shows open/claimed tasks. Always claim_task(id) BEFORE working (this prevents a teammate duplicating it), then complete_task(id, result) when done.\n' +
  '- Never work on a task you did not successfully claim. Be terse.';

const agents = new Map();
const bus = new Bus({ roster: ROSTER, onUserMessage: () => {}, onNote: () => {}, trace: (l) => console.log(l) });

async function spawn(name, persona) {
  const server = await quorumServerFor(name, () => ROSTER, (m) => bus.deliver(m), { taskBoard: board });
  const s = new SdkSession({
    name,
    model: 'haiku',
    systemPrompt: buildSystemPrompt(name, persona + TASK_RULES, ROSTER),
    mcpServers: { quorum: server },
    allowedTools: QUORUM_TOOL_NAMES,
    canUseTool: async (t) => ({ behavior: 'deny', message: `${t} not allowed in smoke` }),
  });
  agents.set(name, s);
  bus.register(s);
  return s;
}

await Promise.all([
  spawn(
    'coordinator',
    'You coordinate a small team. Split the user\'s job into exactly two independent tasks via add_task, then send_message worker-a and worker-b, each telling them to check the board and claim a task. When both report done, send the combined result to "user".',
  ),
  spawn('worker-a', 'You are a worker. When told to check the board: list_tasks, claim ONE open task, do it (invent a short plausible result), complete_task it, then send_message the coordinator what you finished.'),
  spawn('worker-b', 'You are a worker. When told to check the board: list_tasks, claim ONE open task, do it (invent a short plausible result), complete_task it, then send_message the coordinator what you finished.'),
]);

// Deliver the kickoff to the coordinator (the lead) via the bus routing.
for (const m of bus.routeUserInput(
  'Prepare a short product launch checklist. Split it into a "write launch copy" task and a "pick a launch date" task, have worker-a and worker-b each claim and do one, then give me the combined result.',
)) {
  bus.deliver(m);
}

const deadline = Date.now() + 420_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const summary = board.list().map((t) => `${t.id}:${t.status}${t.claimedBy ? '/' + t.claimedBy : ''}`).join(' ');
  console.log(`  board: ${summary || '(empty)'}`);
  if (board.list().filter((t) => t.status === 'done').length >= 2) break;
}

for (const s of agents.values()) await s.close().catch(() => {});

const tasks = board.list();
const done = tasks.filter((t) => t.status === 'done');
const claimers = new Set(done.map((t) => t.claimedBy));
console.log('\n=== TASK BOARD ===');
for (const t of tasks) console.log(`${t.id} [${t.status}] "${t.title}" by=${t.claimedBy} :: ${(t.result || '').slice(0, 70)}`);
console.log('bus messages:', bus.log.length);
// No double work: distinct claimers for distinct done tasks.
const pass = done.length >= 2 && claimers.size === done.length;
console.log(pass ? 'P4 PASS' : 'P4 INCONCLUSIVE');
process.exit(pass ? 0 : 1);
