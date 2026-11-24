import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findWindowForVerifiedTarget,
  verifiedLoopbackTargetsEqual,
} from '../../../dist/network/agent-window-routing.js';

const beta = {
  networkName: 'personal',
  networkId: 'network-1',
  handle: 'alice',
  coordinatorNodeId: 'coordinator-1',
  agentHandle: 'my-agent',
  agentNodeId: 'agent-node-1',
};

test('same verified target reuses a window even when account ids or labels differ', () => {
  const personalAgentLabelledAccountWindow = { id: 41, accountId: 'legacy-personal-agent-row' };
  const found = findWindowForVerifiedTarget(beta, [
    { value: personalAgentLabelledAccountWindow, target: { ...beta } },
  ]);
  assert.equal(found, personalAgentLabelledAccountWindow);
});

test('nearby targets never collide', () => {
  assert.equal(verifiedLoopbackTargetsEqual(beta, {
    ...beta,
    agentNodeId: 'agent-node-2',
  }), false);
  assert.equal(findWindowForVerifiedTarget(beta, [
    { value: { id: 42 }, target: { ...beta, handle: 'bob' } },
  ]), null);
});
test('unknown targets cannot trigger label/account-id based reuse', () => {
  assert.equal(findWindowForVerifiedTarget(null, [
    { value: { id: 43 }, target: beta },
  ]), null);
});
