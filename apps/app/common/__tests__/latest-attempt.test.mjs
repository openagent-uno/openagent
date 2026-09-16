import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestAttemptGate } from '../latest-attempt.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('latest connection wins and an older out-of-order result is cleaned up', async () => {
  const gate = createLatestAttemptGate();
  const a = deferred();
  const b = deferred();
  const cleaned = [];
  let active = null;

  const connect = async (account, pending) => {
    const attempt = gate.begin(account);
    const port = await pending.promise;
    return attempt.settle(
      () => {
        active = { account, port };
        return 'committed';
      },
      () => {
        cleaned.push({ account, port });
        return 'stale';
      },
    );
  };

  const first = connect('A', a);
  const second = connect('B', b);
  b.resolve(8082);
  assert.equal(await second, 'committed');
  a.resolve(8081);
  assert.equal(await first, 'stale');

  assert.deepEqual(active, { account: 'B', port: 8082 });
  assert.deepEqual(cleaned, [{ account: 'A', port: 8081 }]);
  assert.equal(gate.currentTarget(), 'B');
});

test('attempt tokens are isolated per renderer/store gate', () => {
  const primaryWindow = createLatestAttemptGate();
  const agentWindow = createLatestAttemptGate();
  const primaryAttempt = primaryWindow.begin('A');
  const agentAttempt = agentWindow.begin('B');

  primaryWindow.begin('C');
  assert.equal(primaryAttempt.isCurrent(), false);
  assert.equal(agentAttempt.isCurrent(), true);
  assert.equal(agentWindow.currentTarget(), 'B');
});

test('a generic connection that resolves after an account switch is cleaned up', async () => {
  const gate = createLatestAttemptGate();
  const pendingJoin = deferred();
  const opened = [];
  const cleaned = [];

  const connect = async () => {
    const attempt = gate.begin('account-a');
    const port = await pendingJoin.promise;
    if (!attempt.isCurrent()) {
      cleaned.push({ account: attempt.target, port });
      return 'stale';
    }
    opened.push({ account: attempt.target, port });
    return 'opened';
  };

  const staleConnection = connect();
  gate.begin('saved-account-b');
  pendingJoin.resolve(8083);

  assert.equal(await staleConnection, 'stale');
  assert.deepEqual(opened, []);
  assert.deepEqual(cleaned, [{ account: 'account-a', port: 8083 }]);
  assert.equal(gate.currentTarget(), 'saved-account-b');
});
