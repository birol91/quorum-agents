import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectClaudeMd, readProjectClaudeMd } from '../src/main/claudeMd.ts';
import { buildSystemPrompt, teamMemoryDigest } from '../src/protocol.ts';

const dir = mkdtempSync(join(tmpdir(), 'quorum-claudemd-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('ensureProjectClaudeMd scaffolds once and NEVER overwrites', () => {
  assert.equal(ensureProjectClaudeMd(dir, 'demo-proj'), true);
  const scaffolded = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(scaffolded.includes('# Project: demo-proj'));
  assert.ok(scaffolded.includes('Quorum'));

  writeFileSync(join(dir, 'CLAUDE.md'), '# my own rules\n');
  assert.equal(ensureProjectClaudeMd(dir, 'demo-proj'), false); // existing file wins
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# my own rules\n');
});

test('readProjectClaudeMd returns content, null when missing/empty, caps huge files', () => {
  assert.equal(readProjectClaudeMd(join(dir, 'nope')), null);
  assert.equal(readProjectClaudeMd(dir), '# my own rules');

  writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(40_000));
  const capped = readProjectClaudeMd(dir)!;
  assert.ok(capped.length < 40_000);
  assert.ok(capped.includes('[...CLAUDE.md truncated]'));
});

test('buildSystemPrompt injects project instructions for agents', () => {
  const roster = [{ name: 'a', desc: 'agent a' }];
  const withMd = buildSystemPrompt('a', 'persona', roster, '# my own rules');
  assert.ok(withMd.includes("## Project instructions (the project's CLAUDE.md"));
  assert.ok(withMd.includes('# my own rules'));
  // and stays out when the project has none
  assert.ok(!buildSystemPrompt('a', 'persona', roster).includes('Project instructions'));
});

test('teamMemoryDigest: decisions + active tasks in, done tasks out, empty -> undefined', () => {
  const digest = teamMemoryDigest(
    [{ topic: 'Vector store', decision: 'pgvector on dedicated HW', decidedBy: 'data-engineer', at: '2026-07-16T20:46:00Z' }],
    [
      { id: 'task-1', title: 'HNSW tuning', status: 'claimed', claimedBy: 'data-engineer' },
      { id: 'task-2', title: 'old work', status: 'done' },
    ],
  )!;
  assert.ok(digest.includes('[2026-07-16] Vector store: pgvector on dedicated HW (by data-engineer)'));
  assert.ok(digest.includes('task-1 [claimed] HNSW tuning (data-engineer)'));
  assert.ok(!digest.includes('old work'));
  assert.equal(teamMemoryDigest([], []), undefined);

  // digest lands in the system prompt under the Team memory section
  const prompt = buildSystemPrompt('a', 'p', [{ name: 'a', desc: 'x' }], undefined, digest);
  assert.ok(prompt.includes('## Team memory (persists across app restarts)'));
  assert.ok(prompt.includes('Vector store'));
});
