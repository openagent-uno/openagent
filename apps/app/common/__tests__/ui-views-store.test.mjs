import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { beforeEach } from 'node:test';

import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const apiMock = {};
const connectionMock = { ws: null };

globalThis.__openagentUIViewStoreApi = apiMock;
globalThis.__openagentUIViewStoreConnection = connectionMock;

const storeEntry = fileURLToPath(
  new URL('../../universal/stores/uiViews.ts', import.meta.url),
);
const appRoot = fileURLToPath(new URL('../..', import.meta.url));

const bundle = await build({
  absWorkingDir: appRoot,
  bundle: true,
  entryPoints: [storeEntry],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  nodePaths: [
    fileURLToPath(new URL('../../universal/node_modules', import.meta.url)),
    fileURLToPath(new URL('../../desktop/node_modules', import.meta.url)),
  ],
  plugins: [{
    name: 'ui-view-store-test-boundaries',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({
        path: 'api', namespace: 'ui-view-test',
      }));
      buildApi.onResolve({ filter: /^\.\/connection$/ }, () => ({
        path: 'connection', namespace: 'ui-view-test',
      }));
      buildApi.onLoad({ filter: /^api$/, namespace: 'ui-view-test' }, () => ({
        loader: 'js',
        contents: `
          const api = globalThis.__openagentUIViewStoreApi;
          export const getUICapabilities = (...args) => api.getUICapabilities(...args);
          export const getUIView = (...args) => api.getUIView(...args);
          export const invokeUIViewAction = (...args) => api.invokeUIViewAction(...args);
          export const isUnsupportedByAgent = (...args) => api.isUnsupportedByAgent(...args);
          export const listUIViews = (...args) => api.listUIViews(...args);
          export const reactivateUIView = (...args) => api.reactivateUIView(...args);
        `,
      }));
      buildApi.onLoad({ filter: /^connection$/, namespace: 'ui-view-test' }, () => ({
        loader: 'js',
        contents: `
          const connection = globalThis.__openagentUIViewStoreConnection;
          export const useConnection = { getState: () => ({ ws: connection.ws }) };
        `,
      }));
    },
  }],
});

const bundledSource = bundle.outputFiles[0].text;
const { normalizeUIView, useUIViews } = await import(
  `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`
);

