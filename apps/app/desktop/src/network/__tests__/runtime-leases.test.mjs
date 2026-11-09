import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeLeases } from '../../../dist/network/runtime-leases.js';

test('concurrent tunnels share their endpoint until the last tunnel releases it', async () => {
  const pool = createRuntimeLeases();
  let opened = 0;
  let closed = 0;
  let finishShutdown;
  const open = async () => {
    opened += 1;
    return { shutdown: () => new Promise(resolve => {
      closed += 1;
      finishShutdown = resolve;
    }) };
  };

  const [first, second] = await Promise.all([pool.acquire('device', open), pool.acquire('device', open)]);
  assert.equal(opened, 1);
  assert.equal(first.runtime, second.runtime);
  await first.release();
  await first.release();
  assert.equal(closed, 0);

  const shutdown = second.release();
  assert.equal(closed, 1);
  const reconnect = pool.acquire('device', open);
  assert.equal(opened, 1);
  finishShutdown();
  await shutdown;

  const third = await reconnect;
  assert.equal(opened, 2);
  const finalShutdown = third.release();
  finishShutdown();
  await finalShutdown;
});

test('a failed native start can be retried', async () => {
  const pool = createRuntimeLeases();
  const fail = async () => { throw new Error('native endpoint unavailable'); };
  const failed = await Promise.allSettled([pool.acquire('device', fail), pool.acquire('device', fail)]);
  assert.deepEqual(failed.map(result => result.status), ['rejected', 'rejected']);
  const retry = await pool.acquire('device', async () => ({ shutdown: async () => {} }));
  await retry.release();
});
