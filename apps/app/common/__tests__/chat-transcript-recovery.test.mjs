import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

// After an agent restart the client reconnects and keeps its open sessions,
// but the active conversation can be left without rows (and nothing loading),
// which rendered the "new conversation" placeholder for a real chat. The store
// must reload such a session once per connection, never a local draft.

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: `export { useChat } from './universal/stores/chat';`, resolveDir: root },
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
const { useChat } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const wire = (ordinal) => ({
  id: `m${ordinal}`, session_id: 'chat', ordinal, role: ordinal % 2 ? 'assistant' : 'user',
  status: 'complete', author: { kind: ordinal % 2 ? 'agent' : 'user' }, text: `#${ordinal}`,
  created_at: '2026-01-01T00:00:00Z', completeness: 'complete',
});
const page = (messages) => ({ session_id: 'chat', revision: '1', anchor_found: true, messages,
  has_more_before: false, has_more_after: false, before_cursor: null, after_cursor: null });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(t, session) {
  useChat.getState().clearAll();
  useChat.setState({
    sessionHistoryMode: 'v2', sessionsHydrated: true,
    sessions: [{ id: 'chat', title: 'Chat', messages: [], isProcessing: false, ...session }],
    activeSessionId: 'chat',
  });
  t.after(() => useChat.getState().clearAll());
}

test('an active server conversation left without rows is loaded again', async (t) => {
  setup(t);
  let calls = 0;
  globalThis.__page = async () => { calls += 1; return page([wire(0), wire(1)]); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  const state = useChat.getState();
  assert.equal(calls, 1);
  assert.deepEqual(state.sessions[0].messages.map((m) => m.ordinal), [0, 1]);
});

test('a conversation that is really empty is not refetched in a loop', async (t) => {
  setup(t);
  let calls = 0;
  globalThis.__page = async () => { calls += 1; return page([]); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  useChat.getState().ensureActiveTranscript();
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(calls, 1);
  assert.equal(useChat.getState().transcriptChecked.chat, true);
});

test('a reconnect verifies the open conversation again', async (t) => {
  setup(t);
  let calls = 0;
  globalThis.__page = async () => { calls += 1; return page([]); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  // Rows arrive later in the real flow; here the server lost nothing, but the
  // client must ask again after the agent came back.
  globalThis.__page = async () => { calls += 1; return page([wire(0)]); };
  useChat.getState().invalidateTranscriptChecks();
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(useChat.getState().sessions[0].messages.map((m) => m.ordinal), [0]);
});

test('a deleted conversation surfaces the load error instead of the placeholder', async (t) => {
  setup(t);
  globalThis.__page = async () => { throw new Error('This result is no longer available'); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(useChat.getState().transcriptLoadError.chat, 'This result is no longer available');
  // The error stays until the user retries; it does not trigger a refetch loop.
  let calls = 0;
  globalThis.__page = async () => { calls += 1; return page([]); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(calls, 0);
});

test('a local draft is never fetched', async (t) => {
  setup(t, { localDraft: true });
  let calls = 0;
  globalThis.__page = async () => { calls += 1; return page([]); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(calls, 0);
});
