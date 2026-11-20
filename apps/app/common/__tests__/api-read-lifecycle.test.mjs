import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../universal/services/api.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false, target: 'node22',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (value) => ({ ok: true, json: async () => value, text: async () => '', blob: async () => null, arrayBuffer: async () => null });

async function fixture(fn) {
  const previous = globalThis.fetch;
  api.clearBaseUrl(); api.setBaseUrl('127.0.0.1', 1);
  try { await fn(); } finally { globalThis.fetch = previous; api.clearBaseUrl(); }
}

test('concurrent reads share network work only until the complete body is consumed', () => fixture(async () => {
  let calls = 0; const body = deferred();
  globalThis.fetch = async () => { calls++; return { ...response(null), json: () => body.promise }; };
  const a = api.getConfig(), b = api.getConfig();
  await Promise.resolve(); assert.equal(calls, 1);
  body.resolve({ name: 'fixture' });
  assert.deepEqual(await a, await b);
  await api.getConfig(); assert.equal(calls, 2);
}));

test('failed reads are evicted and retry performs a new request', () => fixture(async () => {
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw Error('offline'); return response({ name: 'recovered' }); };
  const results = await Promise.allSettled([api.getConfig(), api.getConfig()]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal((await api.getConfig()).name, 'recovered'); assert.equal(calls, 2);
}));

test('provider reads preserve member summaries and legacy owner catalog normalization', () => fixture(async () => {
  globalThis.fetch = async () => response({ providers: [], summaries: [{ id: 1, name: 'Connection', enabled: true }] });
  assert.deepEqual(await api.getProviderList(), { providers: [], summaries: [{ id: 1, name: 'Connection', enabled: true }] });
  globalThis.fetch = async () => response({ providers: [{ id: 1, name: 'Connection', framework: 'agno' }] });
  assert.deepEqual(await api.getProviders(), [{ id: 1, name: 'Connection', framework: 'api-based' }]);
}));

test('a write prevents a subsequent refresh from joining a pre-write snapshot', () => fixture(async () => {
  const old = deferred(); let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'PUT') return response({ ok: true, provider: { id: 1, name: 'fixture' } });
    return response(++calls === 1 ? await old.promise : { name: 'after-write' });
  };
  const stale = api.getConfig();
  await api.updateProvider(1, { enabled: false });
  assert.equal((await api.getConfig()).name, 'after-write');
  old.resolve({ name: 'before-write' }); await stale;
  assert.equal(calls, 2);
}));

test('source switches reject old bodies and never join the previous request', () => fixture(async () => {
  const old = deferred(); let calls = 0;
  globalThis.fetch = async () => ({ ...response(null), json: async () => ++calls === 1 ? old.promise : { name: 'other' } });
  const stale = api.getConfig();
  await Promise.resolve(); await Promise.resolve();
  api.clearBaseUrl(); api.setBaseUrl('127.0.0.1', 2);
  const rejected = assert.rejects(stale, /Agent selection changed/);
  assert.equal((await api.getConfig()).name, 'other');
  old.resolve({ name: 'old' }); await rejected;
}));

test('the request deadline remains active after headers until body completion', () => fixture(async () => {
  const timers = new Map(); let next = 0;
  const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => { const id = ++next; timers.set(id, callback); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  try {
    globalThis.fetch = async (_url, init) => ({ ...response(null), json: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Error(String(init.signal.reason))), { once: true });
    }) });
    const read = api.getConfig();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(timers.size, 1);
    const rejected = assert.rejects(read, /request timed out/);
    for (const callback of timers.values()) callback();
    await rejected; assert.equal(timers.size, 0);
  } finally { globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear; }
}));
