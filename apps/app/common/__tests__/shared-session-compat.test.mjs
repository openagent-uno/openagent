import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { build } = await import(process.env.OPENAGENT_TEST_ESBUILD || '../../desktop/node_modules/esbuild/lib/main.js');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../universal/services/ws.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { OpenAgentWS } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

function response(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('metadata-less collaboration gateway preserves an existing session title', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).endsWith('/api/sessions/chat')) return response(405);
    if (String(url).includes('/api/sessions?limit=200')) {
      return response(200, { sessions: [{ session_id: 'chat', title: 'Keep me' }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const ws = new OpenAgentWS('ws://127.0.0.1:8765/ws');
  assert.equal(await ws.ensureSharedSession('chat', 'Replacement title'), false);
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET']);
});

test('metadata-less collaboration gateway creates a new session through PATCH', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (String(url).endsWith('/api/sessions/new-chat') && !init.method) return response(405);
    if (String(url).includes('/api/sessions?limit=200')) return response(200, { sessions: [] });
    if (String(url).endsWith('/api/sessions/new-chat') && init.method === 'PATCH') return response(200, { ok: true });
    throw new Error(`Unexpected request: ${url}`);
  });

  const ws = new OpenAgentWS('ws://127.0.0.1:8765/ws');
  assert.equal(await ws.ensureSharedSession('new-chat', 'First message'), true);
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET', 'PATCH']);
  assert.deepEqual(JSON.parse(requests[2].body), { title: 'First message' });
});
