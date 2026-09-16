import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { CapabilityManager } from '../../../dist/capabilities/manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('manager advertises a broker-owned persisted grant on a fresh Desktop boot', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let cache = { enabled: false, version: 1, updatedAt: null };
  let hello = null;
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'capability_hello') return;
      hello = frame;
      ws.send(JSON.stringify({
        type: 'capability_hello_ack',
        protocol: frame.protocol,
        device_id: 'persisted-device',
        account_id: 'persisted-network',
        network_id: 'persisted-network',
        client_instance_id: frame.client_instance_id,
        generation: frame.generation,
        accepted: true,
      }));
    });
  });

  const manager = new CapabilityManager({
    clientInstanceId: 'fresh-desktop-instance',
    deviceLabel: 'Fresh Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: { OPENAGENT_FAKE_ENABLED: '1' },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
    },
  });
  manager.addLoopback(
    'persisted-account',
    `http://127.0.0.1:${address.port}`,
    'persisted-gateway',
    'persisted-network',
    'persisted-device',
  );

  try {
    await manager.start();
    await waitUntil(() => manager.getStatus().phase === 'connected');
    assert.equal(manager.getStatus().consent.enabled, true);
    assert.equal(manager.getStatus().connectedAccounts, 1);
    assert.equal(hello?.client_instance_id, 'fresh-desktop-instance');
    assert.equal(hello?.servers[0].name, 'filesystem');
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('manager keeps disabled targets offline, then binds exact instance and emergency-revokes', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let cache = { enabled: false, version: 1, updatedAt: null };
  let status = null;
  const waiters = [];
  const manager = new CapabilityManager({
    clientInstanceId: 'manager-instance',
    deviceLabel: 'Manager Test Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
    },
    onStatus: (next) => {
      status = next;
      for (const waiter of [...waiters]) {
        if (waiter.predicate(next)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(next);
        }
      }
    },
  });

  let resolveEvent;
  let rejectEvent;
  const eventReceived = new Promise((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  const resultReceived = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          try {
            assert.equal(frame.client_instance_id, 'manager-instance');
            assert.equal(frame.servers[0].name, 'filesystem');
          } catch (error) { reject(error); return; }
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-manager', account_id: 'network-1', network_id: 'network-1',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          ws.send(JSON.stringify({
            type: 'client_tool_call', call_id: 'manager-call', generation: frame.generation,
            server: 'filesystem', tool: 'echo',
            args: { value: 'from-host', emit_event: true },
            account_id: 'network-1', network_id: 'network-1',
            session_id: 'interactive-session', idempotency_key: 'manager-idem',
            arguments_sha256: '0'.repeat(64),
          }));
        } else if (frame.type === 'client_tool_result') {
          try {
            assert.equal(frame.result.content[0].text, 'from-host');
            assert.equal(frame.result._meta.principal.account_id, 'network-1');
            assert.equal(frame.result._meta.principal.client_account_id, 'account-1');
            assert.equal(frame.result._meta.principal.network_id, 'network-1');
            assert.equal(frame.result._meta.principal.channel_id, 'same-gateway');
            assert.equal(frame.result._meta.principal.device_id, 'device-manager');
            assert.equal(frame.result._meta.principal.generation, frame.generation);
            resolve(frame);
          } catch (error) { reject(error); }
        } else if (frame.type === 'client_tool_event') {
          try {
            assert.equal(frame.event.type, 'shell_completed');
            assert.equal(frame.event.shell_id, 'desktop-background-shell');
            assert.equal(frame.event.principal, undefined, 'local principal must not cross the wire');
            ws.send(JSON.stringify({
              type: 'client_tool_event_ack', generation: frame.generation,
              shell_id: frame.event.shell_id, accepted: true, duplicate: false,
            }));
            resolveEvent(frame);
          } catch (error) { rejectEvent(error); }
        }
      });
    });
  });

  const waitFor = (predicate) => {
    if (status && predicate(status)) return Promise.resolve(status);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };

  try {
    await manager.start();
    manager.addLoopback('account-1', `http://127.0.0.1:${address.port}`, 'same-gateway', 'network-1', 'device-manager');
    manager.addLoopback('account-2', `http://127.0.0.1:${address.port}`, 'same-gateway', 'network-1', 'device-manager');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(server.clients.size, 0, 'disabled consent must not open a capability socket');

    await manager.setEnabled(true);
    await waitFor((value) => value.phase === 'connected' || value.phase === 'active');
    assert.equal(server.clients.size, 1, 'same gateway + boot instance must use one channel');
    assert.equal(manager.getStatus().connectedAccounts, 2);
    await Promise.race([
      Promise.all([resultReceived, eventReceived]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('manager call timed out')), 3000)),
    ]);

    const revoked = await manager.emergencyDisable();
    assert.equal(revoked.consent.enabled, false);
    assert.equal(revoked.connectedAccounts, 0);
    assert.equal(revoked.activeCalls, 0);
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('failed emergency persistence stays latched and retries revoke before any reconnect', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  let connections = 0;
  server.on('connection', (ws) => {
    connections += 1;
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'capability_hello') return;
      ws.send(JSON.stringify({
        type: 'capability_hello_ack', protocol: frame.protocol,
        device_id: 'device-emergency', account_id: 'network-emergency',
        client_instance_id: frame.client_instance_id,
        generation: frame.generation, accepted: true,
      }));
    });
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-emergency-'));
  const failDisable = path.join(root, 'fail-disable');
  fs.writeFileSync(failDisable, 'fail until test recovers broker');
  let cache = { enabled: true, version: 1, updatedAt: null };
  let emergencyPending = false;
  const manager = new CapabilityManager({
    clientInstanceId: 'emergency-instance',
    deviceLabel: 'Emergency Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: {
        OPENAGENT_FAKE_ENABLED: '1',
        OPENAGENT_FAKE_FAIL_DISABLE_ONCE_PATH: failDisable,
      },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
      getEmergencyRevokePending: () => emergencyPending,
      setEmergencyRevokePending: (pending) => { emergencyPending = pending; },
    },
    statusPollMs: 20,
  });

  const waitUntil = async (predicate, message, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(message);
  };

  try {
    await manager.start();
    manager.addLoopback(
      'account-emergency', `http://127.0.0.1:${address.port}`,
      'gateway-emergency', 'network-emergency', 'device-emergency',
    );
    await waitUntil(() => server.clients.size === 1, 'initial capability socket did not connect');
    assert.equal(connections, 1);

    const stopped = await manager.emergencyDisable();
    assert.equal(stopped.consent.enabled, false, 'effective consent must fail closed immediately');
    assert.equal(emergencyPending, true, 'failed canonical revoke must retain its tombstone');
    await waitUntil(() => server.clients.size === 0, 'emergency stop did not close capability socket');

    // The broker recovers still reporting its old canonical grant. The retry
    // must write false before it is permitted to advertise any capability.
    fs.unlinkSync(failDisable);
    await waitUntil(
      () => !emergencyPending && cache.enabled === false,
      'emergency revocation was not persisted after broker recovery',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 1, 'recovery must never reconnect under the stale grant');
    assert.equal(manager.getStatus().consent.enabled, false);
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown barrier waits for emergency revocation without respawn or an orphan shim', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-emergency-quit-'));
  const lifecyclePath = path.join(root, 'lifecycle.log');
  fs.writeFileSync(lifecyclePath, '');
  let cache = { enabled: true, version: 1, updatedAt: null };
  let emergencyPending = false;
  const manager = new CapabilityManager({
    clientInstanceId: 'emergency-quit-instance',
    deviceLabel: 'Emergency Quit Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: {
        OPENAGENT_FAKE_ENABLED: '1',
        OPENAGENT_FAKE_LIFECYCLE_PATH: lifecyclePath,
        OPENAGENT_FAKE_DISABLE_DELAY_MS: '150',
      },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
      getEmergencyRevokePending: () => emergencyPending,
      setEmergencyRevokePending: (pending) => { emergencyPending = pending; },
    },
  });

  try {
    await manager.start();
    // Model cleanup retained from an earlier shim transport loss. A successful
    // consent barrier releases it globally, so quit must not start a new shim
    // just to send a redundant release_principal frame.
    const stale = {
      kind: 'desktop', client_instance_id: 'emergency-quit-instance',
      account_id: 'old-network', generation: 1,
    };
    manager.stalePrincipals.set(JSON.stringify(stale), stale);

    const emergency = manager.emergencyDisable();
    manager.beginShutdown();
    const shutdown = manager.shutdown();
    assert.strictEqual(manager.shutdown(), shutdown, 'shutdown must be idempotent');
    await Promise.all([emergency, shutdown]);

    assert.equal(cache.enabled, false);
    assert.equal(emergencyPending, false);
    assert.equal(manager.host.running, false);
    const initialLines = fs.readFileSync(lifecyclePath, 'utf8').trim().split('\n');
    const starts = initialLines.filter((line) => line.startsWith('start:'));
    assert.equal(starts.length, 1, 'quit must not respawn host-tools');
    assert.equal(initialLines.some((line) => line.startsWith('release:')), false);
    const pid = Number(starts[0].split(':')[1]);
    await waitUntil(() => !processAlive(pid));

    // Cover the former one-second retry race as well as immediate teardown.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const finalLines = fs.readFileSync(lifecyclePath, 'utf8').trim().split('\n');
    assert.equal(finalLines.filter((line) => line.startsWith('start:')).length, 1);
    assert.equal(processAlive(pid), false, 'the owned stdio shim must be reaped');
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker crash reconnects the exact generation so a safe call can retry', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-broker-retry-'));
  const exitOnce = path.join(root, 'exit-on-call');
  fs.writeFileSync(exitOnce, '1');

  let cache = { enabled: true, version: 1, updatedAt: null };
  const generations = [];
  let connectionCount = 0;
  let resolveResult;
  let rejectResult;
  const resultReceived = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const call = (generation) => ({
    type: 'client_tool_call', call_id: 'safe-call-retried', generation,
    server: 'filesystem', tool: 'echo', args: { value: 'after-broker-restart' },
    account_id: 'network-broker-retry', session_id: 'session-broker-retry',
    idempotency_key: 'safe-call-retried', arguments_sha256: '1'.repeat(64),
    deadline_ms: 10_000,
  });
  server.on('connection', (ws) => {
    connectionCount += 1;
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'capability_hello') {
        generations.push(frame.generation);
        ws.send(JSON.stringify({
          type: 'capability_hello_ack', protocol: frame.protocol,
          device_id: 'device-broker-retry', account_id: 'network-broker-retry',
          client_instance_id: frame.client_instance_id,
          generation: frame.generation, accepted: true,
        }));
        ws.send(JSON.stringify(call(frame.generation)));
      } else if (frame.type === 'client_tool_result') {
        try {
          assert.equal(frame.call_id, 'safe-call-retried');
          assert.equal(frame.result.content[0].text, 'after-broker-restart');
          resolveResult(frame);
        } catch (error) {
          rejectResult(error);
        }
      }
    });
    ws.on('error', rejectResult);
  });

  const manager = new CapabilityManager({
    clientInstanceId: 'broker-retry-instance',
    deviceLabel: 'Broker Retry Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: {
        OPENAGENT_FAKE_ENABLED: '1',
        OPENAGENT_FAKE_EXIT_ON_CALL_ONCE_PATH: exitOnce,
      },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
    },
  });

  try {
    await manager.start();
    manager.addLoopback(
      'account-broker-retry', `http://127.0.0.1:${address.port}`,
      'gateway-broker-retry', 'network-broker-retry', 'device-broker-retry',
    );
    await Promise.race([
      resultReceived,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('safe call did not recover after broker crash')), 5000,
      )),
    ]);
    assert.equal(connectionCount, 2);
    assert.deepEqual(generations, [1, 1], 'transport recovery must keep exact generation');
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manager retains broker shell completion replay until its exact channel exists', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const principal = {
    kind: 'desktop',
    client_instance_id: 'replay-instance',
    device_label: 'Replay Desktop',
    account_id: 'network-replay',
    client_account_id: 'account-replay',
    network_id: 'network-replay',
    channel_id: 'gateway-replay',
    device_id: 'device-replay',
    generation: 1,
  };
  let cache = { enabled: false, version: 1, updatedAt: null };
  const manager = new CapabilityManager({
    clientInstanceId: 'replay-instance',
    deviceLabel: 'Replay Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: {
        OPENAGENT_FAKE_ENABLED: '1',
        OPENAGENT_FAKE_REPLAY_PRINCIPAL: JSON.stringify(principal),
      },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
    },
  });

  const received = new Promise((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'device-replay', account_id: 'network-replay',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
        } else if (frame.type === 'client_tool_event') {
          try {
            assert.equal(frame.event.shell_id, 'replayed-before-loopback');
            assert.equal(frame.event.principal, undefined);
            ws.send(JSON.stringify({
              type: 'client_tool_event_ack', generation: frame.generation,
              shell_id: frame.event.shell_id, accepted: true, duplicate: false,
            }));
            resolve();
          } catch (error) { reject(error); }
        }
      });
      ws.on('error', reject);
    });
  });

  try {
    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(server.clients.size, 0, 'replay must wait for its exact account loopback');
    manager.addLoopback(
      'account-replay', `http://127.0.0.1:${address.port}`,
      'gateway-replay', 'network-replay', 'device-replay',
    );
    await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('manager replay timed out')), 3000)),
    ]);
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('same network on two gateways keeps distinct principals and independent lifecycles', async () => {
  const gatewayA = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const gatewayB = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await Promise.all([
    new Promise((resolve) => gatewayA.once('listening', resolve)),
    new Promise((resolve) => gatewayB.once('listening', resolve)),
  ]);
  const addressA = gatewayA.address();
  const addressB = gatewayB.address();
  assert.equal(typeof addressA, 'object');
  assert.equal(typeof addressB, 'object');

  let cache = { enabled: true, version: 1, updatedAt: null };
  const manager = new CapabilityManager({
    clientInstanceId: 'multi-gateway-instance',
    deviceLabel: 'Multi Gateway Desktop',
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: { OPENAGENT_FAKE_ENABLED: '1' },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
    },
  });

  const connections = new Map();
  const firstResults = new Map();
  const secondResultB = deferred();
  const configureGateway = (server, channelId) => {
    server.on('connection', (ws) => {
      connections.set(channelId, ws);
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'capability_hello') {
          ws.send(JSON.stringify({
            type: 'capability_hello_ack', protocol: frame.protocol,
            device_id: 'shared-device', account_id: 'shared-network',
            client_instance_id: frame.client_instance_id,
            generation: frame.generation, accepted: true,
          }));
          sendEcho(ws, frame.generation, `first-${channelId}`, channelId);
        } else if (frame.type === 'client_tool_result') {
          try {
            assert.equal(frame.result._meta.principal.account_id, 'shared-network');
            assert.equal(frame.result._meta.principal.channel_id, channelId);
            assert.equal(frame.result._meta.principal.device_id, 'shared-device');
            assert.equal(frame.result._meta.principal.generation, frame.generation);
            if (frame.call_id === 'second-gateway-b') secondResultB.resolve(frame);
            else firstResults.get(channelId)?.resolve(frame);
          } catch (error) {
            if (frame.call_id === 'second-gateway-b') secondResultB.reject(error);
            else firstResults.get(channelId)?.reject(error);
          }
        }
      });
    });
  };
  configureGateway(gatewayA, 'gateway-a');
  configureGateway(gatewayB, 'gateway-b');
  firstResults.set('gateway-a', deferred());
  firstResults.set('gateway-b', deferred());

  try {
    await manager.start();
    manager.addLoopback(
      'local-a', `http://127.0.0.1:${addressA.port}`,
      'gateway-a', 'shared-network', 'shared-device',
    );
    manager.addLoopback(
      'local-b', `http://127.0.0.1:${addressB.port}`,
      'gateway-b', 'shared-network', 'shared-device',
    );
    await Promise.race([
      Promise.all([
        firstResults.get('gateway-a').promise,
        firstResults.get('gateway-b').promise,
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gateway calls timed out')), 3000)),
    ]);
    assert.equal(gatewayA.clients.size, 1);
    assert.equal(gatewayB.clients.size, 1);

    await manager.removeLoopback('local-a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(gatewayA.clients.size, 0);
    assert.equal(gatewayB.clients.size, 1, 'releasing gateway A must not release gateway B');
    const wsB = connections.get('gateway-b');
    assert.ok(wsB);
    sendEcho(wsB, manager.getStatus().generation, 'second-gateway-b', 'gateway-b');
    await Promise.race([
      secondResultB.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('remaining gateway call timed out')), 3000)),
    ]);
  } finally {
    await manager.shutdown();
    await Promise.all([
      new Promise((resolve) => gatewayA.close(resolve)),
      new Promise((resolve) => gatewayB.close(resolve)),
    ]);
  }
});

