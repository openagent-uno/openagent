import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { CapabilitySocket } from '../../../dist/capabilities/capability-socket.js';
import { CapabilityProtocolError } from '../../../dist/capabilities/protocol.js';

test('capability WS registers, executes once, chunks media, then returns result', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const bytes = Buffer.alloc(600 * 1024, 0x2a);
  const chunks = [];
  let invocations = 0;
  const completed = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          assert.equal(frame.protocol, 'client-capabilities/1');
          assert.equal(frame.client_instance_id, 'instance-1');
          assert.equal(frame.network_id, 'network-1');
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-1', account_id: 'network-1', network_id: 'network-1',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'call-1', generation: frame.generation,
            server: 'filesystem', tool: 'read_media_file', args: {}, session_id: null,
            account_id: 'network-1', network_id: 'network-1',
            idempotency_key: 'idem-1', deadline_ms: 5000,
            arguments_sha256: '0'.repeat(64),
          }));
        } else if (frame.type === 'client_artifact_chunk') {
          chunks.push(frame);
        } else if (frame.type === 'client_tool_result') {
          try {
            assert.equal(frame.error, undefined);
            assert.equal(invocations, 1);
            assert.ok(chunks.length >= 2);
            assert.equal(chunks.at(-1).eof, true);
            const materialized = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64')));
            assert.deepEqual(materialized, bytes);
            assert.equal(chunks[0].size, bytes.length);
            assert.equal(chunks[0].sha256, createHash('sha256').update(bytes).digest('hex'));
            assert.equal(frame.result.content[0].type, 'artifact_ref');
            assert.equal(frame.result.content[0].transfer_id, chunks[0].transfer_id);
            resolve();
          } catch (error) { reject(error); }
        }
      });
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'account-1',
    trustedAccountId: 'network-1',
    trustedDeviceId: 'device-1',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-1',
    deviceLabel: 'Test Desktop',
    reconnect: false,
    getOffer: () => ({
      generation: 3,
      servers: [{ name: 'filesystem', tools: [{ name: 'read_media_file' }] }],
    }),
    invoke: async () => {
      invocations += 1;
      return {
        content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
        isError: false,
      };
    },
  });
  socket.start();
  try {
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('WS test timed out')), 5000)),
    ]);
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('artifact streaming applies websocket backpressure and preserves frame order', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const bytes = Buffer.alloc(16 * 1024 * 1024, 0x5a);
  const frameTypes = [];
  const sequences = [];
  let resultSeen = false;
  let serverSocket;
  const completed = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      serverSocket = ws;
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-slow', account_id: 'network-slow',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'slow-artifact', generation: frame.generation,
            server: 'filesystem', tool: 'read_media_file', args: {}, session_id: null,
            account_id: 'network-slow', idempotency_key: 'slow-artifact-idem',
            deadline_ms: 10_000, arguments_sha256: '0'.repeat(64),
          }), () => ws._socket.pause());
        } else if (frame.type === 'client_artifact_chunk') {
          frameTypes.push(frame.type);
          sequences.push(frame.seq);
        } else if (frame.type === 'client_tool_result') {
          frameTypes.push(frame.type);
          resultSeen = true;
          resolve();
        }
      });
      ws.on('error', reject);
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'account-slow',
    trustedAccountId: 'network-slow',
    trustedDeviceId: 'device-slow',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-slow',
    deviceLabel: 'Slow Receiver Desktop',
    reconnect: false,
    getOffer: () => ({
      generation: 1,
      servers: [{ name: 'filesystem', tools: [{ name: 'read_media_file', classification: 'read_only' }] }],
    }),
    invoke: async () => ({
      content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
      isError: false,
    }),
  });
  let maxBufferedAmount = 0;
  const sampler = setInterval(() => {
    maxBufferedAmount = Math.max(maxBufferedAmount, socket.socket?.bufferedAmount ?? 0);
  }, 2);
  socket.start();
  try {
    await waitUntil(() => serverSocket?._socket?.isPaused(), 3000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(resultSeen, false, 'a paused receiver must stall the serialized writer');
    // Only one 512 KiB (base64-expanded) frame may be pending in ws at once.
    assert.ok(maxBufferedAmount < 2 * 1024 * 1024, `buffer grew to ${maxBufferedAmount} bytes`);
    serverSocket._socket.resume();
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('backpressure test timed out')), 10_000)),
    ]);
    assert.deepEqual(sequences, sequences.map((_, index) => index));
    assert.equal(frameTypes.at(-1), 'client_tool_result');
  } finally {
    clearInterval(sampler);
    serverSocket?._socket?.resume();
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ambiguous local-host loss closes capability transport without a determinate result', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const clientFrames = [];
  const disconnected = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        clientFrames.push(frame);
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-1', account_id: 'network-1',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'ambiguous-1', generation: frame.generation,
            server: 'filesystem', tool: 'write_file', args: {}, session_id: null,
            account_id: 'network-1', idempotency_key: 'ambiguous-1',
            deadline_ms: 5000, arguments_sha256: '0'.repeat(64),
          }));
        }
      });
      ws.on('close', resolve);
      ws.on('error', reject);
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'account-1',
    trustedAccountId: 'network-1',
    trustedDeviceId: 'device-1',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-ambiguous',
    deviceLabel: 'Test Desktop',
    reconnect: false,
    getOffer: () => ({
      generation: 1,
      servers: [{
        name: 'filesystem',
        tools: [{ name: 'write_file', classification: 'mutating' }],
      }],
    }),
    invoke: async () => {
      throw new CapabilityProtocolError(
        'host_transport_lost',
        'broker exited after dispatch',
      );
    },
  });
  socket.start();
  try {
    await Promise.race([
      disconnected,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('capability transport did not close')),
        5000,
      )),
    ]);
    assert.equal(
      clientFrames.some((frame) => frame.type === 'client_tool_result'),
      false,
    );
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('argument-specific read-only cancellation returns a result without dropping the socket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let completed = false;
  const received = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-dynamic-read', account_id: 'network-dynamic-read',
            network_id: 'network-dynamic-read',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'dynamic-read', generation: frame.generation,
            server: 'computer-control', tool: 'computer',
            args: { action: 'get_screenshot' }, session_id: null,
            account_id: 'network-dynamic-read', network_id: 'network-dynamic-read',
            idempotency_key: 'dynamic-read-idem', deadline_ms: 5000,
            arguments_sha256: '0'.repeat(64),
          }));
          setTimeout(() => ws.send(JSON.stringify({
            type: 'client_tool_cancel', call_id: 'dynamic-read',
            generation: frame.generation, reason: 'test cancellation',
          })), 25);
        } else if (frame.type === 'client_tool_result') {
          try {
            assert.equal(frame.call_id, 'dynamic-read');
            assert.equal(frame.error.code, 'cancelled');
            assert.equal(ws.readyState, ws.OPEN);
            completed = true;
            resolve();
          } catch (error) { reject(error); }
        }
      });
      ws.on('close', () => {
        if (!completed) reject(new Error('read-only cancellation dropped capability socket'));
      });
      ws.on('error', reject);
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'account-dynamic-read',
    trustedAccountId: 'network-dynamic-read',
    trustedDeviceId: 'device-dynamic-read',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-dynamic-read',
    deviceLabel: 'Dynamic Read Desktop',
    reconnect: false,
    getOffer: () => ({
      generation: 1,
      servers: [{
        name: 'computer-control',
        tools: [{
          name: 'computer',
          classification: 'mutating',
          classification_by_argument: {
            action: { get_screenshot: 'read_only' },
          },
        }],
      }],
    }),
    invoke: async (_call, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new CapabilityProtocolError(
        'cancelled',
        String(signal.reason || 'cancelled'),
      )), { once: true });
    }),
  });
  socket.start();
  try {
    await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('dynamic cancellation timed out')),
        3000,
      )),
    ]);
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('broker indeterminate mutation is translated to the Gateway safety contract', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  let invocations = 0;
  const received = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-indeterminate', account_id: 'network-indeterminate',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'indeterminate-call', generation: frame.generation,
            server: 'filesystem', tool: 'write_file', args: {}, session_id: null,
            account_id: 'network-indeterminate', idempotency_key: 'indeterminate-idem',
            arguments_sha256: '0'.repeat(64),
          }));
        } else if (frame.type === 'client_tool_result') {
          try {
            assert.equal(frame.error.code, 'CLIENT_RESULT_INDETERMINATE');
            assert.equal(frame.error.data.local_code, 'idempotency_indeterminate');
            assert.equal(frame.error.data.ledger_state, 'possible_effect');
            assert.equal(invocations, 1, 'the Desktop must not retry a mutation');
            resolve();
          } catch (error) { reject(error); }
        }
      });
      ws.on('error', reject);
    });
  });
  const socket = new CapabilitySocket({
    accountId: 'account-indeterminate',
    trustedAccountId: 'network-indeterminate',
    trustedDeviceId: 'device-indeterminate',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-indeterminate',
    deviceLabel: 'Indeterminate Desktop',
    reconnect: false,
    getOffer: () => ({
      generation: 1,
      servers: [{
        name: 'filesystem',
        tools: [{ name: 'write_file', classification: 'mutating' }],
      }],
    }),
    invoke: async () => {
      invocations += 1;
      throw new CapabilityProtocolError(
        'idempotency_indeterminate',
        'The local mutation may have completed',
        { ledger_state: 'possible_effect' },
      );
    },
  });
  socket.start();
  try {
    await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('indeterminate mapping timed out')), 3000)),
    ]);
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('capability WS rejects a certified account mismatch without invoking locally', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let invocations = 0;
  const rejected = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-1', account_id: 'network-1',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'wrong-account', generation: frame.generation,
            server: 'filesystem', tool: 'read', args: {}, session_id: null,
            account_id: 'network-2', idempotency_key: 'wrong-account-idem',
            arguments_sha256: '0'.repeat(64),
          }));
        } else if (frame.type === 'client_tool_result') {
          try {
            assert.equal(frame.call_id, 'wrong-account');
            assert.equal(frame.error.code, 'account_mismatch');
            assert.equal(invocations, 0);
            resolve();
          } catch (error) { reject(error); }
        }
      });
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'local-account-1',
    trustedAccountId: 'network-1',
    trustedDeviceId: 'device-1',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-account-check',
    deviceLabel: 'Test Desktop',
    reconnect: false,
    getOffer: () => ({
      generation: 1,
      servers: [{ name: 'filesystem', tools: [{ name: 'read' }] }],
    }),
    invoke: async () => {
      invocations += 1;
      return {};
    },
  });
  socket.start();
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => setTimeout(() => reject(new Error('account check timed out')), 3000)),
    ]);
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('capability WS rejects a hello ACK from the wrong certified device', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const closed = new Promise((resolve) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'wrong-device', account_id: 'network-device-check',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
        }
      });
      ws.on('close', resolve);
    });
  });
  const errors = [];
  const socket = new CapabilitySocket({
    accountId: 'account-device-check',
    trustedAccountId: 'network-device-check',
    trustedDeviceId: 'expected-device',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-device-check',
    deviceLabel: 'Device Check Desktop',
    reconnect: false,
    getOffer: () => ({ generation: 1, servers: [] }),
    invoke: async () => ({}),
    onPhase: (phase, error) => { if (phase === 'error' && error) errors.push(error); },
  });
  socket.start();
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('device ACK check timed out')), 3000)),
    ]);
    assert.equal(socket.isAcknowledged, false);
    assert.ok(errors.some((value) => /rejected/i.test(value)));
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('client tool events queue until hello acknowledgement and are acknowledged', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let eventFrames = 0;
  const received = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          setTimeout(() => ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-events', account_id: 'network-events',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          })), 30);
        } else if (frame.type === 'client_tool_event') {
          try {
            eventFrames += 1;
            assert.equal(frame.event.shell_id, 'queued-shell');
            ws.send(JSON.stringify({
              type: 'client_tool_event_ack', generation: frame.generation,
              shell_id: 'queued-shell', accepted: true, duplicate: false,
            }));
            resolve();
          } catch (error) { reject(error); }
        }
      });
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'account-events',
    trustedAccountId: 'network-events',
    trustedDeviceId: 'device-events',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-events',
    deviceLabel: 'Event Test Desktop',
    reconnect: false,
    getOffer: () => ({ generation: 4, servers: [] }),
    invoke: async () => ({}),
  });
  socket.start();
  assert.equal(socket.sendToolEvent({
    type: 'shell_completed', shell_id: 'queued-shell', status: 'exited', exit_code: 0,
  }), true);
  try {
    await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('event queue timed out')), 3000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(eventFrames, 1);
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('client tool events survive a stale/lost ACK and retry on heartbeat', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let eventFrames = 0;
  const acknowledged = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-retry', account_id: 'network-retry',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
        } else if (frame.type === 'client_tool_event') {
          eventFrames += 1;
          if (eventFrames === 1) {
            // A stale ACK must not delete the event; this also models a lost
            // valid ACK because no other frame confirms the first delivery.
            ws.send(JSON.stringify({
              type: 'client_tool_event_ack', generation: frame.generation - 1,
              shell_id: frame.event.shell_id, accepted: true, duplicate: false,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'client_tool_event_ack', generation: frame.generation,
              shell_id: frame.event.shell_id, accepted: true, duplicate: true,
            }));
            resolve();
          }
        }
      });
      ws.on('error', reject);
    });
  });

  const socket = new CapabilitySocket({
    accountId: 'account-retry',
    trustedAccountId: 'network-retry',
    trustedDeviceId: 'device-retry',
    url: `ws://127.0.0.1:${address.port}/ws/capabilities`,
    clientInstanceId: 'instance-retry',
    deviceLabel: 'Event Retry Desktop',
    reconnect: false,
    heartbeatMs: 25,
    getOffer: () => ({ generation: 5, servers: [] }),
    invoke: async () => ({}),
  });
  socket.start();
  socket.sendToolEvent({
    type: 'shell_completed', shell_id: 'retry-shell', status: 'exited', exit_code: 0,
  });
  try {
    await Promise.race([
      acknowledged,
      new Promise((_, reject) => setTimeout(() => reject(new Error('event retry timed out')), 3000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(eventFrames, 2, 'valid ACK must stop subsequent heartbeat retries');
  } finally {
    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
