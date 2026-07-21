import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeam, saveTeam, type Team } from '../src/main/team.ts';

const dir = mkdtempSync(join(tmpdir(), 'quorum-team-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('saveTeam/loadTeam roundtrip keeps composition and per-agent settings', () => {
  const team: Team = {
    project: 'demo',
    members: [
      { name: 'a', desc: 'agent a', persona: 'p-a', model: 'sonnet', effort: 'xhigh', lead: true, permissionMode: 'both' },
      { name: 'b', desc: 'agent b', persona: 'p-b', model: 'haiku', effort: 'low', lead: false, permissionMode: 'read' },
    ],
  };
  const file = join(dir, '.quorum', 'team.json'); // saveTeam creates the dir
  saveTeam(file, team);
  assert.deepEqual(loadTeam(file), team);
});

test('loadTeam defaults: model haiku, not lead, write permissions, empty members ok', () => {
  const file = join(dir, 'team.json');
  saveTeam(file, { project: 'defaults', members: [] });
  assert.deepEqual(loadTeam(file).members, []);

  saveTeam(file, {
    project: 'defaults',
    members: [{ name: 'x', desc: 'dx', persona: 'px' } as Team['members'][0]],
  });
  const m = loadTeam(file).members[0]!;
  assert.equal(m.model, 'haiku');
  assert.equal(m.effort, 'high');
  assert.equal(m.lead, false);
  assert.equal(m.permissionMode, 'write');
});
