import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import runTest from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { CapabilityManager } from '../../../dist/capabilities/manager.js';
import { fileAccessRequest, offerFileAccess } from '../../../dist/capabilities/file-access.js';

// The Electron fixture cannot wait for Node's process-idle test summary.
const tests = [];
const test = (...args) => tests.push(runTest(...args));
export const complete = () => Promise.all(tests);

if (process.platform === 'darwin' && !process.versions.electron) {
  test('macOS releases an expired selection sheet before another account retries', { timeout: 25000 }, async () => {
    const { default: executable } = await import('electron');
    const fixture = fileURLToPath(new URL('./file-access-dialog-electron.cjs', import.meta.url));
    await promisify(execFile)(executable, [fixture], { timeout: 20000 });
  });
}

test('desktop returns approval and denial through the authenticated tool socket', { timeout: 6000 }, async t => {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'openagent-file-access-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const file = join(temporary, 'sample.txt');
  await writeFile(file, 'synthetic permission receipt');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const consent = { enabled: true, version: 1, updatedAt: null };
  let selection = null;
  let prompts = 0;
  const appHasAccess = process.platform === 'darwin';
  const manager = new CapabilityManager({
    clientInstanceId: 'fixture-instance',
    deviceLabel: 'Fixture Mac',
    hostLaunch: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fake-host.mjs', import.meta.url))],
      env: { OPENAGENT_FAKE_ENABLED: '1', OPENAGENT_FAKE_DENIED_FILE: file,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      source: 'development',
    },
    consentStore: { get: () => consent, cacheCanonical: () => consent },
    pickFileAccess: async request => {
      assert.deepEqual(request, { accountId: 'fixture-account', path: file, directory: false });
      prompts++;
      if (selection === file && appHasAccess) await chmod(file, 0o600);
      return selection;
    },
  });
  const registered = new Promise(resolve => server.once('connection', socket => {
    socket.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.type !== 'capability_hello') return;
      socket.send(JSON.stringify({
        type: 'capability_hello_ack', protocol: frame.protocol, accepted: true,
        device_id: 'fixture-device', account_id: 'fixture-network',
        client_instance_id: frame.client_instance_id, generation: frame.generation,
      }));
      resolve({socket, generation: frame.generation});
    });
  }));
  manager.addLoopback('fixture-account', `http://127.0.0.1:${server.address().port}`,
    'fixture-gateway', 'fixture-network', 'fixture-device');
  try {
    await manager.start();
    const { socket, generation } = await registered;
    async function call(id, session) {
      const response = once(socket, 'message');
      socket.send(JSON.stringify({
        type: 'client_tool_call', call_id: id, generation, account_id: 'fixture-network',
        server: 'filesystem', tool: 'read_text_file', args: { path: file }, session_id: session,
        idempotency_key: id, arguments_sha256: '0'.repeat(64),
      }));
      return JSON.parse((await response)[0]);
    }
    const initial = await call('permission-check', 'fixture-session');
    if (appHasAccess) {
      assert.equal(initial.result._meta.permission, 'application_access');
      assert.equal(prompts, 0);
    }
    const canDenyRead = !appHasAccess || process.getuid?.() !== 0;
    if (canDenyRead) {
      if (appHasAccess) {
        await chmod(file, 0o000);
        const denied = await call('permission-denied', 'fixture-session');
        assert.equal(denied.error.code, 'file_permission_denied');
      } else {
        assert.equal(initial.error.code, 'file_permission_denied');
      }
    }
    selection = file;
    const approved = await call('approved', 'fixture-session');
    assert.equal(approved.result.content[0].text, 'synthetic permission receipt');
    assert.equal(approved.result._meta.permission, canDenyRead ? 'granted_once' : 'application_access');
    const unattended = await call('no-session', null);
    assert.equal(unattended.result.isError, true);
    assert.equal(prompts, canDenyRead ? 2 : 0);
  } finally {
    await manager.shutdown();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an invalid text slice never prompts or reads and valid slices preserve text boundaries', async t => {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'openagent-file-lines-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, 'sample.txt');
  await writeFile(path, 'first\r\nsecond\u2028third\r');
  const signal = new AbortController().signal;
  const request = { accountId: 'fixture-account', path, directory: false };
  const rejected = [true, [], {}, '', '0x2'];
  for (const head of rejected) {
    const call = { server: 'filesystem', tool: 'read_text_file', args: { path, head }, session_id: 'fixture' };
    await assert.rejects(offerFileAccess(
      async () => { assert.fail('invalid arguments prompted the user'); },
      request, call, signal, () => true, { useApplicationAccess: true },
    ), { code: 'invalid_arguments' });
  }
  const call = { server: 'filesystem', tool: 'read_text_file', args: { path, head: 2 }, session_id: 'fixture' };
  const read = await offerFileAccess(async () => path, request, call, signal, () => true);
  assert.equal(read.content[0].text, 'first\nsecond');
});

test('a mismatched selection, withdrawn consent or expired request never reads the file', async t => {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'openagent-file-request-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, 'sample.txt');
  await writeFile(path, 'synthetic fixture');
  const signal = new AbortController().signal;
  const call = { server: 'filesystem', tool: 'attach_file', args: { path }, session_id: 'fixture-session' };
  const outcome = { isError: true, _meta: { 'openagent/error': { code: 'filesystem_access_denied', data: { path } } } };
  const request = fileAccessRequest('sample-account', call, outcome);
  assert.equal(fileAccessRequest('sample-account', call, {
    isError: true, _meta: { 'openagent/error': { code: 'access_denied', data: { path } } },
  }), undefined);
  await assert.rejects(offerFileAccess(async () => join(temporary, 'other.txt'), request, call, signal, () => true),
    { code: 'file_permission_denied' });
  let allowed = true;
  await assert.rejects(offerFileAccess(async () => {
    allowed = false;
    return path;
  }, request, call, signal, () => allowed), { code: 'cancelled' });
  const late = new Promise(resolve => setTimeout(() => resolve(path), 80));
  await assert.rejects(offerFileAccess(() => late, request, call, signal, () => true, { timeoutMs: 20 }), { code: 'file_permission_timeout' });
  await assert.rejects(offerFileAccess(async () => null, request, call, signal, () => true), { code: 'file_permission_denied' });
  await late;
  const approved = await offerFileAccess(async () => path, request, call, signal, () => true);
  assert.equal(approved.content[0]._meta['openagent/file-delivery'].filename, 'sample.txt');
  assert.equal(Buffer.from(approved.content[0].resource.blob, 'base64').toString(), 'synthetic fixture');
});
