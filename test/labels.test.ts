import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userChannelName } from '../src/shared/ipc.ts';

// The 'user' channel has two real faces, and the label has to tell them
// apart in BOTH directions: composer traffic never crosses the bridge, so
// calling a reply to it "Team Lead" misstates where the answer went.
test('user channel: composer traffic is you, in both directions', () => {
  assert.equal(userChannelName('composer'), 'you');
});

test('user channel: bridge traffic is the Team Lead', () => {
  assert.equal(userChannelName('bridge'), 'Team Lead');
});

test('user channel: an unmarked message defaults to the Team Lead', () => {
  // Older messages carry no `via`; the bridge was the only user channel then.
  assert.equal(userChannelName(undefined), 'Team Lead');
});
