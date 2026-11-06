// E1 — one process, multiple user turns over stream-json.
// PASS: session_id in init; turn 2 handled by the SAME process and recalls turn 1.
import { spawnAgent, send, waitFor, isInit, isResult, saveLog, usageSummary, LOGS_DIR } from './lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const s = spawnAgent('ping-agent', ['--strict-mcp-config', '--permission-mode', 'default']);
const initP = waitFor(s, isInit, 120_000, 'init');
const r1P = waitFor(s, isResult, 300_000, 'result#1');
send(s, 'Remember the number 42. Reply with exactly: PONG-1');

const init = await initP;
console.log(`INIT  session_id=${init.session_id} model=${init.model} pid=${s.child.pid}`);

const r1 = await r1P;
console.log(`TURN1 subtype=${r1.subtype} ${usageSummary(r1)}`);
console.log(`TURN1 text: ${r1.result}`);

const r2P = waitFor(s, isResult, 300_000, 'result#2');
send(s, 'What number did I ask you to remember? Reply with exactly: PONG-2 <number>');
const r2 = await r2P;
console.log(`TURN2 subtype=${r2.subtype} ${usageSummary(r2)}`);
console.log(`TURN2 text: ${r2.result}`);
console.log(`TURN2 session_id=${r2.session_id} (same as init: ${r2.session_id === init.session_id})`);

mkdirSync(LOGS_DIR, { recursive: true });
writeFileSync(LOGS_DIR + 'e1-session-id.txt', init.session_id);
saveLog('e1.jsonl', s.events);

const pass = r2.subtype === 'success' && /42/.test(r2.result ?? '') && r2.session_id === init.session_id;
console.log(pass ? 'E1 PASS' : 'E1 FAIL');
s.child.stdin.end();
