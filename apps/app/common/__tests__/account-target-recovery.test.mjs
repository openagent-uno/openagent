import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountAgentPresentation,
  accountLoopbackTarget,
  hasExplicitLoopbackTarget,
  withVerifiedAccountTarget,
} from '../account-target-recovery.ts';

const verifiedTarget = {
  network: 'trusted-network',
  handle: 'alice',
  agentHandle: 'my-agent',
};

test('fresh join persists a restartable target before WebSocket auth', () => {
  const preAuthAccount = withVerifiedAccountTarget({
    id: 'joined-account',
    name: 'Alice',
    network: '',
    handle: 'renderer-input',
    isLocal: false,
    createdAt: 1,
  }, verifiedTarget);

  // Simulate a crash before auth_ok: the serialized row already contains
  // everything both remembered and explicit restart paths require.
  const restarted = JSON.parse(JSON.stringify(preAuthAccount));
  assert.equal(hasExplicitLoopbackTarget(restarted), true);
  assert.deepEqual({
    accountId: restarted.id,
    network: restarted.network,
    handle: restarted.handle,
    agent: restarted.agentHandle,
  }, {
    accountId: 'joined-account',
    network: 'trusted-network',
    handle: 'alice',
    agent: 'my-agent',
  });
});

test('remembered invalid result repairs a crash placeholder for explicit password retry', () => {
  const placeholder = {
    id: 'joined-account',
    name: 'Alice',
    network: '',
    handle: 'alice',
    isLocal: false,
    createdAt: 1,
  };
  assert.equal(hasExplicitLoopbackTarget(placeholder), false);

  const repaired = withVerifiedAccountTarget(placeholder, verifiedTarget);
  assert.equal(hasExplicitLoopbackTarget(repaired), true);
  assert.equal(repaired.network, 'trusted-network');
  assert.equal(repaired.agentHandle, 'my-agent');
});

test('verified agent target is primary while a stale custom label remains an explicit alias', () => {
  assert.deepEqual(accountAgentPresentation({
    name: 'alice@personal — Friday',
    handle: 'alice',
    agentHandle: 'my-agent',
  }), {
    primary: 'my-agent',
    alias: 'Friday',
    verified: true,
  });
});

test('legacy rows remain visibly unverified until the coordinator pins a target', () => {
  assert.deepEqual(accountAgentPresentation({
    name: 'alice@personal — Friday',
    handle: 'alice',
  }), {
    primary: 'Friday',
    alias: null,
    verified: false,
  });
});

test('an explicit agent selection supplies routing for a legacy account', () => {
  assert.deepEqual(accountLoopbackTarget({
    id: 'saved-row',
    handle: 'alice',
    network: 'personal',
  }, '  my-agent  '), {
    accountId: 'saved-row',
    handle: 'alice',
    network: 'personal',
    agent: 'my-agent',
  });
});

test('account loopback routing retains a verified target without an override', () => {
  assert.equal(accountLoopbackTarget({
    id: 'saved-row',
    handle: 'alice',
    network: 'personal',
    agentHandle: 'friday',
  }).agent, 'friday');
});
