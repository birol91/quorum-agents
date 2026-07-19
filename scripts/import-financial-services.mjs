// Import anthropics/financial-services agents into the marketplace catalog.
// The repo ships plugins/**/agents/*.md in the standard Claude Code subagent
// format; we re-emit them into .claude/agents with quorum_* marketplace keys
// (same convention as import-agents.mjs), prefixed "finance--".
//
// Note: their frontmatter `tools:` lines reference vendor MCP servers
// (factset, daloopa, …) the user may not have; Quorum ignores that field —
// tool access is governed by the permission broker, not the agent file.
//
// Usage: node scripts/import-financial-services.mjs <path-to-cloned-repo>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[2];
if (!REPO) {
  console.error('usage: node scripts/import-financial-services.mjs <path-to-cloned-financial-services-repo>');
  process.exit(1);
}
const OUT = join(HERE, '..', '.claude', 'agents');
mkdirSync(OUT, { recursive: true });

const yamlEscape = (s) => {
  const v = (s || '').replace(/[\r\n]+/g, ' ').trim();
  return /[:#'"[\]{}]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
};

const files = execSync(`find ${JSON.stringify(join(REPO, 'plugins'))} -path '*/agents/*.md'`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort();

let n = 0;
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const fmEnd = raw.startsWith('---') ? raw.indexOf('\n---', 3) : -1;
  if (fmEnd === -1) continue;
  const front = raw.slice(3, fmEnd);
  const body = raw.slice(fmEnd + 4).trim();
  const name = front.match(/^name:\s*"?(.+?)"?\s*$/m)?.[1]?.trim();
  const desc = front.match(/^description:\s*"?(.+?)"?\s*$/m)?.[1]?.trim() ?? '';
  const model = front.match(/^model:\s*(\S+)\s*$/m)?.[1];
  if (!name) continue;

  const lines = [
    '---',
    `name: ${yamlEscape(name)}`,
    `description: ${yamlEscape(desc)}`,
    ...(model ? [`model: ${model}`] : []),
    'quorum_source: finance',
    'quorum_category: financial-services',
    `quorum_prompt_len: ${body.length}`,
    '---',
    '',
    body,
    '',
  ];
  writeFileSync(join(OUT, `finance--${name}.md`), lines.join('\n'));
  n++;
}
console.log(`imported ${n} finance agents into ${OUT}`);
