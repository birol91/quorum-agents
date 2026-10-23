// Full live test: real 3-agent team in the actual Electron app. Give the lead a
// splittable task, auto-approve permission cards, capture frames + DOM state
// through the whole flow. Consumes quota.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOT = process.env.SCREENSHOT_DIR || '/tmp/quorum-shots';
fs.mkdirSync(SHOT, { recursive: true });
fs.rmSync(path.join(APP_DIR, 'example', '.quorum'), { recursive: true, force: true });
const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const env = { ...process.env, QUORUM_PROD: '1', QUORUM_PROJECT: path.join(APP_DIR, 'example') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: bin, args: [APP_DIR], env, timeout: 30_000 });
app.process().stderr?.on('data', (d) => process.stdout.write(`[main] ${d}`));
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 15_000 });

// Auto-approve any permission card (so a docx Write doesn't block).
const approver = setInterval(() => {
  page.$$('.perm .allow').then((b) => b.forEach((x) => x.click().catch(() => {}))).catch(() => {});
}, 700);

const snap = async (name) => { await page.screenshot({ path: path.join(SHOT, name + '.png') }); };
const dom = () =>
  page.evaluate(() => ({
    busy: [...document.querySelectorAll('.block')].filter((b) => b.className.includes('busy')).map((b) => b.querySelector('.name')?.textContent),
    activities: [...document.querySelectorAll('.block .activity')].map((a) => a.textContent),
    msgs: document.querySelectorAll('.msg:not(.working)').length,
    a2a: [...document.querySelectorAll('.msg:not(.working)')].filter((m) => {
      const f = m.querySelector('.from')?.textContent, t = m.querySelector('.to')?.textContent;
      return f !== 'user' && t !== 'user';
    }).length,
    toUser: [...document.querySelectorAll('.msg:not(.working)')].filter((m) => m.querySelector('.to')?.textContent === 'user').length,
    decisions: document.querySelectorAll('.decision').length,
  }));

console.log('waiting for 3 agents to come online…');
await page.waitForFunction(
  () => [...document.querySelectorAll('.block .dot')].filter((d) => !d.classList.contains('offline')).length >= 3,
  { timeout: 90_000 },
).catch(() => console.log('WARN: not all 3 online in 90s'));
await snap('live3-01-online');
console.log('online:', JSON.stringify(await dom()));

// The user's exact Turkish task — asks them to consult ("birbirlerine danışsınlar"),
// which must now trigger MANDATORY cross-consultation.
await page.fill('.room input',
  "Bir RAG ürünü için 'kendi sunucunda pgvector vs yönetilen bir vektör DB (Pinecone/Weaviate)' karşılaştırma özeti hazırla. Hem veri/altyapı açısını hem de LLM-retrieval-kalitesi/prompt açısını ele al. İşi ekibe böl, birbirlerine danışsınlar, bana tek birleşik özet ver.");
await page.click('.room button');
console.log('task sent to lead (Turkish, consult required).');

const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 600_000) {
  await page.waitForTimeout(6000);
  const d = await dom();
  const line = `t=${Math.round((Date.now() - t0) / 1000)}s busy=[${d.busy}] a2a=${d.a2a} →user=${d.toUser} act=${JSON.stringify(d.activities)}`;
  if (line !== last) { console.log('  ' + line); last = line; }
  // Stop once the lead has replied to the user (we analyze consultation after).
  if (d.toUser >= 1 && d.a2a >= 3) { await snap('live3-02-done'); break; }
}
clearInterval(approver);
await page.waitForTimeout(500);
await snap('live3-03-final');

const final = await dom();
const roster = await page.evaluate(() => [...document.querySelectorAll('.block .name')].map((n) => n.textContent));
// Read the meeting-room traffic to check data-engineer ↔ prompt-engineer actually talked.
const traffic = await page.evaluate(() =>
  [...document.querySelectorAll('.msg:not(.working)')].map((m) => ({
    from: m.querySelector('.from')?.textContent,
    to: m.querySelector('.to')?.textContent,
  })));
const pairs = new Set(traffic.filter((t) => t.from !== 'user' && t.to !== 'user').map((t) => `${t.from}->${t.to}`));

console.log('\n================ RESULT ================');
console.log('roster on canvas:', JSON.stringify(roster));
console.log('agent→agent pairs seen:', JSON.stringify([...pairs]));
console.log('final DOM:', JSON.stringify(final));
const leadDelegatedBoth =
  pairs.has('ai-engineer->data-engineer') && pairs.has('ai-engineer->prompt-engineer');
// THE key check this run: did the two non-lead teammates message EACH OTHER?
const teammatesTalked =
  pairs.has('data-engineer->prompt-engineer') || pairs.has('prompt-engineer->data-engineer');
console.log('lead delegated to BOTH teammates:', leadDelegatedBoth);
console.log('teammates consulted EACH OTHER directly:', teammatesTalked);
console.log('lead replied to user:', final.toUser >= 1);
// Pass requires the cross-consultation the user asked for.
console.log(leadDelegatedBoth && teammatesTalked && final.toUser >= 1 ? 'CONSULT-TEST PASS' : 'CONSULT-TEST FAIL (teammates did not consult)');

await app.close();
