import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoopbackConsumerRegistry } from '../../../dist/services/loopback-consumer-registry.js';

function fixture() {
  const registry = createLoopbackConsumerRegistry();
  const stopped = [];
  const releaseAttempt = (accountId, rendererId, attemptToken) => {
    if (registry.release(accountId, rendererId, attemptToken)) stopped.push(accountId);
  };
  const releaseRenderer = (rendererId) => {
    stopped.push(...registry.releaseRenderer(rendererId));
  };
  return { registry, stopped, releaseAttempt, releaseRenderer };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('two renderers may share an account and releasing one does not stop it', () => {
  const { registry, stopped, releaseAttempt } = fixture();
  registry.claim('account-a', 101, 1);
  registry.claim('account-a', 202, 1);

  releaseAttempt('account-a', 101, 1);

  assert.deepEqual(stopped, []);
  assert.equal(registry.consumerCount('account-a'), 1);
  assert.equal(registry.hasConsumers('account-a'), true);
});

test('new-window handoff claims the destination before releasing the startup attempt', () => {
  const { registry, stopped, releaseAttempt } = fixture();
  registry.claim('account-a', 101, 7);

  // Mirrors transferLoopbackAttempt(): destination first, source second.
  registry.claim('account-a', 202);
  releaseAttempt('account-a', 101, 7);

  assert.deepEqual(stopped, []);
  assert.equal(registry.consumerCount('account-a'), 1);
  assert.equal(registry.hasConsumers('account-a'), true);

  assert.equal(registry.release('account-a', 202), true);
});

test('a stale different-account attempt stops only its own loopback', () => {
  const { registry, stopped, releaseAttempt } = fixture();
  registry.claim('account-a', 101, 1);
  registry.claim('account-b', 101, 2);

  releaseAttempt('account-a', 101, 1);

  assert.deepEqual(stopped, ['account-a']);
  assert.equal(registry.hasConsumers('account-a'), false);
  assert.equal(registry.hasConsumers('account-b'), true);
});

test('destroying a renderer releases all of its accounts without reaping shared ones', () => {
  const { registry, stopped, releaseRenderer } = fixture();
  registry.claim('account-a', 101, 1);
  registry.claim('account-b', 101, 2);
  registry.claim('account-b', 202, 1);

  releaseRenderer(101);

  assert.deepEqual(stopped, ['account-a']);
  assert.equal(registry.consumerCount('account-a'), 0);
  assert.equal(registry.consumerCount('account-b'), 1);

  releaseRenderer(202);
  assert.deepEqual(stopped, ['account-a', 'account-b']);
});

test('a start that finishes after renderer destruction is reaped once its handle exists', async () => {
  const registry = createLoopbackConsumerRegistry();
  const pendingStart = deferred();
  let handleRunning = false;
  let stopCount = 0;
  const stopIfUnclaimed = () => {
    if (!registry.hasConsumers('account-a') && handleRunning) {
      handleRunning = false;
      stopCount += 1;
    }
  };

  // Mirrors the IPC handler: ownership is reserved before awaiting startup.
  registry.claim('account-a', 101, 1);
  const completion = pendingStart.promise.then(() => {
    handleRunning = true;
    // loopback:start performs this reconciliation immediately after await.
    stopIfUnclaimed();
  });

  assert.deepEqual(registry.releaseRenderer(101), ['account-a']);
  stopIfUnclaimed();
  assert.equal(stopCount, 0, 'there is no handle to stop before startup resolves');

  pendingStart.resolve();
  await completion;
  assert.equal(stopCount, 1);
  assert.equal(handleRunning, false);
});

test('same-account out-of-order completion releases only the stale reservation', async () => {
  const { registry, stopped, releaseAttempt } = fixture();
  // Claims happen before the asynchronous start. Token 2 therefore protects
  // the shared single-flight when token 1 resolves later and is discarded.
  const firstStart = deferred();
  const secondStart = deferred();
  registry.claim('account-a', 101, 1);
  const first = firstStart.promise.then(() => {
    releaseAttempt('account-a', 101, 1);
    return 'stale';
  });
  registry.claim('account-a', 101, 2);
  const second = secondStart.promise.then(() => 'current');

  secondStart.resolve();
  assert.equal(await second, 'current');
  assert.equal(registry.consumerCount('account-a'), 2);

  firstStart.resolve();
  assert.equal(await first, 'stale');

  assert.deepEqual(stopped, []);
  assert.equal(registry.consumerCount('account-a'), 1);

  // Normal disconnect releases the remaining current claim; no stale token
  // is left behind to keep the loopback alive permanently.
  assert.equal(registry.release('account-a', 101), true);
  assert.equal(registry.consumerCount('account-a'), 0);
});

test('logout retires the renderer lifetime synchronously even while a sibling retains the tunnel', () => {
  const released = [];
  let registry;
  registry = createLoopbackConsumerRegistry((accountId, rendererId) => {
    released.push({ accountId, rendererId, lifetime: registry.consumerLifetime(accountId, rendererId) });
  });
  registry.claim('shared-account', 101);
  registry.claim('shared-account', 202);
  const oldLifetime = registry.consumerLifetime('shared-account', 101);
  const siblingLifetime = registry.consumerLifetime('shared-account', 202);
  assert.ok(oldLifetime);
  assert.equal(registry.release('shared-account', 101), false);
  assert.deepEqual(released, [{ accountId: 'shared-account', rendererId: 101, lifetime: undefined }]);
  assert.equal(registry.consumerLifetime('shared-account', 202), siblingLifetime);
  registry.claim('shared-account', 101);
  assert.notEqual(registry.consumerLifetime('shared-account', 101), oldLifetime);
  assert.equal(registry.consumerLifetime('shared-account', 202), siblingLifetime);
});

test('overlapping attempts preserve the current lifetime until its last claim is released', () => {
  const released = [];
  const registry = createLoopbackConsumerRegistry((...args) => released.push(args));
  registry.claim('account', 101, 1);
  const lifetime = registry.consumerLifetime('account', 101);
  registry.claim('account', 101, 2);
  registry.release('account', 101, 1);
  assert.equal(registry.consumerLifetime('account', 101), lifetime);
  assert.deepEqual(released, []);
  registry.release('account', 101, 2);
  assert.equal(registry.consumerLifetime('account', 101), undefined);
  assert.deepEqual(released, [['account', 101]]);
});

test('account and renderer retirement notify only the exact lifetimes being revoked', () => {
  const released = [];
  const registry = createLoopbackConsumerRegistry((...args) => released.push(args));
  registry.claim('one', 101);
  registry.claim('one', 202);
  registry.claim('two', 101);
  const unaffected = registry.consumerLifetime('one', 202);
  assert.deepEqual(registry.releaseRenderer(101), ['two']);
  assert.equal(registry.consumerLifetime('one', 202), unaffected);
  assert.deepEqual(released, [['one', 101], ['two', 101]]);
  registry.clearAccount('one');
  assert.deepEqual(released, [['one', 101], ['two', 101], ['one', 202]]);
  assert.equal(registry.consumerCount('one'), 0);
  registry.clearAccount('one');
  assert.equal(released.length, 3);
});
