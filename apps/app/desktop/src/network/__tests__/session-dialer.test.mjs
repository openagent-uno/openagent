import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionDialer } from '../../../dist/network/session-dialer.js';

const TARGET = 'a'.repeat(64);
const CERT = new Uint8Array([0x11, 0x22, 0x33]);

function connection({ dead = false, writeError = null } = {}) {
  const prefixes = [];
  let openCount = 0;
  let closed = false;
  return {
    prefixes,
    get openCount() { return openCount; },
    get closed() { return closed; },
    async openBi() {
      openCount += 1;
      if (dead) throw new Error('connection closed by peer');
      return {
        send: {
          async writeAll(value) {
            if (writeError) throw new Error(writeError);
            prefixes.push(new Uint8Array(value));
          },
          async finish() {},
        },
        recv: { async read() { return null; } },
      };
    },
    close() { closed = true; },
  };
}

function endpointFor(connections) {
  const queue = [...connections];
  let dialCount = 0;
  return {
    get dialCount() { return dialCount; },
    nodeId: () => 'self',
    async connect() {
      dialCount += 1;
      const next = queue.shift();
      if (!next) throw new Error('no more fake connections');
      return next;
    },
  };
}

test('pools a healthy connection and writes the device-cert prefix', async () => {
  const live = connection();
  const endpoint = endpointFor([live]);
  const dialer = new SessionDialer(endpoint, CERT);

  await dialer.openGatewayStream(TARGET);
  await dialer.openGatewayStream(TARGET);

  assert.equal(endpoint.dialCount, 1, 'a healthy connection remains pooled');
  assert.equal(live.openCount, 2);
  assert.deepEqual(
    Array.from(live.prefixes[0]),
    [0, 0, 0, CERT.length, ...CERT],
  );
  await dialer.close();
});

test('evicts a connection that dies before its first stream and redials once', async () => {
  const dropped = connection({ dead: true });
  const replacement = connection();
  const endpoint = endpointFor([dropped, replacement]);
  const dialer = new SessionDialer(endpoint, CERT);

  const stream = await dialer.openGatewayStream(TARGET);

  assert.equal(stream.targetNodeId, TARGET);
  assert.equal(endpoint.dialCount, 2, 'one failed stream gets one redial');
  assert.equal(dropped.openCount, 1);
  assert.equal(dropped.closed, true, 'the dead connection is closed');
  assert.equal(replacement.openCount, 1);

  await dialer.openGatewayStream(TARGET);
  assert.equal(endpoint.dialCount, 2, 'the healthy replacement remains pooled');
  await dialer.close();
});

test('evicts a failed replacement without an unbounded retry loop', async () => {
  const first = connection({ dead: true });
  const second = connection({ dead: true });
  const third = connection();
  const endpoint = endpointFor([first, second, third]);
  const dialer = new SessionDialer(endpoint, CERT);

  await assert.rejects(
    dialer.openGatewayStream(TARGET),
    /connection closed by peer/,
  );
  assert.equal(endpoint.dialCount, 2, 'only the initial dial and one redial run');
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);

  await dialer.openGatewayStream(TARGET);
  assert.equal(endpoint.dialCount, 3, 'a later call can make a fresh attempt');
  await dialer.close();
});

test('concurrent callers share the same replacement connection', async () => {
  const dropped = connection({ dead: true });
  const replacement = connection();
  const endpoint = endpointFor([dropped, replacement]);
  const dialer = new SessionDialer(endpoint, CERT);

  const [first, second] = await Promise.all([
    dialer.openGatewayStream(TARGET),
    dialer.openGatewayStream(TARGET),
  ]);

  assert.equal(first.targetNodeId, TARGET);
  assert.equal(second.targetNodeId, TARGET);
  assert.equal(endpoint.dialCount, 2, 'concurrent recovery performs one redial');
  assert.equal(replacement.openCount, 2);
  await dialer.close();
});

test('a failed cert-prefix write also evicts and redials once', async () => {
  const broken = connection({ writeError: 'stream write failed' });
  const replacement = connection();
  const endpoint = endpointFor([broken, replacement]);
  const dialer = new SessionDialer(endpoint, CERT);

  await dialer.openGatewayStream(TARGET);

  assert.equal(endpoint.dialCount, 2);
  assert.equal(broken.closed, true);
  assert.deepEqual(
    Array.from(replacement.prefixes[0]),
    [0, 0, 0, CERT.length, ...CERT],
  );
  await dialer.close();
});
