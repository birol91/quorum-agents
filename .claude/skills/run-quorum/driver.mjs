// Playwright REPL driver for Claude Quorum (Electron). macOS/Linux.
// Wrap in tmux; send-keys commands; capture-pane output. Screenshots -> SCREENSHOT_DIR.
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/quorum-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;

const electronBin =
  process.platform === 'darwin'
    ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(APP_DIR, 'node_modules/electron/dist/electron');

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    // QUORUM_NO_SESSIONS=1 -> render roster/panels without spawning claude (no quota).
    // Strip ELECTRON_RUN_AS_NODE so Electron boots as a GUI, not plain Node.
    const env = { ...process.env, QUORUM_NO_SESSIONS: process.env.QUORUM_NO_SESSIONS ?? '1', QUORUM_PROD: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronBin,
      args: process.platform === 'darwin' ? [APP_DIR] : ['--no-sandbox', APP_DIR],
      env,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 15_000 });
    console.log('launched.', app.windows().length, 'windows');
  },
  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },
  // Inject a synthetic QuorumEvent into the renderer store (demo/verify only).
  async emit(json) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((s) => {
      const fn = window.__quorumApply;
      if (!fn) return 'NO_HOOK';
      fn(JSON.parse(s));
      return 'OK';
    }, json);
    console.log('emit →', r);
  },
  async type(text) { if (page) await page.keyboard.type(text, { delay: 20 }); },
  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; }, sel);
    console.log('click', sel, '→', r);
  },
  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },
  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });
rl.on('line', async (line) => {
  const idx = line.indexOf(' ');
  const cmd = (idx === -1 ? line : line.slice(0, idx)).trim();
  const arg = idx === -1 ? '' : line.slice(idx + 1);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) { console.log('unknown:', cmd); return rl.prompt(); }
  try { await fn(arg); } catch (e) { console.log('ERROR:', e.message); }
  if (cmd === 'quit') { rl.close(); process.exit(0); }
  rl.prompt();
});
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });
console.log('quorum driver — "help", "launch"');
rl.prompt();