test('manager observes canonical consent changed by another local client while disabled', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-shared-consent-'));
  const consentPath = path.join(tempDir, 'enabled');
  fs.writeFileSync(consentPath, '0');

  let cache = { enabled: false, version: 1, updatedAt: null };
  let latestStatus = null;
  const manager = new CapabilityManager({
    clientInstanceId: 'shared-consent-desktop',
    deviceLabel: 'Shared Consent Desktop',
    statusPollMs: 20,
    hostLaunch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      env: { OPENAGENT_FAKE_CONSENT_PATH: consentPath },
      source: 'development',
    },
    consentStore: {
      get: () => cache,
      cacheCanonical: (enabled, version = 1, updatedAt = null) => {
        cache = { enabled, version, updatedAt };
        return cache;
      },
    },
    onStatus: (status) => { latestStatus = status; },
  });
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'capability_hello') {
        ws.send(JSON.stringify({
          type: 'capability_hello_ack', protocol: frame.protocol,
          device_id: 'shared-consent-device', account_id: 'shared-consent-network',
          client_instance_id: frame.client_instance_id,
          generation: frame.generation, accepted: true,
        }));
      }
    });
  });

  try {
    await manager.start();
    manager.addLoopback(
      'shared-consent-account', `http://127.0.0.1:${address.port}`,
      'shared-consent-gateway', 'shared-consent-network', 'shared-consent-device',
    );
    await waitUntil(() => latestStatus?.phase === 'disabled' && server.clients.size === 0);

    // Models `openagent-cli local-tools enable` changing the broker-owned
    // device consent while Desktop remains open.
    fs.writeFileSync(consentPath, '1');
    await waitUntil(() => latestStatus?.consent.enabled === true && server.clients.size === 1);
    const enabledGeneration = latestStatus.generation;

    // A CLI disable is enforced by the broker immediately and Desktop removes
    // its advertised catalog/socket on the next canonical status observation.
    fs.writeFileSync(consentPath, '0');
    await waitUntil(() => latestStatus?.phase === 'disabled' && server.clients.size === 0);
    assert.equal(latestStatus.consent.enabled, false);
    assert.ok(latestStatus.generation > enabledGeneration);
    assert.deepEqual(latestStatus.servers, []);
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function sendEcho(ws, generation, callId, value) {
  ws.send(JSON.stringify({
    type: 'client_tool_call', call_id: callId, generation,
    server: 'filesystem', tool: 'echo', args: { value }, session_id: 'interactive-session',
    account_id: 'shared-network', idempotency_key: `${callId}-idem`,
    arguments_sha256: '0'.repeat(64),
  }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
