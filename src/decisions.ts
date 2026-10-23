import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Decision {
  topic: string;
  decision: string;
  rationale: string;
  /** Recording agent — comes from the per-session closure, never from content. */
  decidedBy: string;
  at: string;
}

/**
 * Persistent decision record (brief §4.3 / §5). decisions.jsonl is the source
 * of truth (append-only, machine-readable); decisions.md is a rendered human
 * view regenerated on every write. Later sessions load the store from disk.
 */
export class DecisionStore {
  readonly dir: string;
  readonly decisions: Decision[] = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.jsonlPath)) {
      for (const line of readFileSync(this.jsonlPath, 'utf8').split('\n')) {
        if (line.trim()) this.decisions.push(JSON.parse(line) as Decision);
      }
    }
  }

  get jsonlPath(): string {
    return join(this.dir, 'decisions.jsonl');
  }

  get mdPath(): string {
    return join(this.dir, 'decisions.md');
  }

  record(d: Omit<Decision, 'at'>): Decision {
    const entry: Decision = { ...d, at: new Date().toISOString() };
    this.decisions.push(entry);
    appendFileSync(this.jsonlPath, JSON.stringify(entry) + '\n');
    writeFileSync(this.mdPath, this.render());
    return entry;
  }

  /** Permanently drop all decisions (empties the jsonl + md and memory). */
  clear(): void {
    this.decisions.length = 0;
    writeFileSync(this.jsonlPath, '');
    writeFileSync(this.mdPath, this.render());
  }

  render(): string {
    const blocks = this.decisions.map(
      (d) =>
        `## ${d.topic}\n\n- **Karar:** ${d.decision}\n- **Kaydeden:** ${d.decidedBy} · ${d.at}\n- **Gerekçe:** ${d.rationale}\n`,
    );
    return `# Kararlar\n\n> Bu dosya Quorum tarafından üretilir (\`record_decision\`). Elle düzenlemeyin.\n\n${blocks.join('\n')}`;
  }
}
