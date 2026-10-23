// E2 — persistence: a NEW process resumes E1's session via --resume.
// PASS: resumed session recalls the number from E1 (dead process's context survives).
import { spawnAgent, send, waitFor, isInit, isResult, saveLog, usageSummary, LOGS_DIR } from './lib.mjs';
import { readFileSync } from 'node:fs';

const prevId = readFileSync(LOGS_DIR + 'e1-session-id.txt', 'utf8').trim();
console.log(`Resuming session ${prevId} in a fresh process...`);

const s = spawnAgent('ping-agent', ['--strict-mcp-config', '--permission-mode', 'default', '--resume', prevId]);
const initP = waitFor(s, isInit, 120_000, 'init');
const r1P = waitFor(s, isResult, 300_000, 'result');
send(s, 'Earlier in this conversation I asked you to remember a number. Which number? Reply with exactly: RESUMED <number>');

const init = await initP;
console.log(`INIT  session_id=${init.session_id} (same as resumed: ${init.session_id === prevId})`);

const r1 = await r1P;
console.log(`TURN  subtype=${r1.subtype} ${usageSummary(r1)}`);
console.log(`TURN  text: ${r1.result}`);

saveLog('e2.jsonl', s.events);
const pass = r1.subtype === 'success' && /42/.test(r1.result ?? '');
console.log(pass ? 'E2 PASS' : 'E2 FAIL');
console.log(`Note: resumed session_id ${init.session_id === prevId ? 'PRESERVED' : 'CHANGED to ' + init.session_id}`);
s.child.stdin.end();
