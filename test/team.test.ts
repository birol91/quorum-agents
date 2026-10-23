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

test('loadTeam defaults: sonnet / medium / both, not lead, empty members ok', () => {
  const file = join(dir, 'team.json');
  saveTeam(file, { project: 'defaults', members: [] });
  assert.deepEqual(loadTeam(file).members, []);

  saveTeam(file, {
    project: 'defaults',
    members: [{ name: 'x', desc: 'dx', persona: 'px' } as Team['members'][0]],
  });
  const m = loadTeam(file).members[0]!;
  // Measured defaults (see the brief): sonnet over haiku because a silent
  // turn delivers nothing and costs more than a slower turn; medium because
  // effort is inert on haiku but real on sonnet; both because a permission
  // prompt stalls the whole team until a human notices it.
  assert.equal(m.model, 'sonnet');
  assert.equal(m.effort, 'medium');
  assert.equal(m.lead, false);
  assert.equal(m.permissionMode, 'both');
});
