// One-shot P3 UI verification: launch (no live sessions), screenshot the empty
// board, inject synthetic events (message arrow, permission card, decision),
// screenshot again. No quota consumed.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/quorum-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const bin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const args = process.platform === 'darwin' ? [APP_DIR] : ['--no-sandbox', APP_DIR];
// ELECTRON_RUN_AS_NODE forces Electron to run as plain Node (no GUI, require
// 'electron' returns a path string) — strip it so the app boots as a GUI.
const env = { ...process.env, QUORUM_NO_SESSIONS: '1', QUORUM_PROD: '1', QUORUM_PROJECT: path.join(APP_DIR, 'example') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: bin, args, env, timeout: 30_000 });
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 15_000 });
await page.waitForTimeout(800);

const shot = async (n) => {
  const f = path.join(SHOT_DIR, n + '.png');
  await page.screenshot({ path: f });
  console.log('shot:', f);
};
const emit = (e) => page.evaluate((s) => window.__quorumApply?.(JSON.parse(s)), JSON.stringify(e));

await shot('01-empty');

const blocks = await page.evaluate(() => document.querySelectorAll('.block').length);
console.log('blocks rendered:', blocks);

// Simulate a live exchange.
await emit({ type: 'agentState', name: 'ai-engineer', state: 'busy', usage: { in: 40, out: 120, turns: 1 } });
await emit({ type: 'message', message: { from: 'user', to: 'ai-engineer', content: 'pgvector or Pinecone for our vector store?', at: Date.now() } });
await emit({ type: 'message', message: { from: 'ai-engineer', to: 'data-engineer', content: 'ÖNERİ: Pinecone — managed, no ops burden at 50M scale.', at: Date.now() } });
await emit({ type: 'agentState', name: 'data-engineer', state: 'busy', usage: { in: 42, out: 90, turns: 1 } });
await emit({ type: 'message', message: { from: 'data-engineer', to: 'ai-engineer', content: 'İTİRAZ: dedicated pgvector instance handles this — no new vendor.', at: Date.now() } });
await emit({ type: 'permissionRequest', request: { id: 'perm-1', agent: 'data-engineer', toolName: 'Write', input: { file_path: 'notes/sizing.md', content: '...' } } });
await emit({ type: 'decision', decision: { topic: 'Vector store', decision: 'Dedicated Postgres + pgvector (HNSW); Pinecone as documented fallback.', rationale: 'Ops consolidation; write rate is a trickle.', decidedBy: 'data-engineer', at: new Date().toISOString() } });
await page.waitForTimeout(500);
await shot('02-active');

const summary = await page.evaluate(() => ({
  blocks: document.querySelectorAll('.block').length,
  busy: document.querySelectorAll('.block.busy').length,
  arrows: document.querySelectorAll('.canvas-svg path').length,
  perms: document.querySelectorAll('.perm').length,
  decisions: document.querySelectorAll('.decision').length,
  messages: document.querySelectorAll('.msg').length,
}));
console.log('DOM summary:', JSON.stringify(summary));

// Live activity indicator: a busy agent shows what it's doing + a spinner.
await emit({ type: 'agentActivity', name: 'ai-engineer', activity: 'delegating to a subagent…' });
await page.waitForTimeout(200);
const activityUI = await page.evaluate(() => ({
  blockActivity: document.querySelector('.block .activity')?.textContent ?? null,
  spinner: !!document.querySelector('.block .activity .spinner'),
  roomWorking: [...document.querySelectorAll('.msg.working')].map((w) => w.textContent),
}));
console.log('activity UI:', JSON.stringify(activityUI));

// Envelope hiding: a [LEAD BRIEF] message should show only the USER TASK text.
await emit({
  type: 'message',
  message: {
    from: 'user',
    to: 'ai-engineer',
    content: '[LEAD BRIEF] You are the lead. blah blah teammates list blah. USER TASK: plan the launch',
    at: Date.now(),
  },
});
await page.waitForTimeout(200);
const envelope = await page.evaluate(() => {
  const bodies = [...document.querySelectorAll('.msg .body')].map((b) => b.textContent);
  return {
    hasBriefBoilerplate: bodies.some((t) => t.includes('[LEAD BRIEF]') || t.includes('You are the lead')),
    hasCleanTask: bodies.some((t) => t.trim() === 'plan the launch'),
  };
});
console.log('envelope hidden:', JSON.stringify(envelope));

