import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { discoverHostTools, LocalHostBridge } from '../../../dist/capabilities/host-bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function testPeer(env = {}) {
  return new LocalHostBridge({
    launch: {
      command: process.execPath,
      args: [path.join(here, 'host-bridge-peer.mjs')],
      source: 'development', env,
    },
    principal: { kind: 'desktop', client_instance_id: 'test-instance' },
  });
}

function toolCall(extra = {}) {
  return {
    callId: 'call-test', server: 'filesystem', tool: 'echo', toolArgs: {},
    idempotencyKey: 'idem-test', argumentsSha256: '0'.repeat(64), ...extra,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Expected peer condition within one second');
}

test('NDJSON host bridge initializes, shares consent, catalogs and invokes', async () => {
  const bridge = new LocalHostBridge({
    launch: {
      command: process.execPath,
      args: [path.join(here, 'fake-host.mjs')],
      source: 'development',
    },
    principal: { kind: 'desktop', client_instance_id: 'test-instance' },
  });
  try {
    const initialized = await bridge.start();
    assert.equal(initialized.consent.enabled, false);
    await bridge.setConsent(true);
    const status = await bridge.status();
    assert.equal(status.consent.enabled, true);
    const catalog = await bridge.catalog();
    assert.equal(catalog.servers[0].name, 'filesystem');
    const result = await bridge.call({
      callId: 'call-1', server: 'filesystem', tool: 'echo',
      toolArgs: { value: 'hello' }, idempotencyKey: 'idem-1',
      argumentsSha256: '0'.repeat(64),
    });
    assert.equal(result.content[0].text, 'hello');
  } finally {
    await bridge.stop();
  }
});

test('packaged discovery pins executable and the complete host bundle manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-host-pin-'));
  try {
    const key = `${process.platform}-${process.arch}`;
    const name = process.platform === 'win32' ? 'openagent-host-tools.exe' : 'openagent-host-tools';
    const executable = path.join(root, 'host-tools', key, name);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'trusted-host-binary');
    const executableBytes = fs.readFileSync(executable);
    const sha256 = createHash('sha256').update(executableBytes).digest('hex');
    const bundleManifestPath = path.join(path.dirname(executable), 'bundle-manifest.json');
    fs.writeFileSync(bundleManifestPath, JSON.stringify({
      manifest_version: 1,
      version: '0.1.0',
      platform: key,
      files: { [name]: { size: executableBytes.length, sha256 } },
    }));
    const bundleManifestSha256 = createHash('sha256')
      .update(fs.readFileSync(bundleManifestPath)).digest('hex');
    const manifestPath = path.join(root, 'host-tools-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      host_tools_version: '0.1.0',
      bundles: { [key]: {
        executable: `${key}/${name}`,
        size: executableBytes.length,
        sha256,
        host_tools_version: '0.1.0',
        bundle_manifest: `${key}/bundle-manifest.json`,
        bundle_manifest_sha256: bundleManifestSha256,
        file_count: 1,
      } },
    }));
    const options = {
      isPackaged: true, resourcesPath: root, appPath: root, manifestPath,
      platform: process.platform, arch: process.arch,
    };
    assert.equal(discoverHostTools(options).unavailableReason, undefined);
    fs.appendFileSync(executable, '-tampered');
    assert.match(discoverHostTools(options).unavailableReason, /integrity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('development discovery prefers the canonical product host-tools component', () => {
  const root = path.resolve('/openagent-test');
  const appPath = path.join(root, 'apps/app/desktop');
  const component = path.join(root, 'packages/host-tools');
  const main = path.join(component, 'src/openagent_host_tools/__main__.py');
  const legacyMain = path.resolve(appPath, '../../openagent-host-tools/src/openagent_host_tools/__main__.py');
  const launch = discoverHostTools({
    isPackaged: false, resourcesPath: '/missing-resource-path', appPath,
    env: { OPENAGENT_HOST_TOOLS_PYTHON: '/test/python', PYTHONPATH: '/installed/dependencies' },
    exists: (candidate) => candidate === main || candidate === legacyMain,
  });
  assert.equal(launch.cwd, component);
  assert.equal(launch.command, '/test/python');
  assert.deepEqual(launch.args, ['-m', 'openagent_host_tools']);
  assert.equal(launch.env.PYTHONPATH, `${path.join(component, 'src')}${path.delimiter}/installed/dependencies`);
});

test('concurrent starts share one completed handshake', async () => {
  const bridge = testPeer();
  try {
    const [first, second] = await Promise.all([bridge.start(), bridge.start()]);
    assert.equal(first.pid, second.pid);
    assert.equal(bridge.running, true);
  } finally {
    await bridge.hardStop();
  }
});

test('failed initialize retires its executor before returning', async () => {
  const bridge = testPeer({ OPENAGENT_TEST_BRIDGE_REJECT_INITIALIZE: '1' });
  const pending = bridge.start();
  const child = bridge.child;
  await assert.rejects(pending, { code: 'initialize_rejected' });
  assert.equal(bridge.running, false);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(bridge.status(), { code: 'host_unavailable' });
});

for (const invalidFrame of [null, [], 'non-json', 'invalid-ok', { type: 'event', event: null }]) {
  test(`invalid peer frame retires the transport: ${JSON.stringify(invalidFrame)}`, async () => {
    const bridge = testPeer();
    const errors = [];
    bridge.on('protocol-error', (error) => errors.push(error));
    try {
      await bridge.start();
      await assert.rejects(bridge.call(toolCall({ toolArgs: { invalidFrame } })), { code: 'host_transport_lost' });
      assert.equal(bridge.running, false);
      assert.equal(errors.length, 1);
    } finally {
      await bridge.hardStop();
    }
  });
}

test('retired process stdout and stderr cannot affect its replacement', async () => {
  const bridge = testPeer();
  const events = [];
  const stderr = [];
  bridge.on('event', (event) => events.push(event));
  bridge.on('stderr', (chunk) => stderr.push(chunk));
  try {
    await bridge.start();
    const retired = bridge.child;
    await bridge.hardStop();
    const current = await bridge.start();
    retired.stdout.emit('data', '{"type":"event","event":{"type":"shell_completed"}}\n');
    retired.stderr.emit('data', 'retired host stderr');
    retired.stdout.emit('data', 'null\n');
    assert.deepEqual(events, []);
    assert.deepEqual(stderr, []);
    assert.equal((await bridge.status()).pid, current.pid);
  } finally {
    await bridge.hardStop();
  }
});

test('protocol retirement waits for a peer that requires forced termination', {
  skip: process.platform === 'win32',
}, async () => {
  const bridge = testPeer({ OPENAGENT_TEST_BRIDGE_IGNORE_TERM: '1' });
  try {
    await bridge.start();
    const child = bridge.child;
    await assert.rejects(bridge.call(toolCall({ toolArgs: { invalidFrame: null } })), { code: 'host_transport_lost' });
    await bridge.hardStop();
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(bridge.running, false);
  } finally {
    await bridge.hardStop();
  }
});

test('abort rejects promptly and sends cancellation once without replaying the call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-bridge-abort-'));
  const journal = path.join(root, 'journal.jsonl');
  const bridge = testPeer({ OPENAGENT_TEST_BRIDGE_JOURNAL: journal });
  const records = () => fs.existsSync(journal)
    ? fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  try {
    await bridge.start();
    const abort = new AbortController();
    const pending = bridge.call(toolCall({ toolArgs: { hold: true }, signal: abort.signal }));
    await waitFor(() => records().some((entry) => entry.type === 'call'));
    abort.abort();
    await assert.rejects(pending, { code: 'cancelled' });
    await waitFor(() => records().some((entry) => entry.type === 'cancel'));
    assert.equal(records().filter((entry) => entry.type === 'call').length, 1);
    assert.equal(records().filter((entry) => entry.type === 'cancel').length, 1);
    await bridge.status();
  } finally {
    await bridge.hardStop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('call deadline cancels outstanding work and rejects invalid deadlines before dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-bridge-deadline-'));
  const journal = path.join(root, 'journal.jsonl');
  const bridge = testPeer({ OPENAGENT_TEST_BRIDGE_JOURNAL: journal });
  const records = () => fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  try {
    await bridge.start();
    for (const deadlineMs of [0, -1, NaN, Infinity, Date.now() - 1_000, 86_400_001]) {
      await assert.rejects(bridge.call(toolCall({ deadlineMs })), { code: 'invalid_deadline' });
    }
    assert.equal(records().filter((entry) => entry.type === 'call').length, 0);
    await assert.rejects(bridge.call(toolCall({ toolArgs: { hold: true }, deadlineMs: 20 })), { code: 'host_timeout' });
    await waitFor(() => records().some((entry) => entry.type === 'cancel'));
    assert.equal(records().filter((entry) => entry.type === 'call').length, 1);
    await bridge.call(toolCall({ callId: 'absolute-deadline', deadlineMs: Date.now() + 1_000 }));
  } finally {
    await bridge.hardStop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('operator provider control has fixed browser server and explicit main-owned principal', async()=>{
 const bridge=testPeer();
 try{
  await bridge.start();
  const principal={client_instance_id:'selected-main',network_id:'certified-network'};
  const result=await bridge.providerControl({tool:'browser_control',args:{action:'resume',tabId:1,request_id:'pending'},principal});
  assert.equal(result.request.type,'provider_control');assert.equal(result.request.server,'agent-in-chrome');
  assert.deepEqual(result.request.principal,principal);assert.match(result.request.call_id,/operator-/);
  assert.equal(result.request._meta,undefined);
  const abort=new AbortController();
  const held=bridge.providerControl({tool:'browser_control',args:{hold:true},principal},abort.signal);
  const rejection=assert.rejects(held,error=>error.code==='cancelled');abort.abort();await rejection;
 }finally{await bridge.stop()}
});
