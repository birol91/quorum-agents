// LIVE check (consumes quota): does @everyone broadcast actually produce
// COORDINATION, not each agent replying to the user in isolation? Launch the
// app, toggle @everyone on, send a splittable group task, and watch: agents
// should talk to each other and/or use the task board, and the lead should send
// the combined reply to the user.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/quorum-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.rmSync(path.join(APP_DIR, 'example', '.quorum'), { recursive: true, force: true });
const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const env = { ...process.env, QUORUM_PROD: '1', QUORUM_PROJECT: path.join(APP_DIR, 'example') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: bin, args: [APP_DIR], env, timeout: 30_000 });
app.process().stderr?.on('data', (d) => process.stdout.write(`[main] ${d}`));
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 15_000 });

const approver = setInterval(() => {
  page.$$('.perm .allow').then((b) => b.forEach((x) => x.click().catch(() => {}))).catch(() => {});
}, 800);

await page.waitForFunction(
  () => [...document.querySelectorAll('.block .dot')].every((d) => !d.classList.contains('offline')),
  { timeout: 60_000 },
).catch(() => console.log('WARN: not all online'));

// Turn broadcast ON, then send a splittable group task.
await page.evaluate(() => document.querySelector('.everyone-btn')?.click());
await page.fill('.room input', 'Draft a 2-item launch checklist for our product: one item about the announcement copy, one about picking a date. Split the work between you and give me a combined result.');
await page.click('.room button');

const readAll = () =>
  page.evaluate(() => [...document.querySelectorAll('.msg')].map((m) => ({
    from: m.querySelector('.from')?.textContent,
    to: m.querySelector('.to')?.textContent,
    body: m.querySelector('.body')?.textContent,
  })));

const t0 = Date.now();
let toUser = 0;
while (Date.now() - t0 < 420_000) {
  await page.waitForTimeout(5000);
  const msgs = await readAll();
  const agentToAgent = msgs.filter((m) => m.from !== 'user' && m.to !== 'user').length;
  toUser = msgs.filter((m) => m.to === 'user').length;
  console.log(`  msgs=${msgs.length} agent↔agent=${agentToAgent} →user=${toUser} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
  // Done once the lead has reported back to the user after some coordination.
  if (toUser >= 1 && agentToAgent >= 1) break;
  if (msgs.length >= 12) break;
}
clearInterval(approver);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(SHOT_DIR, 'broadcast-result.png') });

const final = await readAll();
const agentToAgent = final.filter((m) => m.from !== 'user' && m.to !== 'user').length;
const toUserMsgs = final.filter((m) => m.to === 'user');
console.log('\n=== TRAFFIC ===');
for (const m of final) console.log(`${m.from} → ${m.to}: ${(m.body || '').slice(0, 90)}`);
console.log(`\nagent↔agent messages: ${agentToAgent} (coordination happened if > 0)`);
console.log(`replies to user: ${toUserMsgs.length} (want 1 combined, from the lead)`);

// Read the task board too — did they split via add_task/claim_task?
const boardFile = path.join(APP_DIR, 'example', '.quorum', 'tasks.jsonl');
if (fs.existsSync(boardFile)) {
  const lines = fs.readFileSync(boardFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map();
  for (const t of lines) byId.set(t.id, t);
  console.log('\n=== TASK BOARD ===');
  for (const t of byId.values()) console.log(`${t.id} [${t.status}] "${t.title}" claimedBy=${t.claimedBy}`);
} else {
  console.log('\n(no task board file — agents coordinated by messaging, not the board)');
}

const coordinated = agentToAgent >= 1 && toUserMsgs.length >= 1;
console.log(coordinated ? 'BROADCAST-COORDINATION PASS' : 'BROADCAST-COORDINATION WEAK (agents may have answered in isolation)');
await app.close();