function view({
  id = 'view-1',
  revision = 1,
  value = null,
  version = 1,
  generation = 1,
  sequence = 1,
  status = 'ready',
  updatedAt = '2026-08-27T10:00:00.000Z',
  canExecute = true,
} = {}) {
  return {
    id,
    surface: 'sidebar',
    title: `View revision ${revision}`,
    revision,
    status: 'active',
    canExecute,
    schemaVersion: 1,
    spec: {
      schemaVersion: 1,
      root: { type: 'text', props: { value: `revision ${revision}` } },
    },
    data: {
      metrics: {
        value,
        version,
        generation,
        sequence,
        status,
        updatedAt,
      },
    },
    sources: {},
    actions: {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeWS {
  handlers = new Set();
  subscriptions = [];
  unsubscriptions = [];

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeUIView(subscriptionId, viewId, options) {
    this.subscriptions.push({ subscriptionId, viewId, options });
  }

  unsubscribeUIView(subscriptionId) {
    this.unsubscriptions.push(subscriptionId);
  }

  emit(message) {
    for (const handler of this.handlers) handler(message);
  }
}

beforeEach(() => {
  useUIViews.getState().clear();
  connectionMock.ws = null;
  Object.assign(apiMock, {
    getUICapabilities: async () => ({ version: 1, schemaVersions: [1] }),
    getUIView: async () => view(),
    invokeUIViewAction: async () => ({ ok: true }),
    isUnsupportedByAgent: () => false,
    listUIViews: async () => ({ items: [] }),
    reactivateUIView: async () => view(),
  });
  useUIViews.setState({ accountId: 'account-test' });
});

test('sidebar discovery respects the API page cap and follows cursors', async () => {
  const calls = [];
  apiMock.listUIViews = async (options) => {
    calls.push(options);
    if (!options.cursor) {
      return { items: [view({ id: 'view-a' })], nextCursor: 'page-2' };
    }
    return { items: [view({ id: 'view-b' })] };
  };

  await useUIViews.getState().loadList();

  assert.deepEqual(calls, [
    { surface: 'sidebar', limit: 100, cursor: undefined },
    { surface: 'sidebar', limit: 100, cursor: 'page-2' },
  ]);
  assert.deepEqual(
    useUIViews.getState().items.map((item) => item.id).sort(),
    ['view-a', 'view-b'],
  );
  assert.equal(useUIViews.getState().listError, null);
});

test('an out-of-order latest response cannot downgrade a newer rendered revision', async () => {
  const older = deferred();
  const newer = deferred();
  let request = 0;
  apiMock.getUIView = () => (request++ === 0 ? older.promise : newer.promise);

  const olderLoad = useUIViews.getState().loadView('view-1', true);
  const newerLoad = useUIViews.getState().loadView('view-1', true);

  newer.resolve(view({ revision: 2, value: 'new revision' }));
  assert.equal((await newerLoad)?.revision, 2);

  older.resolve(view({ revision: 1, value: 'late old revision' }));
  assert.equal((await olderLoad)?.revision, 2);
  assert.equal(useUIViews.getState().views['view-1'].revision, 2);
  assert.equal(useUIViews.getState().views['view-1'].data.metrics.value, 'new revision');
});

test('REST reconciliation orders data freshness by generation, sequence, then version', async () => {
  const responses = [
    view({ value: 'baseline', generation: 1, sequence: 10, version: 10 }),
    view({ value: 'older sequence', generation: 1, sequence: 9, version: 99 }),
    view({ value: 'new generation', generation: 2, sequence: 1, version: 1 }),
    view({ value: 'new version', generation: 2, sequence: 1, version: 2 }),
    view({ value: 'new sequence', generation: 2, sequence: 2, version: 1 }),
  ];
  apiMock.getUIView = async () => responses.shift();

  assert.equal((await useUIViews.getState().loadView('view-1', true))?.data.metrics.value, 'baseline');
  assert.equal((await useUIViews.getState().loadView('view-1', true))?.data.metrics.value, 'baseline');
  assert.equal((await useUIViews.getState().loadView('view-1', true))?.data.metrics.value, 'new generation');
  assert.equal((await useUIViews.getState().loadView('view-1', true))?.data.metrics.value, 'new version');
  assert.equal((await useUIViews.getState().loadView('view-1', true))?.data.metrics.value, 'new sequence');
});

test('live data cannot regress generation, sequence, or version', async () => {
  apiMock.getUIView = async () => view({
    value: 'baseline', generation: 2, sequence: 3, version: 3,
  });
  await useUIViews.getState().loadView('view-1', true);

  const ws = new FakeWS();
  connectionMock.ws = ws;
  useUIViews.getState().ensureWs();
  const dispose = useUIViews.getState().subscribe('view-1');
  const subscriptionId = ws.subscriptions.at(-1).subscriptionId;

  const emitData = (overrides) => ws.emit({
    type: 'ui_data',
    viewId: 'view-1',
    subscriptionId,
    key: 'metrics',
    status: 'ready',
    updatedAt: '2026-08-27T10:01:00.000Z',
    ...overrides,
  });

  emitData({ value: 'old generation', generation: 1, seq: 99, version: 99 });
  assert.equal(useUIViews.getState().views['view-1'].data.metrics.value, 'baseline');

  emitData({ value: 'old sequence', generation: 2, seq: 2, version: 99 });
  assert.equal(useUIViews.getState().views['view-1'].data.metrics.value, 'baseline');

  emitData({ value: 'old version', generation: 2, seq: 3, version: 2 });
  assert.equal(useUIViews.getState().views['view-1'].data.metrics.value, 'baseline');

  emitData({ value: 'next sequence', generation: 2, seq: 4, version: 1 });
  assert.equal(useUIViews.getState().views['view-1'].data.metrics.value, 'next sequence');

  emitData({ value: 'next generation', generation: 3, seq: 1, version: 1 });
  assert.equal(useUIViews.getState().views['view-1'].data.metrics.value, 'next generation');
  dispose();
});

test('actions use the rendered revision while sidebar refresh remains latest', async () => {
  const actionCalls = [];
  const viewCalls = [];
  apiMock.invokeUIViewAction = async (...args) => {
    actionCalls.push(args);
    return { ok: true };
  };
  apiMock.getUIView = async (viewId, requestedRevision) => {
    viewCalls.push({ viewId, requestedRevision });
    return view({ id: viewId, revision: requestedRevision ?? 8 });
  };
  useUIViews.setState({ views: { 'view-1': view({ revision: 7 }) } });

  await useUIViews.getState().invokeAction(
    'view-1', 'refresh-dashboard', { range: '7d' }, 7,
  );

  assert.deepEqual(actionCalls.map(([viewId, actionId, input, key, revision]) => ({
    viewId, actionId, input, hasIdempotencyKey: typeof key === 'string' && key.length > 0, revision,
  })), [{
    viewId: 'view-1',
    actionId: 'refresh-dashboard',
    input: { range: '7d' },
    hasIdempotencyKey: true,
    revision: 7,
  }]);
  assert.deepEqual(viewCalls, [{ viewId: 'view-1', requestedRevision: undefined }]);
  assert.equal(useUIViews.getState().views['view-1'].revision, 8);
});

test('inline actions keep both execution and refresh pinned to the rendered revision', async () => {
  const actionCalls = [];
  const viewCalls = [];
  apiMock.invokeUIViewAction = async (...args) => {
    actionCalls.push(args);
    return { ok: true };
  };
  apiMock.getUIView = async (viewId, requestedRevision) => {
    viewCalls.push({ viewId, requestedRevision });
    return view({ id: viewId, revision: requestedRevision });
  };
  useUIViews.setState({ views: { 'view-1@4': view({ revision: 4 }) } });

  await useUIViews.getState().invokeAction(
    'view-1', 'set-range', { range: '24h' }, 4, 4,
  );

  assert.equal(actionCalls[0][4], 4);
  assert.deepEqual(viewCalls, [{ viewId: 'view-1', requestedRevision: 4 }]);
  assert.equal(useUIViews.getState().views['view-1@4'].revision, 4);
  assert.equal(useUIViews.getState().views['view-1'], undefined);
});

test('action invocation is fail-closed when canExecute is absent or not a boolean grant', async () => {
  const actionCalls = [];
  const legacy = view({ revision: 3 });
  delete legacy.canExecute;
  apiMock.getUIView = async () => legacy;
  apiMock.invokeUIViewAction = async (...args) => {
    actionCalls.push(args);
    return { ok: true };
  };

  const loaded = await useUIViews.getState().loadView('view-1', true);
  assert.equal(loaded.canExecute, false);
  await assert.rejects(
    useUIViews.getState().invokeAction('view-1', 'set', {}, 3),
    /read-only/,
  );
  assert.equal(actionCalls.length, 0);

  assert.equal(normalizeUIView({ ...view(), canExecute: 1 }).canExecute, false);
  assert.equal(normalizeUIView({ ...view(), can_execute: true, canExecute: undefined }).canExecute, true);
});
