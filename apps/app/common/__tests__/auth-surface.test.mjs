import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const loginScreen = readFileSync(
  new URL('../../universal/app/index.tsx', import.meta.url),
  'utf8',
);
const switcher = readFileSync(
  new URL('../../universal/components/AgentSwitcher.tsx', import.meta.url),
  'utf8',
);
const accountPanel = readFileSync(
  new URL('../../universal/components/AgentAccountPanel.tsx', import.meta.url),
  'utf8',
);

test('cold start and the in-app switcher render the same account panel', () => {
  assert.match(loginScreen, /import AgentAccountPanel from ['"]\.\.\/components\/AgentAccountPanel['"]/);
  assert.match(switcher, /import AgentAccountPanel from ['"]\.\/AgentAccountPanel['"]/);
  assert.match(loginScreen, /<AgentAccountPanel\s+[\s\S]*?mode="connect"/);
  assert.match(switcher, /<AgentAccountPanel\s+[\s\S]*?mode=\{isElectron \? 'open-window' : 'connect'\}/);

  // These belonged to the duplicated legacy login implementation. Keeping
  // them out of the route prevents the two account surfaces drifting apart.
  assert.doesNotMatch(loginScreen, /type Mode = 'signin' \| 'join'/);
  assert.doesNotMatch(loginScreen, /Your networks/);
  assert.doesNotMatch(loginScreen, /Join with invite/);
});

test('the shared account panel owns list, add-agent and reduced-motion transitions', () => {
  assert.match(accountPanel, /\{adding \? 'Add an agent' : 'Your agents'\}/);
  assert.match(accountPanel, /<Animated\.View style=\{animateStyle\}>/);
  assert.match(accountPanel, /Animated\.timing\(transition/);
  assert.match(accountPanel, /duration: reduceMotion \? 0 : 180/);
  assert.match(accountPanel, /\[adding, signInId, passwordId, retryId, reduceMotion, transition\]/);
  assert.match(accountPanel, /label="Add an agent"/);
});
