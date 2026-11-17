/**
 * Deterministic store/network baseline, without a server, React or wall-clock sleeps.
 * Run: node --test apps/app/common/__tests__/config-loading.benchmark.mjs
 * Diagnostics report virtual milliseconds and actual requests from the real store.
 * Latency/call-count ceilings preserve the measured parallel/singleflight gains.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: "export { useConfig } from './universal/stores/config';", resolveDir: root },
  nodePaths: [root + '/universal/node_modules', root + '/desktop/node_modules'],
  plugins: [{ name: 'config-network-fixture', setup(api) {
    api.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    api.onLoad({ filter: /^api$/, namespace: 'fixture' }, () => ({ contents: `
      export class ApiError extends Error {
        constructor(status, message) { super(message); this.status = status; }
      }
      export const currentAgentScope = () => globalThis.__configLoadingBenchmark.scope;
      const request = endpoint => globalThis.__configLoadingBenchmark.request(endpoint).catch(error => {
        throw new ApiError(error.status, error.message);
      });
      export const getConfig = () => request('config');
      export const getAgentIdentity = () => request('identity');
      export const isUnsupportedByAgent = error => error instanceof ApiError && [404, 405].includes(error.status);
      export const updateConfigSection = (...args) => globalThis.__configLoadingBenchmark.updateSection(...args);
      export const updateAgentIdentity = input => globalThis.__configLoadingBenchmark.updateIdentity(input);
    ` }));
  } }],
});
const { useConfig } = await import('data:text/javascript;base64,' +
  Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const initialState = useConfig.getState();
const CONFIG_MS = 120;
const IDENTITY_MS = 180;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup(t, { identityStatus, configStatus, canManage = true, scopeLatencies = {} } = {}) {
  let now = 0, running = 0, peakRequests = 0;
  const queue = [], requests = [];
  const fixture = {
    scope: 'fixture-agent',
    updateSection: async () => {},
    updateIdentity: async input => ({ ...input, revision: 'edited-r2', channel_presentation: { chat: 'pending' } }),
    request(endpoint) {
      const scope = fixture.scope;
      const record = { endpoint, scope, startMs: now, endMs: null };
      requests.push(record);
      peakRequests = Math.max(peakRequests, ++running);
      return new Promise((resolve, reject) => {
        const delay = scopeLatencies[scope]?.[endpoint] ?? (endpoint === 'config' ? CONFIG_MS : IDENTITY_MS);
        queue.push({ at: now + delay, settle() {
          running--;
          record.endMs = now;
          const status = endpoint === 'config' ? configStatus : identityStatus;
          if (status) {
            const error = new Error(`${endpoint} unavailable`);
            error.status = status;
            reject(error);
          } else resolve(endpoint === 'config'
            ? { name: 'Config name', system_prompt: 'Config prompt', preserved: true, agent_scope: scope }
            : { name: 'Identity name', system_prompt: 'Identity prompt', revision: 'r1',
                channel_presentation: { chat: 'ready' }, can_manage: canManage });
        } });
      });
    },
  };
  globalThis.__configLoadingBenchmark = fixture;
  useConfig.setState(initialState, true);
  t.after(() => { useConfig.setState(initialState, true); delete globalThis.__configLoadingBenchmark; });
  const advance = async () => {
    await flush();
    assert.ok(queue.length, 'Store is pending with no simulated network work');
    queue.sort((a, b) => a.at - b.at);
    now = queue[0].at;
    const due = queue.filter(item => item.at === now);
    queue.splice(0, due.length);
    for (const item of due) item.settle();
    await flush();
  };
  return {
    fixture,
    advance,
    async finish(pending) {
      let settled = false;
      const joined = Promise.all(pending).finally(() => { settled = true; });
      for (let step = 0; step < 50 && !settled; step++) {
        await flush();
        if (settled) break;
        await advance();
      }
      assert.ok(settled, 'Virtual scheduler exceeded its bounded work budget');
      await joined;
      const counts = Object.fromEntries(['config', 'identity'].map(endpoint =>
        [endpoint, requests.filter(request => request.endpoint === endpoint).length]));
      const sample = { elapsedMs: now, counts, peakRequests, requests };
      t.diagnostic(JSON.stringify(sample));
      return sample;
    },
  };
}

for (const callers of [1, 2]) {
  test(`${callers} concurrent config load caller(s): latency and duplicate request baseline`, async t => {
    const harness = setup(t);
    const pending = Array.from({ length: callers }, () => useConfig.getState().loadConfig());
    if (callers === 2) assert.equal(pending[0], pending[1]);
    assert.equal(useConfig.getState().loading, true);
    const sample = await harness.finish(pending);
    assert.ok(sample.elapsedMs >= Math.max(CONFIG_MS, IDENTITY_MS));
    assert.ok(sample.elapsedMs <= Math.max(CONFIG_MS, IDENTITY_MS), 'Independent reads must run in parallel');
    for (const endpoint of ['config', 'identity']) {
      assert.equal(sample.counts[endpoint], 1, `${endpoint} must be shared by concurrent callers`);
    }
    assert.equal(useConfig.getState().config.name, 'Identity name');
    assert.equal(useConfig.getState().config.preserved, true);
    assert.equal(useConfig.getState().identityRevision, 'r1');
    assert.equal(useConfig.getState().loading, false);
  });
}

test('unsupported identity preserves configuration compatibility', async t => {
  const harness = setup(t, { identityStatus: 404 });
  await harness.finish([useConfig.getState().loadConfig()]);
  assert.equal(useConfig.getState().config.name, 'Config name');
  assert.equal(useConfig.getState().identityError, null);
  assert.equal(useConfig.getState().loading, false);
});

test('config failure does not leave loading pending', async t => {
  const harness = setup(t, { configStatus: 503 });
  await harness.finish([useConfig.getState().loadConfig()]);
  assert.equal(useConfig.getState().error, 'config unavailable');
  assert.equal(useConfig.getState().loading, false);
});

test('an account switch fences the previous scope response', async t => {
  const harness = setup(t);
  const pending = useConfig.getState().loadConfig();
  harness.fixture.scope = 'next-fixture-agent';
  useConfig.setState({ ...initialState, config: { name: 'Next account' } }, true);
  await harness.finish([pending]);
  assert.equal(useConfig.getState().config.name, 'Next account');
  assert.equal(useConfig.getState().loading, false);
});

test('a new account does not join the old account singleflight', async t => {
  const harness = setup(t, { scopeLatencies: { 'next-fixture-agent': { config: 20, identity: 30 } } });
  const oldLoad = useConfig.getState().loadConfig();
  await flush();
  harness.fixture.scope = 'next-fixture-agent';
  const newLoad = useConfig.getState().loadConfig();
  assert.notEqual(oldLoad, newLoad);
  const sample = await harness.finish([oldLoad, newLoad]);
  assert.deepEqual(sample.counts, { config: 2, identity: 2 });
  assert.equal(useConfig.getState().config.agent_scope, 'next-fixture-agent');
  assert.equal(useConfig.getState().loading, false);
});

for (const status of [403, 405, 500]) {
  test(`identity ${status} preserves authorization and compatibility semantics`, async t => {
    const harness = setup(t, { identityStatus: status });
    await harness.finish([useConfig.getState().loadConfig()]);
    const state = useConfig.getState();
    assert.equal(state.config.name, 'Config name');
    assert.equal(state.config.system_prompt, status === 403 ? undefined : 'Config prompt');
    assert.equal(state.identityReadOnly, status === 403);
    assert.equal(state.identityError, status === 405 ? null : 'identity unavailable');
    assert.equal(state.loading, false);
  });
}

test('an identity read without management permission remains read-only', async t => {
  const harness = setup(t, { canManage: false });
  await harness.finish([useConfig.getState().loadConfig()]);
  assert.equal(useConfig.getState().identityReadOnly, true);
});

test('an older load cannot overwrite a newer local config mutation', async t => {
  const harness = setup(t);
  const pending = useConfig.getState().loadConfig();
  await flush();
  useConfig.getState().setConfig({ name: 'Local draft', system_prompt: 'Local prompt' });
  await harness.finish([pending]);
  assert.equal(useConfig.getState().config.name, 'Local draft');
  assert.equal(useConfig.getState().dirty, true);
  assert.equal(useConfig.getState().loading, false);
});

test('a confirmed identity edit keeps its optimistic revision during an older refresh', async t => {
  const harness = setup(t);
  useConfig.setState({ config: { name: 'Previous name' }, sourceScope: harness.fixture.scope, identityRevision: 'confirmed-r1' });
  let write;
  harness.fixture.updateIdentity = async input => {
    write = input;
    return { ...input, revision: 'edited-r2', channel_presentation: { chat: 'pending' } };
  };
  const pending = useConfig.getState().loadConfig();
  // Config has arrived; identity remains outstanding when the write commits.
  await harness.advance();
  await useConfig.getState().updateIdentity('Edited name', 'Edited prompt', 'new-thumbnail');
  await harness.finish([pending]);
  assert.equal(write.expected_revision, 'confirmed-r1');
  assert.equal(useConfig.getState().config.name, 'Edited name');
  assert.equal(useConfig.getState().config.system_prompt, 'Edited prompt');
  assert.equal(useConfig.getState().identityRevision, 'edited-r2');
  assert.equal(useConfig.getState().thumbnail, 'new-thumbnail');
  assert.deepEqual(useConfig.getState().channelPresentation, { chat: 'pending' });
  assert.equal(useConfig.getState().loading, false);
});

test('a read started while an identity write is pending cannot overwrite its receipt', async t => {
  const harness = setup(t);
  let commit;
  harness.fixture.updateIdentity = input => new Promise(resolve => {
    commit = () => resolve({ ...input, revision: 'edited-r2' });
  });
  const write = useConfig.getState().updateIdentity('Edited name', 'Edited prompt');
  const read = useConfig.getState().loadConfig();
  await flush();
  commit();
  await write;
  await harness.finish([read]);
  assert.equal(useConfig.getState().config.name, 'Edited name');
  assert.equal(useConfig.getState().identityRevision, 'edited-r2');
});

test('a post-mutation refresh does not join a stale pre-mutation read', async t => {
  const harness = setup(t);
  const oldLoad = useConfig.getState().loadConfig();
  await flush();
  useConfig.getState().setConfig({ name: 'Local draft' });
  const newLoad = useConfig.getState().loadConfig();
  assert.notEqual(oldLoad, newLoad);
  await harness.finish([oldLoad, newLoad]);
  assert.equal(useConfig.getState().config.name, 'Identity name');
  assert.equal(useConfig.getState().loading, false);
});

test('settled singleflight entries do not suppress a later explicit refresh', async t => {
  const harness = setup(t);
  const first = useConfig.getState().loadConfig();
  await harness.finish([first]);
  const second = useConfig.getState().loadConfig();
  assert.notEqual(first, second);
  const sample = await harness.finish([second]);
  assert.deepEqual(sample.counts, { config: 2, identity: 2 });
});

test('identity rejection before config settles is handled even when config also fails', async t => {
  const harness = setup(t, { configStatus: 503, identityStatus: 500,
    scopeLatencies: { 'fixture-agent': { identity: 10 } } });
  await harness.finish([useConfig.getState().loadConfig()]);
  assert.equal(useConfig.getState().error, 'config unavailable');
  assert.equal(useConfig.getState().loading, false);
});

test('identity rejection after a config failure is observed without an unhandled rejection', async t => {
  const harness = setup(t, { configStatus: 503, identityStatus: 500 });
  await harness.finish([useConfig.getState().loadConfig()]);
  await harness.advance();
  assert.equal(useConfig.getState().error, 'config unavailable');
  assert.equal(useConfig.getState().loading, false);
});

test('starting another scope synchronously removes the previous agent config and presentation', async t => {
  const harness = setup(t);
  useConfig.setState({ config: { name: 'Previous agent', system_prompt: 'Previous prompt' },
    sourceScope: harness.fixture.scope, identityRevision: 'previous-r1', thumbnail: 'Previous image',
    channelPresentation: { telegram: 'pending' }, identityLoading: true, dirty: true });
  harness.fixture.scope = 'next-fixture-agent';
  const pending = useConfig.getState().loadConfig();
  assert.equal(useConfig.getState().config, null);
  assert.equal(useConfig.getState().sourceScope, 'next-fixture-agent');
  assert.equal(useConfig.getState().thumbnail, undefined);
  assert.equal(useConfig.getState().identityRevision, null);
  assert.equal(useConfig.getState().identityLoading, false);
  assert.equal(useConfig.getState().dirty, false);
  assert.deepEqual(useConfig.getState().channelPresentation, {});
  await harness.finish([pending]);
  assert.equal(useConfig.getState().sourceScope, 'next-fixture-agent');
  assert.equal(useConfig.getState().config.agent_scope, 'next-fixture-agent');
});

test('same-scope loading retains confirmed fields and revision until refreshed', async t => {
  const harness = setup(t);
  useConfig.setState({ config: { name: 'Confirmed agent' }, sourceScope: harness.fixture.scope,
    identityRevision: 'confirmed-r1', thumbnail: 'Confirmed image' });
  const pending = useConfig.getState().loadConfig();
  assert.equal(useConfig.getState().config.name, 'Confirmed agent');
  assert.equal(useConfig.getState().identityRevision, 'confirmed-r1');
  assert.equal(useConfig.getState().thumbnail, 'Confirmed image');
  await harness.finish([pending]);
  assert.equal(useConfig.getState().sourceScope, harness.fixture.scope);
});

test('a new-scope identity write cannot inherit the previous config or optimistic revision', async t => {
  const harness = setup(t);
  useConfig.setState({ config: { name: 'Previous agent', previousOnly: true },
    sourceScope: harness.fixture.scope, identityRevision: 'previous-r1' });
  harness.fixture.scope = 'next-fixture-agent';
  let submitted;
  harness.fixture.updateIdentity = async input => { submitted = input; return { ...input, revision: 'next-r1' }; };
  await useConfig.getState().updateIdentity('Next agent', 'Next prompt');
  assert.equal(submitted.expected_revision, undefined);
  assert.equal(useConfig.getState().config.previousOnly, undefined);
  assert.equal(useConfig.getState().sourceScope, 'next-fixture-agent');
});