// Two-way traffic: inject A→B and B→A now, expect TWO travelling dot groups
// and the A–B mesh line to glow (violet stroke).
const now = Date.now();
await emit({ type: 'message', message: { from: 'ai-engineer', to: 'data-engineer', content: 'ping', at: now } });
await emit({ type: 'message', message: { from: 'data-engineer', to: 'ai-engineer', content: 'pong', at: now } });
await page.waitForTimeout(300);
const dots = await page.evaluate(() => ({
  // each dot group = outer circle + white core; count outer circles (r=5)
  dotGroups: [...document.querySelectorAll('.canvas-svg circle')].filter((c) => c.getAttribute('r') === '5').length,
  activeLines: [...document.querySelectorAll('.canvas-svg line')].filter((l) => l.getAttribute('stroke') === 'var(--violet)').length,
}));
await shot('09-dots');
await page.waitForTimeout(4500);
const dotsLater = await page.evaluate(() => document.querySelectorAll('.canvas-svg circle[r="5"]').length);
console.log(`dots: two-way=${dots.dotGroups} (expect 2), active-lines>=1=${dots.activeLines >= 1}, after-TTL=${dotsLater}`);

// P3.2 drag: move ai-engineer's block ~150px right and verify layout persisted.
const before = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.block')].find((b) => b.textContent.includes('ai-engineer'));
  const r = el.getBoundingClientRect();
  return { x: r.x + 20, y: r.y + 20 };
});
await page.mouse.move(before.x, before.y);
await page.mouse.down();
await page.mouse.move(before.x + 150, before.y + 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);

// P3.2 thread: click an agent->agent message; non-thread messages should dim.
await page.evaluate(() => {
  const msg = [...document.querySelectorAll('.msg.clickable')][0];
  msg?.click();
});
await page.waitForTimeout(300);
await shot('03-thread-and-drag');

const p32 = await page.evaluate(() => ({
  threadChip: !!document.querySelector('.thread-clear'),
  dimmedMsgs: [...document.querySelectorAll('.msg')].filter((m) => parseFloat(getComputedStyle(m).opacity) < 0.5).length,
}));
console.log('P3.2:', JSON.stringify(p32));

// --- New features: inspector (model + permissions), clear, room resize ---

// Double-click a block → inspector opens; switch model + permission mode.
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.block')].find((b) => b.textContent.includes('ai-engineer'));
  el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await page.waitForSelector('.inspector', { timeout: 5000 });
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.inspector .seg button')];
  btns.find((b) => b.textContent.trim() === 'opus')?.click();
  btns.find((b) => b.textContent.includes('read only'))?.click();
});
await page.waitForTimeout(300);
await shot('04-inspector');
const inspectorState = await page.evaluate(() => {
  const on = [...document.querySelectorAll('.inspector .seg button.on')].map((b) => b.textContent.trim());
  return on;
});
// Lead role controls: ai-engineer is lead → its inspector shows "Remove lead".
const leadInspector = await page.evaluate(() => {
  const btn = document.querySelector('.role-btn');
  return { label: btn?.textContent, disabled: btn?.disabled, isLead: btn?.classList.contains('is-lead') };
});
await page.evaluate(() => document.querySelector('.inspector .x')?.click());
await page.waitForTimeout(150);
// data-engineer is NOT lead (a lead exists) → its "Make lead" must be locked.
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.block')].find((b) => b.textContent.includes('data-engineer'));
  el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await page.waitForSelector('.inspector', { timeout: 5000 });
const lockedInspector = await page.evaluate(() => {
  const btn = document.querySelector('.role-btn');
  const remove = document.querySelector('.remove-btn');
  return { label: btn?.textContent, disabled: btn?.disabled, hasRemove: !!remove };
});
await shot('08-inspector-role');
await page.evaluate(() => document.querySelector('.inspector .x')?.click());
await page.waitForTimeout(150);
console.log('lead inspector (ai-engineer):', JSON.stringify(leadInspector));
console.log('locked inspector (data-engineer):', JSON.stringify(lockedInspector));

