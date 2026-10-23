import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionStore } from '../src/decisions.ts';

const sample = {
  topic: 'Vector store',
  decision: 'pgvector on a dedicated instance',
  rationale: 'ops consolidation + write rate is a trickle',
  decidedBy: 'data-engineer',
};

test('record appends to jsonl and renders md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-dec-'));
  const store = new DecisionStore(dir);
  const entry = store.record(sample);

  assert.equal(store.decisions.length, 1);
  assert.ok(entry.at);
  const jsonl = readFileSync(store.jsonlPath, 'utf8').trim().split('\n');
  assert.equal(jsonl.length, 1);
  assert.equal(JSON.parse(jsonl[0]!).topic, 'Vector store');
  const md = readFileSync(store.mdPath, 'utf8');
  assert.ok(md.includes('## Vector store'));
  assert.ok(md.includes('pgvector on a dedicated instance'));
  assert.ok(md.includes('data-engineer'));
});

test('a new store on the same dir reloads persisted decisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-dec-'));
  new DecisionStore(dir).record(sample);
  const reloaded = new DecisionStore(dir);
  assert.equal(reloaded.decisions.length, 1);
  assert.equal(reloaded.decisions[0]!.decision, sample.decision);
});

test('multiple decisions render in recording order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-dec-'));
  const store = new DecisionStore(dir);
  store.record({ ...sample, topic: 'First' });
  store.record({ ...sample, topic: 'Second' });
  const md = readFileSync(store.mdPath, 'utf8');
  assert.ok(md.indexOf('## First') < md.indexOf('## Second'));
  assert.equal(new DecisionStore(dir).decisions.length, 2);
});
