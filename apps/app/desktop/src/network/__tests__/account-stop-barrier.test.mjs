import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountStopBarrier } from '../../../dist/services/account-stop-barrier.js';
import {
  OperationDeadlineError,
  withDeadline,
} from '../../../dist/services/promise-deadline.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function manualDeadline() {
  let callback = null;
  let cleared = false;
  return {
    scheduler: {
      setTimeout(next) {
        callback = next;
        return 1;
      },
      clearTimeout() {
        cleared = true;
      },
    },
    fire() {
      assert.ok(callback, 'deadline was scheduled');
      callback();
    },
    wasCleared() {
      return cleared;
    },
  };
}

test('A→B→A waits for A teardown while an unrelated B may start', async () => {
  const barrier = createAccountStopBarrier();
  const teardown = deferred();
  const events = [];

  const stopA = barrier.run('account-a', async () => {
    events.push('stop-a:begin');
    await teardown.promise;
    events.push('stop-a:end');
  });
  const restartA = (async () => {
    await barrier.wait('account-a');
    events.push('start-a');
  })();
  await barrier.wait('account-b');
  events.push('start-b');

  await Promise.resolve();
  assert.deepEqual(events, ['stop-a:begin', 'start-b']);

  teardown.resolve();
  await Promise.all([stopA, restartA]);
  assert.deepEqual(events, ['stop-a:begin', 'start-b', 'stop-a:end', 'start-a']);
});

test('a start waits for every stop queued for the same account', async () => {
  const barrier = createAccountStopBarrier();
  const first = deferred();
  const second = deferred();
  const events = [];

  const stopOne = barrier.run('account-a', async () => {
    await first.promise;
    events.push('stop-1');
  });
  const stopTwo = barrier.run('account-a', async () => {
    await second.promise;
    events.push('stop-2');
  });
  const start = (async () => {
    await barrier.wait('account-a');
    events.push('start');
  })();

  first.resolve();
  await stopOne;
  assert.deepEqual(events, ['stop-1']);
  second.resolve();
  await Promise.all([stopTwo, start]);
  assert.deepEqual(events, ['stop-1', 'stop-2', 'start']);
});

test('a teardown deadline releases the caller but keeps restart behind the real barrier', async () => {
  const barrier = createAccountStopBarrier();
  const teardown = deferred();
  const clock = manualDeadline();
  const events = [];

  const stop = barrier.run('account-a', async () => {
    events.push('stop:begin');
    await teardown.promise;
    events.push('stop:end');
  });
  const boundedCaller = withDeadline(
    stop,
    25_000,
    'secure tunnel teardown',
    clock.scheduler,
  );

  clock.fire();
  await assert.rejects(
    boundedCaller,
    (error) => error instanceof OperationDeadlineError
      && error.operation === 'secure tunnel teardown'
      && error.timeoutMs === 25_000,
  );

  let restarted = false;
  const restart = barrier.wait('account-a').then(() => {
    restarted = true;
    events.push('start');
  });
  await Promise.resolve();
  assert.equal(restarted, false, 'deadline must not remove the lifecycle barrier');

  teardown.resolve();
  await Promise.all([stop, restart]);
  assert.deepEqual(events, ['stop:begin', 'stop:end', 'start']);
});

test('a completed lifecycle operation clears its deadline', async () => {
  const clock = manualDeadline();
  const result = await withDeadline(Promise.resolve('done'), 25_000, 'cleanup', clock.scheduler);

  assert.equal(result, 'done');
  assert.equal(clock.wasCleared(), true);
});
