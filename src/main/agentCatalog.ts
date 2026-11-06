import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CatalogAgent {
  name: string;
  description: string;
  model: string | null;
  source: string; // 'wshobson' | 'automotive' | 'local'
  category: string;
  promptLen: number;
  file: string; // basename in .claude/agents
}

// Minimal frontmatter parser: reads the leading --- ... --- block as key: value
// lines. Enough for our own generated files; not a general YAML parser.
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return out;
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    out[m[1]!] = v;
  }
  return out;
}

/** Read every .claude/agents/*.md and return marketplace metadata (no bodies). */
export function readAgentCatalog(agentsDir: string): CatalogAgent[] {
  if (!existsSync(agentsDir)) return [];
  const out: CatalogAgent[] = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const fm = parseFrontmatter(readFileSync(join(agentsDir, file), 'utf8'));
    if (!fm.name) continue;
    out.push({
      name: fm.name,
      description: fm.description ?? '',
      model: fm.model ?? null,
      source: fm.quorum_source ?? 'local',
      category: fm.quorum_category ?? '',
      promptLen: Number(fm.quorum_prompt_len ?? 0),
      file,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
