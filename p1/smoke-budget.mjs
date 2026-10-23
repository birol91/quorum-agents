// P1 live smoke 2 — roadmap criterion: "an 8+ message chain gets a bus note".
// Budget lowered to 4 to keep the run cheap: two stubborn agents debate
// tabs-vs-spaces; the note must be injected into the 4th pair message in a
// real stream. Post-note behavior (do they converge?) is observed and reported.
import { Bus } from '../src/bus.ts';
import { SdkSession } from '../src/session.ts';
import { buildSystemPrompt, DECISION_PROTOCOL } from '../src/protocol.ts';
import { quorumServerFor, QUORUM_TOOL_NAMES } from '../src/tools.ts';

const ROSTER = [
  { name: 'tab-fan', desc: 'engineer who champions tabs', lead: true },
  { name: 'space-fan', desc: 'engineer who champions spaces' },
];

let noteAtPairCount = null;
const userMsgs = [];
const bus = new Bus({
  roster: ROSTER,
  turnBudget: 4,
  trace: (line) => console.log(line),
  onNote: () => {
    noteAtPairCount = pairCount();
  },
  onUserMessage: (m) => userMsgs.push(m),
});
const pairCount = () => bus.log.filter((m) => m.from !== 'user' && m.to !== 'user').length;

async function makeAgent(name, persona) {
  const s = new SdkSession({
    name,
    systemPrompt: buildSystemPrompt(name, `${persona}\n\n${DECISION_PROTOCOL}`, ROSTER),
    mcpServers: { quorum: await quorumServerFor(name, () => ROSTER, (m) => bus.deliver(m)) },
    allowedTools: QUORUM_TOOL_NAMES,
    canUseTool: async (t) => ({ behavior: 'deny', message: `${t} not allowed in smoke` }),
    onEvent: (msg) => {
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content ?? []) {
          if (b.type === 'text') console.log(`  [${name}] TEXT: ${b.text.slice(0, 120)}`);
          if (b.type === 'tool_use') console.log(`  [${name}] TOOL: ${b.name}`);
        }
      }
      if (msg.type === 'result') console.log(`  [${name}] turn end (${msg.subtype})`);
    },
  });
  bus.register(s);
  return s;
}

const STUBBORN =
  'You are deliberately stubborn in debates: you find most counterarguments unconvincing, keep raising fresh İTİRAZ points, and concede only under strong pressure.';
const A = await makeAgent(
  'tab-fan',
  `Background: you strongly believe tabs are right for the monorepo (accessibility: readers set their own width; smaller files). ${STUBBORN}`,
);
const B = await makeAgent(
  'space-fan',
  `Background: you strongly believe spaces are right for the monorepo (identical rendering everywhere; alignment never breaks). ${STUBBORN}`,
);

const t0 = Date.now();
bus.deliver({
  from: 'user',
  to: 'tab-fan',
  content:
    'Team decision: tabs or spaces for our monorepo? Debate with space-fan using the decision protocol and send the final decision to "user" when you both agree.',
});

const deadline = Date.now() + 480_000;
let stagnantSince = null;
while (userMsgs.length === 0 && pairCount() < 12 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2_000));
  // Conversation died (everyone idle, no traffic): stop early instead of
  // burning the full deadline.
  if (bus.idle()) {
    stagnantSince ??= Date.now();
    if (Date.now() - stagnantSince > 15_000) {
      console.log('[smoke] bus idle with no traffic for 15s — conversation ended');
      break;
    }
  } else {
    stagnantSince = null;
  }
}
await bus.drain(120_000).catch((e) => console.log(`drain: ${e.message}`));
await Promise.allSettled([A.close(), B.close()]);

console.log('\n---');
console.log(`pair messages: ${pairCount()}, note injected at: ${noteAtPairCount ?? 'NEVER'}`);
console.log(`decision to user: ${userMsgs.length > 0 ? 'yes' : 'no'}`);
if (userMsgs[0]) console.log(`\n${userMsgs[0].from}: ${userMsgs[0].content}`);
console.log(`\nduration ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`tab-fan   turns=${A.usage.turns} out=${A.usage.out} | space-fan turns=${B.usage.turns} out=${B.usage.out}`);

const pass = noteAtPairCount === 4;
console.log(pass ? 'SMOKE-BUDGET PASS' : 'SMOKE-BUDGET FAIL');
process.exit(pass ? 0 : 1);
