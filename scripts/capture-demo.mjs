// Launch the app with live sessions, ask a contentious question, and capture a
// frame every ~2.5s while the negotiation unfolds. Frames → docs/demo/ for a GIF.
// Consumes quota (one run).
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAME_DIR = path.join(APP_DIR, 'scratch-frames');
fs.rmSync(FRAME_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAME_DIR, { recursive: true });
fs.rmSync(path.join(APP_DIR, 'example', '.quorum'), { recursive: true, force: true });
const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const env = { ...process.env, QUORUM_PROD: '1', QUORUM_PROJECT: path.join(APP_DIR, 'example') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: bin, args: [APP_DIR], env, timeout: 30_000 });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1360, height: 860 });
await page.waitForSelector('.app', { timeout: 15_000 });

// Auto-approve permission cards so nothing blocks.
const approver = setInterval(() => {
  page.$$('.perm .allow').then((b) => b.forEach((x) => x.click().catch(() => {}))).catch(() => {});
}, 800);

await page.waitForFunction(
  () => [...document.querySelectorAll('.block .dot')].every((d) => !d.classList.contains('offline')),
  { timeout: 60_000 },
).catch(() => {});

let n = 0;
const snap = async () => {
  await page.screenshot({ path: path.join(FRAME_DIR, `f${String(n++).padStart(3, '0')}.png`) });
};
await snap(); // online

await page.fill('.room input', 'Team decision: pgvector or Pinecone for our vector store? ~2M embeddings now, ~50M in 2 years, small cost-sensitive team, Postgres already in stack. Negotiate with your teammate and record the decision, then tell me.');
await page.click('.room button');

const t0 = Date.now();
while (Date.now() - t0 < 300_000) {
  await page.waitForTimeout(2500);
  await snap();
  const done = await page.evaluate(() => document.querySelectorAll('.decision').length);
  if (done > 0) {
    // capture a few more frames on the decided state, then stop
    for (let i = 0; i < 3; i++) { await page.waitForTimeout(1200); await snap(); }
    break;
  }
}
clearInterval(approver);
console.log(`captured ${n} frames to ${FRAME_DIR}`);
await app.close();
