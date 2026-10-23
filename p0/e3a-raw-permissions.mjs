// E3a — raw stream-json, NO pre-approved tools, --permission-mode default.
// Question: when the agent attempts Write/Bash, does the stream carry any
// permission event? Does the process hang, silently deny, or error?
// We only OBSERVE here — no undocumented channel would be used even if found (§3.6).
import { spawnAgent, send, waitFor, isResult, isInit, saveLog } from './lib.mjs';
import { existsSync, rmSync } from 'node:fs';

const TESTFILE = 'p0/logs/e3a-test.txt';
rmSync(TESTFILE, { force: true });

const s = spawnAgent('writer-agent', ['--strict-mcp-config', '--permission-mode', 'default']);
const initP = waitFor(s, isInit, 120_000, 'init');
const rP = waitFor(s, isResult, 240_000, 'result');
send(s, `Do these in order: 1) create a file named ${TESTFILE} with content "hello" using the Write tool; 2) run \`echo done\` using the Bash tool. Report the outcome of each.`);

await initP;
let outcome;
try {
  const r = await rP;
  outcome = `result subtype=${r.subtype}\ntext: ${r.result}`;
} catch (e) {
  outcome = `HANG/TIMEOUT: ${e.message}`;
  s.child.kill();
}

const types = [...new Set(s.events.map((e) => `${e.type}${e.subtype ? '/' + e.subtype : ''}`))];
console.log('Distinct event types seen:', types.join(', '));

// Surface tool_result payloads (arrive as user-role events) — this is where a
// denial message would show up.
for (const ev of s.events) {
  const content = ev.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block.type === 'tool_use') console.log(`TOOL_USE  ${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
    if (block.type === 'tool_result') console.log(`TOOL_RESULT is_error=${block.is_error} ${JSON.stringify(block.content).slice(0, 300)}`);
  }
}

console.log('---');
console.log(outcome);
console.log(`File created despite no permission: ${existsSync(TESTFILE)}`);
saveLog('e3a.jsonl', s.events);
s.child.stdin.end();
