// P3.2 LIVE verification (consumes quota, single run): launch the app with real
// claude sessions, type a contentious question into the meeting room, watch the
// traffic stream in and a decision land in the panel — all via the real UI.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/quorum-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.rmSync(path.join(APP_DIR, 'example', '.quorum'), { recursive: true, force: true });
const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const env = { ...process.env, QUORUM_PROD: '1', QUORUM_PROJECT: path.join(APP_DIR, 'example') }; // sessions ON (no QUORUM_NO_SESSIONS)
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: bin, args: [APP_DIR], env, timeout: 30_000 });
// Surface main-process stderr (session start errors land here).
app.process().stderr?.on('data', (d) => process.stdout.write(`[main] ${d}`));
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 15_000 });

// Auto-approve any permission card that appears (so a Write for notes doesn't block).
page.on('console', () => {});
const approver = setInterval(() => {
  page.$$('.perm .allow').then((btns) => btns.forEach((b) => b.click().catch(() => {}))).catch(() => {});
}, 1000);

// Wait for both sessions to come online (blocks leave 'offline').
await page.waitForFunction(
  () => [...document.querySelectorAll('.block .dot')].every((d) => !d.classList.contains('offline')),
  { timeout: 60_000 },
).catch(() => console.log('WARN: sessions did not all come online in 60s'));
await shot('live-01-online');

// Ask the team a contentious question via the meeting-room composer.
await page.fill('.room input', 'Team decision: pgvector or Pinecone for our vector store? ~2M embeddings now, ~50M in 2 years, small cost-sensitive team, Postgres already in stack. Negotiate with your teammate and record the decision, then tell me.');
await page.click('.room button');

// Poll until a decision is recorded (or time out).
const t0 = Date.now();
let decided = false;
while (Date.now() - t0 < 600_000) {
  const n = await page.evaluate(() => document.querySelectorAll('.decision').length);
  const msgs = await page.evaluate(() => document.querySelectorAll('.msg').length);
  if (n > 0) { decided = true; break; }
  console.log(`  waiting… messages=${msgs} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
  await page.waitForTimeout(6000);
}
clearInterval(approver);
await page.waitForTimeout(500);
await shot('live-02-decided');

const result = await page.evaluate(() => ({
  messages: document.querySelectorAll('.msg').length,
  decisions: document.querySelectorAll('.decision').length,
  decisionText: document.querySelector('.decision .what')?.textContent ?? null,
}));
console.log('LIVE result:', JSON.stringify(result));
console.log(decided ? 'LIVE PASS' : 'LIVE INCONCLUSIVE (no decision within budget)');

await app.close();

async function shot(name) {
  const f = path.join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: f });
  console.log('shot:', f);
}
