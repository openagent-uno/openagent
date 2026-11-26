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
  stdin: { contents: `export { useChat, TRANSCRIPT_LOAD_TIMEOUT_MS } from './universal/stores/chat';
    export { setSessionRevoked } from './universal/stores/sessionReadAccess';`, resolveDir: root },
  nodePaths: [root + '/universal/node_modules', root + '/desktop/node_modules'],
  plugins: [{ name: 'api-fixture', setup(api) {
    api.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    api.onLoad({ filter: /^api$/, namespace: 'fixture' }, () => ({ contents: `
      export const deleteSession = async () => {};
      export const fetchSessionRuns = (...args) => globalThis.__legacy?.(...args) ?? Promise.resolve([]);
      export const listSessionMessages = (...args) => globalThis.__page(...args);
      export const getSessionContext = async () => ({});
      export const getSessionModelPin = async () => ({});
      export const runMsgToChat = message => message;
      export const updateSessionMetadata = async () => ({});
    ` }));
  } }],
});
const { useChat, setSessionRevoked, TRANSCRIPT_LOAD_TIMEOUT_MS } = await import(
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


test('an empty observer snapshot is not a durable transcript and cannot suppress loading', async t => {
  setup(t, { sharedSnapshot: { session_id: 'chat', revision: 1, turns: [] } });
  let calls = 0;
  globalThis.__page = async () => { calls++; return page([wire(0), wire(1)]); };
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(useChat.getState().sessions[0].messages.map(m => m.ordinal), [0, 1]);
  useChat.getState().ensureActiveTranscript();
  await settle();
  assert.equal(calls, 1);
});

test('an observer that arrives before the first history page cannot hide the previous turns', async t => {
  const turn = { id: 'new', runId: 'new', providerRunId: 'run-new', active: true, startedAt: 2,
    messages: [{ id: 'input', role: 'user', text: 'New turn', timestamp: 2 }] };
  setup(t, { messages: [{ id: 'shared:new:input', sharedTurnId: 'new', providerRunId: 'run-new',
    role: 'user', text: 'New turn', timestamp: 2000 }], isProcessing: true,
    sharedSnapshot: { session_id: 'chat', revision: 1, turns: [turn] } });
  globalThis.__page = async () => page([wire(0), wire(1)]);
  useChat.getState().ensureActiveTranscript();
  await settle();
  const rows = useChat.getState().sessions[0].messages;
  assert.deepEqual(rows.filter(m => m.ordinal != null).map(m => m.ordinal), [0, 1]);
  assert.equal(rows.filter(m => m.text === 'New turn').length, 1);
});

const versionedPage = (revision, rows, moreBefore = true, moreAfter = false) => ({
  ...page(rows), revision: String(revision), has_more_before: moreBefore, has_more_after: moreAfter,
  before_cursor: moreBefore ? 'before-' + rows[0].ordinal : null,
  after_cursor: moreAfter ? 'after-' + rows.at(-1).ordinal : null,
});

test('a delayed earlier page extends history without replacing a newer canonical turn', async t => {
  setup(t);
  const oldAnchor = { ...wire(5), run_id: 'current', text: 'old reply' };
  const currentParts = [{ kind: 'text', text: 'corrected reply' }, { kind: 'ui_view', view_id: 'current-view', revision: 5 }];
  const newest = { ...oldAnchor, text: 'corrected reply', parts: currentParts,
    transcript_segment: { text: 'corrected reply', parts: currentParts } };
  const oldTool = { ...wire(4), role: 'tool', run_id: 'current', transcript_segment: {
    text: 'superseded draft', parts: [{ kind: 'text', text: 'superseded draft' }, { kind: 'ui_view', view_id: 'old-view', revision: 2 }],
  } };
  globalThis.__page = async () => versionedPage(10, [oldAnchor, wire(6)]);
  await useChat.getState().loadInitialTranscript('chat');
  const pending = Promise.withResolvers();
  let calls = 0;
  globalThis.__page = async (_id, query) => {
    calls++;
    return 'around' in query ? pending.promise : versionedPage(11, [newest, wire(6), wire(7)]);
  };
  const browsing = useChat.getState().loadEarlierMessages('chat');
  assert.equal(await useChat.getState().reconcileSession('chat'), true);
  pending.resolve(versionedPage(10, [wire(3), oldTool, oldAnchor], false, true));
  await browsing;
  const session = useChat.getState().sessions[0];
  assert.deepEqual(session.messages.map(row => row.ordinal), [3, 4, 5, 6, 7]);
  assert.equal(session.messages.find(row => row.id === newest.id).text, newest.text);
  assert.deepEqual(session.messages.find(row => row.id === newest.id).parts, currentParts);
  assert.equal(session.messages.find(row => row.id === oldTool.id).transcriptSegment, undefined);
  assert.equal(session.messageWindow.revision, '11');
  assert.equal(session.messageWindow.hasMoreBefore, false);
  assert.equal(session.messageWindow.hasMoreAfter, false);
  assert.equal(session.messageWindow.afterCursor, null);
  assert.equal(calls, 2);
});

test('an older anchor page cannot revive an omitted row or roll back the loaded tail', async t => {
  setup(t);
  useChat.getState().mergeMessageWindow(versionedPage(12, [wire(4), wire(6)]));
  useChat.getState().mergeMessageWindow(versionedPage(11, [wire(3), wire(4), wire(5), wire(8)], false, true));
  const session = useChat.getState().sessions[0];
  assert.deepEqual(session.messages.map(row => row.ordinal), [3, 4, 6]);
  assert.equal(session.messageWindow.revision, '12');
  assert.equal(session.messageWindow.hasMoreAfter, false);
});

test('a late same-revision anchor preserves the canonical row already delivered', async t => {
  setup(t);
  const current = { ...wire(5), text: 'canonical reply' };
  const originalWindow = useChat.getState().sessions[0].messageWindow ?? null;
  useChat.getState().mergeMessageWindow(versionedPage(12, [current, wire(6)]));
  useChat.getState().mergeMessageWindow(versionedPage(12, [wire(4), wire(5)], false, true), undefined, originalWindow);
  const session = useChat.getState().sessions[0];
  assert.deepEqual(session.messages.map(row => row.text), ['#4', 'canonical reply', '#6']);
  assert.equal(session.messageWindow.hasMoreAfter, false);
});

test('a late tail reconcile cannot overwrite a newer canonical page', async t => {
  setup(t);
  const pending = Promise.withResolvers();
  globalThis.__page = () => pending.promise;
  const reconcile = useChat.getState().reconcileSession('chat');
  const newest = { ...wire(5), text: 'corrected reply' };
  useChat.getState().mergeMessageWindow(versionedPage(12, [newest, wire(6)]));
  pending.resolve(versionedPage(11, [wire(4), wire(5)]));
  await reconcile;
  const session = useChat.getState().sessions[0];
  assert.equal(session.messages.find(row => row.id === newest.id).text, newest.text);
  assert.deepEqual(session.messages.map(row => row.ordinal), [4, 5, 6]);
  assert.equal(session.messageWindow.revision, '12');
});

test('revocation fences a pending page and regrant can load the same anchor immediately', async t => {
  setup(t);
  const pending = Promise.withResolvers();
  let calls = 0;
  globalThis.__page = () => ++calls === 1 ? pending.promise
    : Promise.resolve(versionedPage(12, [wire(3), wire(4)], false, true));
  const old = useChat.getState().loadTranscriptPage('chat', 'm4', 'before');
  setSessionRevoked('chat', true);
  await useChat.getState().loadTranscriptPage('chat', 'm5', 'before');
  setSessionRevoked('chat', false);
  const fresh = useChat.getState().loadTranscriptPage('chat', 'm4', 'before');
  pending.resolve(versionedPage(11, [wire(2), wire(4)], false, true));
  await Promise.all([old, fresh]);
  assert.equal(calls, 2);
  const session = useChat.getState().sessions[0];
  assert.deepEqual(session.messages.map(row => row.ordinal), [3, 4]);
  assert.equal(session.messageWindow.revision, '12');
});

test('an obsolete page that adds no coverage does not trigger a transcript update', t => {
  setup(t);
  useChat.getState().mergeMessageWindow(versionedPage(12, [wire(4), wire(6)]));
  const before = useChat.getState().sessions;
  useChat.getState().mergeMessageWindow(versionedPage(11, [wire(4), wire(5), wire(8)]));
  assert.equal(useChat.getState().sessions, before);
});

test('revoked snapshots and pending legacy reads cannot appear under a fresh grant', async t => {
  setup(t);
  t.after(() => { delete globalThis.__legacy; });
  useChat.setState({ sessionHistoryMode: 'legacy' });
  const pending = Promise.withResolvers();
  const signals = [];
  const oldRow = { id: 'old', role: 'assistant', text: 'revoked old transcript', timestamp: 1 };
  const freshRow = { id: 'fresh', role: 'assistant', text: 'permitted transcript', timestamp: 2 };
  globalThis.__legacy = (_id, _limit, signal) => {
    signals.push(signal);
    return signals.length === 1 ? pending.promise : Promise.resolve([freshRow]);
  };
  const old = useChat.getState().reconcileSession('chat');
  setSessionRevoked('chat', true);
  useChat.getState().applyLiveState('chat', [{ type: 'delta', text: 'revoked observation' }]);
  assert.deepEqual(useChat.getState().sessions[0].messages, []);
  assert.equal(await useChat.getState().reconcileSession('chat'), false);
  setSessionRevoked('chat', false);
  const fresh = useChat.getState().reconcileSession('chat');
  pending.resolve([oldRow]);
  assert.deepEqual(await Promise.all([old, fresh]), [false, true]);
  assert.deepEqual(useChat.getState().sessions[0].messages, [freshRow]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
  assert.notEqual(signals[0], signals[1]);
});

test('a hung history page times out and releases its scroll retry without applying a late response', async t => {
  setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = Promise.withResolvers();
  const signals = [];
  globalThis.__page = (_id, _query, signal) => {
    signals.push(signal);
    return signals.length === 1 ? pending.promise : Promise.resolve(versionedPage(12, [wire(3), wire(4)], false));
  };
  const reading = useChat.getState().loadTranscriptPage('chat', 'm4', 'before');
  assert.equal(useChat.getState().loadTranscriptPage('chat', 'm4', 'before'), reading);
  t.mock.timers.tick(TRANSCRIPT_LOAD_TIMEOUT_MS);
  await assert.rejects(reading, /too long/);
  assert.equal(signals[0].aborted, true);
  await useChat.getState().loadTranscriptPage('chat', 'm4', 'before');
  pending.resolve(versionedPage(11, [wire(2), wire(4)], false));
  await Promise.resolve();
  assert.deepEqual(useChat.getState().sessions[0].messages.map(row => row.ordinal), [3, 4]);
  assert.equal(signals.length, 2);
});
