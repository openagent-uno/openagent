import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: `export { useChat, TRANSCRIPT_LOAD_TIMEOUT_MS } from './universal/stores/chat';`, resolveDir: root },
  nodePaths: [root + '/universal/node_modules', root + '/desktop/node_modules'],
  plugins: [{ name: 'api-fixture', setup(api) {
    api.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    api.onLoad({ filter: /^api$/, namespace: 'fixture' }, () => ({ contents: `
      export const deleteSession = async () => {};
      export const fetchSessionRuns = async () => [];
      export const listSessionMessages = (...args) => globalThis.__page(...args);
      export const getSessionContext = async () => ({});
      export const getSessionModelPin = async () => ({});
      export const runMsgToChat = message => message;
      export const updateSessionMetadata = async () => ({});
    ` }));
  } }],
});
const { useChat, TRANSCRIPT_LOAD_TIMEOUT_MS } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));


const wire = (ordinal) => ({
  id: `m${ordinal}`, session_id: 'chat', ordinal, role: ordinal % 2 ? 'assistant' : 'user',
  status: 'complete', author: { kind: ordinal % 2 ? 'agent' : 'user' }, text: `#${ordinal}`,
  created_at: '2026-01-01T00:00:00Z', completeness: 'complete',
});
const page = { session_id: 'chat', revision: '1', anchor_found: true, messages: [wire(0), wire(1)],
  has_more_before: false, has_more_after: false, before_cursor: null, after_cursor: null };

function setup(t) {
  useChat.getState().clearAll();
  useChat.setState({
    sessionHistoryMode: 'v2', sessionsHydrated: true,
    sessions: [{ id: 'chat', title: 'Chat', messages: [], isProcessing: false },
               { id: 'other', title: 'Other', messages: [], isProcessing: false }],
    activeSessionId: 'other',
  });
  t.after(() => useChat.getState().clearAll());
}

test('opening an existing session reports loading until its transcript arrives', async (t) => {
  setup(t);
  let release;
  globalThis.__page = () => new Promise((resolve) => { release = () => resolve(page); });
  useChat.getState().setActiveSession('chat');
  assert.equal(useChat.getState().transcriptLoading.chat, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = useChat.getState();
  assert.equal(state.transcriptLoading.chat, undefined);
  assert.deepEqual(state.sessions.find((s) => s.id === 'chat').messages.map((m) => m.ordinal), [0, 1]);
  assert.equal(state.transcriptLoadError.chat, undefined);
});

test('a failed initial load is reported and can be retried', async (t) => {
  setup(t);
  globalThis.__page = () => Promise.reject(new Error('transport closed'));
  useChat.getState().setActiveSession('chat');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(useChat.getState().transcriptLoading.chat, undefined);
  assert.equal(useChat.getState().transcriptLoadError.chat, 'transport closed');

  globalThis.__page = () => Promise.resolve(page);
  await useChat.getState().loadInitialTranscript('chat');
  const state = useChat.getState();
  assert.equal(state.transcriptLoadError.chat, undefined);
  assert.equal(state.sessions.find((s) => s.id === 'chat').messages.length, 2);
});

test('a request that never settles times out, reports it and allows a retry', async (t) => {
  setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.__page = () => new Promise(() => {});
  useChat.getState().setActiveSession('chat');
  assert.equal(useChat.getState().transcriptLoading.chat, true);
  t.mock.timers.tick(TRANSCRIPT_LOAD_TIMEOUT_MS);
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(useChat.getState().transcriptLoading.chat, undefined);
  assert.match(useChat.getState().transcriptLoadError.chat, /too long/);

  globalThis.__page = () => Promise.resolve(page);
  await useChat.getState().loadInitialTranscript('chat');
  assert.equal(useChat.getState().transcriptLoadError.chat, undefined);
  assert.equal(useChat.getState().sessions.find((s) => s.id === 'chat').messages.length, 2);
});

test('an in-app destination is recorded and consumed with the stale route value', (t) => {
  setup(t);
  useChat.getState().requestChatDestination('chat');
  assert.equal(useChat.getState().chatDestination, 'chat');
  useChat.getState().consumeChatDestination('draft');
  assert.equal(useChat.getState().chatDestination, null);
  assert.equal(useChat.getState().staleRouteSession, 'draft');
  useChat.getState().clearAll();
  assert.equal(useChat.getState().staleRouteSession, null);
});
