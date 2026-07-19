// Generate .claude/agents/*.md from AgentBoard's catalog.json (367 agents:
// wshobson + automotive). Each agent's role/rules live in its own .md system
// prompt (per the design decision) — no separate CLAUDE.md per agent. File
// names are prefixed by source and disambiguated on name collision.
//
// Marketplace metadata (quorum_source / quorum_category / quorum_prompt_len) is
// added to the frontmatter as custom keys; Claude Code core ignores them.
//
// Usage: node scripts/import-agents.mjs [path-to-catalog.json]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = process.argv[2];
if (!CATALOG) {
  console.error('usage: node scripts/import-agents.mjs <path-to-catalog.json>');
  process.exit(1);
}
const OUT = join(HERE, '..', '.claude', 'agents');
mkdirSync(OUT, { recursive: true });

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
const yamlEscape = (s) => {
  const v = (s || '').replace(/[\r\n]+/g, ' ').trim();
  return /[:#'"[\]{}]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
};

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const agents = catalog.agents ?? [];

const nameCounts = new Map();
for (const a of agents) {
  const n = a.frontmatter?.name ?? '';
  nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
}
const dups = new Set([...nameCounts].filter(([, c]) => c > 1).map(([n]) => n));

const usedFiles = new Set();
let written = 0;
for (const a of agents) {
  const fm = a.frontmatter ?? {};
  const name = fm.name || 'unnamed';
  const srcShort = (a.source || '').startsWith('wshobson') ? 'wshobson' : 'automotive';
  const body = (a.systemPrompt || '').trim();

  let base = slug(name);
  if (dups.has(name)) base += `--${slug(a.plugin)}`;
  let fname = `${srcShort}--${base}.md`;
  let k = 2;
  while (usedFiles.has(fname)) fname = `${srcShort}--${base}-${k++}.md`;
  usedFiles.add(fname);

  const lines = ['---', `name: ${yamlEscape(name)}`, `description: ${yamlEscape(fm.description)}`];
  if (fm.model && fm.model !== 'inherit') lines.push(`model: ${fm.model}`);
  lines.push(`quorum_source: ${srcShort}`);
  lines.push(`quorum_category: ${yamlEscape(a.plugin)}`);
  lines.push(`quorum_prompt_len: ${body.length}`);
  lines.push('---');
  writeFileSync(join(OUT, fname), lines.join('\n') + '\n\n' + body + '\n');
  written++;
}

const files = readdirSync(OUT).filter((f) => f.endsWith('.md'));
console.log(`wrote ${written} agents to ${OUT}`);
console.log(`  wshobson: ${files.filter((f) => f.startsWith('wshobson--')).length}`);
console.log(`  automotive: ${files.filter((f) => f.startsWith('automotive--')).length}`);
console.log(`  collisions disambiguated: ${dups.size}`);
