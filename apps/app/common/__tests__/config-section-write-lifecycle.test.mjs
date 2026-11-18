import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
  stdin: { contents: `export * as api from './universal/services/api';
    export { useConfig } from './universal/stores/config';`, resolveDir: root },
  nodePaths: [root + '/universal/node_modules', root + '/desktop/node_modules'],
});
// API, request sharing and config store are real; only the HTTP boundary is fake.
const { api, useConfig } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = (value, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => value, text: async () => JSON.stringify(value),
  blob: async () => null, arrayBuffer: async () => null,
});
function setup(t) {
  const previousFetch = globalThis.fetch;
  api.clearBaseUrl(); api.setBaseUrl('127.0.0.1', 1);
  useConfig.setState(useConfig.getInitialState(), true);
  const config = { name: 'Fixture agent', system_prompt: 'Fixture prompt', dream_mode: { enabled: false } };
  useConfig.setState({ config, sourceScope: api.currentAgentScope(), identityRevision: 'r1' });
  t.after(() => {
    globalThis.fetch = previousFetch;
    api.clearBaseUrl();
    useConfig.setState(useConfig.getInitialState(), true);
  });
  return config;
}

test('section save reads a fresh config instead of joining the pre-write load and keeps stale results fenced', async t => {
  const before = setup(t), oldBody = deferred();
  const calls = [];
  let serverConfig = before, configReads = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname, method = init.method || 'GET';
    calls.push({ method, path });
    if (method === 'PATCH') {
      serverConfig = { ...serverConfig, dream_mode: { enabled: true } };
      return response({ ok: true, restart_required: false, dream_mode: { enabled: true } });
    }
    if (path === '/api/agent/identity') return response({ name: 'Fixture agent', system_prompt: 'Fixture prompt', revision: 'r1' });
    assert.equal(path, '/api/config');
    return ++configReads === 1 ? { ...response(null), json: () => oldBody.promise } : response(serverConfig);
  };
  const staleLoad = useConfig.getState().loadConfig();
  await flush();
  const save = useConfig.getState().updateSection('dream_mode', { enabled: true });
  try {
    await flush();
    assert.equal(configReads, 2, 'Post-save GET must not join the pre-write request');
    assert.equal(await save, true);
    assert.equal(useConfig.getState().config.dream_mode.enabled, true);
    assert.equal(useConfig.getState().dirty, false);
    assert.deepEqual(calls.filter(call => call.path === '/api/config').map(call => call.method), ['GET', 'GET']);
  } finally {
    oldBody.resolve(before);
    await Promise.allSettled([staleLoad, save]);
  }
  assert.equal(useConfig.getState().config.dream_mode.enabled, true, 'Pre-write load cannot overwrite the save');
  assert.equal(useConfig.getState().sourceScope, api.currentAgentScope());
  assert.equal(useConfig.getState().identityRevision, 'r1');
});

test('denied section writes preserve ACL errors and do not reload or change confirmed config', async t => {
  const before = setup(t);
  useConfig.setState({ identityReadOnly: true });
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init.method || 'GET');
    return response({ error: { code: 'forbidden', message: 'Fixture permission denied' } }, 403);
  };
  await assert.rejects(api.updateConfigSection('name', 'Rejected'), error =>
    error instanceof api.ApiError && error.status === 403 && error.code === 'forbidden');
  assert.equal(await useConfig.getState().updateSection('dream_mode', { enabled: true }), false);
  assert.deepEqual(calls, ['PATCH', 'PATCH']);
  assert.deepEqual(useConfig.getState().config, before);
  assert.equal(useConfig.getState().error, 'Fixture permission denied');
  assert.equal(useConfig.getState().identityReadOnly, true);
});

test('the legacy scalar section payload and restart receipt remain unchanged', async t => {
  setup(t);
  let sent;
  const receipt = { ok: true, restart_required: false, name: 'Updated name', revision: 'r2' };
  globalThis.fetch = async (url, init) => { sent = { path: new URL(url).pathname, method: init.method,
    body: init.body, contentType: init.headers['Content-Type'] }; return response(receipt); };
  assert.deepEqual(await api.updateConfigSection('name', 'Updated name'), receipt);
  assert.deepEqual(sent, { path: '/api/config/name', method: 'PATCH', body: '"Updated name"', contentType: 'application/json' });
});

test('an account switch while PATCH is pending prevents refresh and cannot replace the new account', async t => {
  setup(t);
  const pendingResponse = deferred(), calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(init.method || 'GET'); return pendingResponse.promise; };
  const save = useConfig.getState().updateSection('dream_mode', { enabled: true });
  api.clearBaseUrl(); api.setBaseUrl('127.0.0.1', 2);
  useConfig.setState({ ...useConfig.getInitialState(), config: { name: 'Other account' }, sourceScope: api.currentAgentScope() }, true);
  pendingResponse.resolve(response({ ok: true, restart_required: false }));
  assert.equal(await save, false);
  assert.deepEqual(calls, ['PATCH']);
  assert.equal(useConfig.getState().config.name, 'Other account');
  assert.equal(useConfig.getState().error, null);
});

test('section PATCH keeps its normalized timeout until the response body completes', async t => {
  setup(t);
  const timers = new Map(); let nextTimer = 0;
  const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout;
  globalThis.setTimeout = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  try {
    globalThis.fetch = async (_url, init) => ({ ...response(null), json: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error(String(init.signal.reason))), { once: true });
    }) });
    const rejected = assert.rejects(api.updateConfigSection('dream_mode', { enabled: true }),
      /request timed out after 30000ms: PATCH \/api\/config\/dream_mode/);
    await flush();
    assert.equal(timers.size, 1);
    for (const timeout of timers.values()) timeout();
    await rejected;
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear;
  }
});
