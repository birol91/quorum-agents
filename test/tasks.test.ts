import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskBoard } from '../src/tasks.ts';

const sample = {
  title: 'Write the auth module',
  description: 'JWT issuance + refresh',
  createdBy: 'lead',
};

test('addTask creates an open, unclaimed task with a monotonic id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-task-'));
  const board = new TaskBoard(dir);
  const { task, duplicate } = board.addTask(sample);

  assert.equal(duplicate, false);
  assert.equal(task.id, 'task-1');
  assert.equal(task.status, 'open');
  assert.equal(task.claimedBy, null);
  assert.ok(task.at);
  assert.equal(board.openTasks().length, 1);

  const jsonl = readFileSync(board.jsonlPath, 'utf8').trim().split('\n');
  assert.equal(jsonl.length, 1);
  const md = readFileSync(board.mdPath, 'utf8');
  assert.ok(md.includes('# Görevler'));
  assert.ok(md.includes('task-1'));
});

test('claim by A succeeds; a second claim by B fails as already-claimed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-task-'));
  const board = new TaskBoard(dir);
  const { task: { id } } = board.addTask(sample);

  const first = board.claimTask(id, 'agent-A');
  assert.ok(first.ok);
  if (first.ok) {
    assert.equal(first.task.status, 'claimed');
    assert.equal(first.task.claimedBy, 'agent-A');
  }

  const second = board.claimTask(id, 'agent-B');
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, 'already-claimed-by-agent-A');
});

test('only the claimer may complete: non-claimer fails, claimer succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-task-'));
  const board = new TaskBoard(dir);
  const { task: { id } } = board.addTask(sample);
  board.claimTask(id, 'agent-A');

  const wrong = board.completeTask(id, 'agent-B', 'done it');
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, 'not-your-task');

  const right = board.completeTask(id, 'agent-A', 'shipped the module');
  assert.ok(right.ok);
  assert.equal(board.list()[0]!.status, 'done');
  assert.equal(board.list()[0]!.result, 'shipped the module');
});

test('a new board on the same dir reloads tasks with their latest status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-task-'));
  const board = new TaskBoard(dir);
  const { task: a } = board.addTask(sample);
  const { task: b } = board.addTask({ ...sample, title: 'Second task' });
  board.claimTask(a.id, 'agent-A');
  board.completeTask(a.id, 'agent-A', 'ok');

  const reloaded = new TaskBoard(dir);
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.list()[0]!.id, a.id);
  assert.equal(reloaded.list()[0]!.status, 'done');
  assert.equal(reloaded.list()[0]!.claimedBy, 'agent-A');
  assert.equal(reloaded.list()[1]!.id, b.id);
  assert.equal(reloaded.list()[1]!.status, 'open');
});

test('addTask dedups an active same-title task instead of creating a duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-task-'));
  const board = new TaskBoard(dir);
  const first = board.addTask(sample);
  const dup = board.addTask({ ...sample, title: '  write the AUTH module ' }); // same title, different casing/space
  assert.equal(first.duplicate, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.task.id, first.task.id);
  assert.equal(board.list().length, 1);

  // Once the original is done, the title is free again.
  board.claimTask(first.task.id, 'agent-A');
  board.completeTask(first.task.id, 'agent-A', 'ok');
  const fresh = board.addTask(sample);
  assert.equal(fresh.duplicate, false);
  assert.equal(board.list().length, 2);
});

test('claiming a missing id reports no-such-task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-task-'));
  const board = new TaskBoard(dir);
  const r = board.claimTask('task-99', 'agent-A');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'no-such-task');
});