const modelTag = await page.evaluate(
  () => [...document.querySelectorAll('.block')].find((b) => b.textContent.includes('ai-engineer'))?.querySelector('.model-tag')?.textContent,
);

// Room resize: drag the resizer up by 100px, expect the room to grow.
const beforeH = await page.evaluate(() => document.querySelector('.room').getBoundingClientRect().height);
const rz = await page.evaluate(() => {
  const r = document.querySelector('.room-resizer').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(rz.x, rz.y);
await page.mouse.down();
await page.mouse.move(rz.x, rz.y - 100, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
const afterH = await page.evaluate(() => document.querySelector('.room').getBoundingClientRect().height);

// Clear decisions (a decision was injected earlier). window.confirm auto-accept.
await page.evaluate(() => { window.confirm = () => true; });
await page.evaluate(() => document.querySelector('.clear-btn')?.click());
await page.waitForTimeout(300);
const decisionsAfterClear = await page.evaluate(() => document.querySelectorAll('.decision').length);
await shot('05-after-clear-resize');

console.log('inspector selected:', JSON.stringify(inspectorState), '| block model tag:', modelTag);
console.log(`room resize: ${Math.round(beforeH)} -> ${Math.round(afterH)}px`);
console.log('decisions after clear:', decisionsAfterClear);

// @everyone broadcast toggle: on → composer gets .broadcasting, button relabels.
await page.evaluate(() => document.querySelector('.everyone-btn')?.click());
await page.waitForTimeout(150);
const broadcastState = await page.evaluate(() => ({
  btnOn: document.querySelector('.everyone-btn')?.classList.contains('on'),
  composerBroadcasting: !!document.querySelector('.composer.broadcasting'),
  sendLabel: document.querySelector('.composer button')?.textContent,
}));
console.log('@everyone toggle:', JSON.stringify(broadcastState));
// Turn broadcast back off so it doesn't interfere with selection tests.
await page.evaluate(() => document.querySelector('.everyone-btn.on')?.click());

// Marketplace: open, count agents, search "safety" narrows across fields.
await page.evaluate(() => document.querySelector('.market-btn')?.click());
await page.waitForSelector('.marketplace', { timeout: 5000 });
await page.waitForTimeout(400);
const mkTotal = await page.evaluate(() => document.querySelectorAll('.mk-card').length);
await page.fill('.mk-search', 'safety');
await page.waitForTimeout(300);
const mkSafety = await page.evaluate(() => ({
  cards: document.querySelectorAll('.mk-card').length,
  allMatch: [...document.querySelectorAll('.mk-card')].every((c) => c.textContent.toLowerCase().includes('safety')) ,
}));
// Automotive tab: clear search, click the automotive tab, expect only automotive cards.
await page.fill('.mk-search', '');
await page.waitForTimeout(200);
await page.evaluate(() => [...document.querySelectorAll('.mk-tabs button')].find((b) => b.textContent.includes('automotive'))?.click());
await page.waitForTimeout(300);
const autoTab = await page.evaluate(() => ({
  sections: [...document.querySelectorAll('.mk-section h3')].map((h) => h.textContent.trim().split(' ')[0]),
  cards: document.querySelectorAll('.mk-card').length,
}));
await shot('06-marketplace-automotive');
await page.evaluate(() => document.querySelector('.marketplace .x')?.click());
await page.waitForTimeout(200);
console.log(`marketplace: shown=${mkTotal} cards, "safety"→${mkSafety.cards} cards, allMatch=${mkSafety.allMatch}`);
console.log(`automotive tab: sections=${JSON.stringify(autoTab.sections)} cards=${autoTab.cards}`);

// Canvas multi-select is lasso-only now: drag a rectangle over both blocks.
const box = await page.evaluate(() => {
  const bs = [...document.querySelectorAll('.block')].map((b) => b.getBoundingClientRect());
  return {
    minX: Math.min(...bs.map((b) => b.x)) - 20,
    minY: Math.min(...bs.map((b) => b.y)) - 20,
    maxX: Math.max(...bs.map((b) => b.x + b.width)) + 20,
    maxY: Math.max(...bs.map((b) => b.y + b.height)) + 20,
  };
});
await page.mouse.move(box.minX, box.minY);
await page.mouse.down();
await page.mouse.move(box.maxX, box.maxY, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const selState = await page.evaluate(() => ({
  selectedBlocks: document.querySelectorAll('.block.selected').length,
  bar: document.querySelector('.selection-bar')?.textContent ?? null,
}));
await shot('07-selection');
console.log('selection:', JSON.stringify(selState));

// Full-mesh connection lines: 2 agents → 1 static link line.
const meshLines = await page.evaluate(() => document.querySelectorAll('.canvas-svg line').length);
console.log(`mesh links (2 agents → expect 1): ${meshLines}`);

// Single click on a block should NOT select it anymore (lasso-only).
await page.evaluate(() => document.querySelector('.selection-bar button')?.click()); // clear first
await page.waitForTimeout(100);
const c = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.block')].find((b) => b.textContent.includes('ai-engineer'));
  const r = el.getBoundingClientRect();
  return { x: r.x + 20, y: r.y + 12 };
});
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(150);
const afterClick = await page.evaluate(() => document.querySelectorAll('.block.selected').length);
console.log(`single-click selects (expect 0): ${afterClick}`);

// Lasso: clear selection, drag a rectangle over both blocks on empty canvas.
await page.evaluate(() => document.querySelector('.selection-bar button')?.click());
await page.waitForTimeout(100);
const canvasBox = await page.evaluate(() => {
  const r = document.querySelector('.canvas').getBoundingClientRect();
  const blocks = [...document.querySelectorAll('.block')].map((b) => b.getBoundingClientRect());
  const minX = Math.min(...blocks.map((b) => b.x)) - 20;
  const minY = Math.min(...blocks.map((b) => b.y)) - 20;
  const maxX = Math.max(...blocks.map((b) => b.x + b.width)) + 20;
  const maxY = Math.max(...blocks.map((b) => b.y + b.height)) + 20;
  return { minX, minY, maxX, maxY, canvasTop: r.y };
});
// Start the lasso on empty canvas above the blocks, drag across both.
await page.mouse.move(canvasBox.minX, canvasBox.minY);
await page.mouse.down();
await page.mouse.move(canvasBox.maxX, canvasBox.maxY, { steps: 10 });
await page.waitForTimeout(100);
const lassoDuring = await page.evaluate(() => !!document.querySelector('.lasso'));
await page.mouse.up();
await page.waitForTimeout(150);
const lassoSel = await page.evaluate(() => document.querySelectorAll('.block.selected').length);
console.log(`lasso: rect-shown=${lassoDuring}, selected ${lassoSel} blocks`);

// Clear selection first, then verify @everyone marks ALL blocks selected.
await page.evaluate(() => document.querySelector('.selection-bar button')?.click());
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('.everyone-btn:not(.on)')?.click());
await page.waitForTimeout(200);
const everyoneSel = await page.evaluate(() => ({
  blocks: document.querySelectorAll('.block').length,
  selected: document.querySelectorAll('.block.selected').length,
}));
console.log(`@everyone selects all: ${everyoneSel.selected}/${everyoneSel.blocks} blocks`);
await page.evaluate(() => document.querySelector('.everyone-btn.on')?.click()); // turn off

// Clear layout: block was dragged earlier (ai-engineer moved). Click Clear layout,
// then verify the saved layout.json is emptied.
await page.evaluate(() => document.querySelector('.layout-btn')?.click());
await page.waitForTimeout(300);

await app.close();

// Layout cleared on disk?
const layoutFileC = path.join(APP_DIR, 'example', '.quorum', 'layout.json');
const afterClear = fs.existsSync(layoutFileC) ? fs.readFileSync(layoutFileC, 'utf8').trim() : 'MISSING';
console.log(`layout after clear: ${afterClear} (expect {})`);

// Layout persisted to disk by the saveLayout IPC handler?
const layoutFile = path.join(APP_DIR, 'example', '.quorum', 'layout.json');
const persisted = fs.existsSync(layoutFile) ? JSON.parse(fs.readFileSync(layoutFile, 'utf8')) : null;
console.log('layout.json:', persisted ? JSON.stringify(persisted) : 'MISSING');
console.log('done');
