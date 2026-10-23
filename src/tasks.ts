import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'claimed' | 'done';
  /** Claiming agent — set on claim, cleared to null while open. */
  claimedBy: string | null;
  createdBy: string;
  at: string;
  claimedAt?: string;
  doneAt?: string;
  result?: string;
}

export type ClaimResult = { ok: true; task: Task } | { ok: false; reason: string };
export type CompleteResult = { ok: true } | { ok: false; reason: string };
export type AddResult = { task: Task; duplicate: boolean };

const normalizeTitle = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Shared task board (brief §4.3 / §12). tasks.jsonl is the source of truth —
 * but unlike decisions it is a *log of states*, not immutable records, so the
 * in-memory Task objects mutate and each mutation appends a fresh snapshot line
 * (last-writer-wins on reload by id). tasks.md is a rendered human view
 * regenerated on every write. The claim path is atomic (open → claimed only):
 * that is the whole point — two agents can't both pick up the same work.
 */
export class TaskBoard {
  readonly dir: string;
  readonly tasks: Task[] = [];

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.jsonlPath)) {
      const byId = new Map<string, Task>();
      for (const line of readFileSync(this.jsonlPath, 'utf8').split('\n')) {
        if (line.trim()) {
          const t = JSON.parse(line) as Task;
          byId.set(t.id, t);
        }
      }
      // Insertion order of the Map follows the id's first appearance, which is
      // its creation order — so the board reloads in the order tasks were added.
      for (const t of byId.values()) this.tasks.push(t);
    }
  }

  get jsonlPath(): string {
    return join(this.dir, 'tasks.jsonl');
  }

  get mdPath(): string {
    return join(this.dir, 'tasks.md');
  }

  addTask(d: { title: string; description: string; createdBy: string }): AddResult {
    // Dedup: if a still-active task (open or claimed) has the same title, don't
    // create a second one — two agents broadcasting the same split shouldn't
    // double-create work. Return the existing task instead.
    const key = normalizeTitle(d.title);
    const existing = this.tasks.find((t) => t.status !== 'done' && normalizeTitle(t.title) === key);
    if (existing) return { task: existing, duplicate: true };

    // Monotonic id from the current count — deterministic, no clock/random.
    const task: Task = {
      id: `task-${this.tasks.length + 1}`,
      title: d.title,
      description: d.description,
      status: 'open',
      claimedBy: null,
      createdBy: d.createdBy,
      at: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.persist(task);
    return { task, duplicate: false };
  }

  claimTask(id: string, agent: string): ClaimResult {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return { ok: false, reason: 'no-such-task' };
    // Atomic guard: only an 'open' task can be claimed. A claimed/done task is
    // already spoken for — report who has it so the caller can move on.
    if (task.status !== 'open') return { ok: false, reason: `already-claimed-by-${task.claimedBy}` };
    task.status = 'claimed';
    task.claimedBy = agent;
    task.claimedAt = new Date().toISOString();
    this.persist(task);
    return { ok: true, task };
  }

  completeTask(id: string, agent: string, result: string): CompleteResult {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return { ok: false, reason: 'no-such-task' };
    if (task.status !== 'claimed') return { ok: false, reason: 'not-claimed' };
    // Only the claimer may complete — identity comes from the closure, not content.
    if (task.claimedBy !== agent) return { ok: false, reason: 'not-your-task' };
    task.status = 'done';
    task.doneAt = new Date().toISOString();
    task.result = result;
    this.persist(task);
    return { ok: true };
  }

  openTasks(): Task[] {
    return this.tasks.filter((t) => t.status === 'open');
  }

  list(): Task[] {
    return this.tasks;
  }

  /** Append the task's current state and re-render the human view. */
  private persist(task: Task): void {
    appendFileSync(this.jsonlPath, JSON.stringify(task) + '\n');
    writeFileSync(this.mdPath, this.render());
  }

  render(): string {
    const rows = this.tasks.map((t) => {
      const who = t.claimedBy ?? '—';
      return `| ${t.id} | ${t.title} | ${t.status} | ${who} |`;
    });
    const table = ['| ID | Başlık | Durum | Üstlenen |', '| --- | --- | --- | --- |', ...rows].join('\n');
    return `# Görevler\n\n> Bu dosya Quorum tarafından üretilir (\`claim_task\`/\`complete_task\`). Elle düzenlemeyin.\n\n${table}\n`;
  }
}
