// P1 live smoke 1 — roadmap criterion: "no message to a busy agent is lost".
// Fire 3 user messages at one agent instantly; 2 must queue behind the first
// turn and all 3 must be answered, in order.
import { Bus } from '../src/bus.ts';
import { SdkSession } from '../src/session.ts';
import { buildSystemPrompt } from '../src/protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../src/tools.ts';

const ROSTER = [{ name: 'echo-agent', desc: 'transport test agent', lead: true }];

const userInbox = [];
const waiters = [];
const bus = new Bus({
  roster: ROSTER,
  trace: (line) => console.log(line),
  onUserMessage: (m) => {
    userInbox.push(m);
    waiters.splice(0).forEach((f) => f());
  },
});

const session = new SdkSession({
  name: 'echo-agent',
  systemPrompt: buildSystemPrompt(
    'echo-agent',
    'Background: transport test. When a message asks you to ACK a number, send exactly "ACK <number>" to "user" via send_message. Nothing else.',
    ROSTER,
  ),
  mcpServers: { quorum: await quorumServerFor('echo-agent', () => ROSTER, (m) => bus.deliver(m)) },
  allowedTools: QUORUM_TOOL_NAMES,
  canUseTool: async (t) => ({ behavior: 'deny', message: `${t} not allowed in smoke` }),
});
bus.register(session);

const t0 = Date.now();
for (const n of [1, 2, 3]) bus.deliver({ from: 'user', to: 'echo-agent', content: `ACK ${n} please` });

const deadline = Date.now() + 300_000;
while (userInbox.length < 3 && Date.now() < deadline) {
  await new Promise((r) => {
    waiters.push(r);
    setTimeout(r, 5_000);
  });
}
await bus.drain(60_000).catch((e) => console.log(`drain: ${e.message}`));
await session.close();

console.log('---');
console.log(`replies (${Date.now() - t0} ms):`, userInbox.map((m) => m.content));
console.log(`usage: turns=${session.usage.turns} in=${session.usage.in} out=${session.usage.out}`);
const pass =
  userInbox.length === 3 && [1, 2, 3].every((n, i) => userInbox[i].content.includes(String(n)));
console.log(pass ? 'SMOKE-QUEUE PASS' : 'SMOKE-QUEUE FAIL');
process.exit(pass ? 0 : 1);
