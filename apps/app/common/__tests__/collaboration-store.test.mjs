import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: `export { useChat } from './universal/stores/chat';
    export { bindShared, observeShared } from './universal/stores/collaboration';
    export { CollaborationClient } from './universal/services/collaboration';`, resolveDir: root },
  nodePaths: [root + '/universal/node_modules', root + '/desktop/node_modules'],
  plugins: [{ name: 'api-fixture', setup(api) {
    api.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    api.onLoad({ filter: /^api$/, namespace: 'fixture' }, () => ({ contents: `
      export const deleteSession = async () => {};
      export const fetchSessionRuns = (...args) => globalThis.__sharedHistory(...args);
      export const listSessionMessages = (...args) => globalThis.__sharedPage(...args);
      export const getSessionContext = async () => ({});
      export const getSessionModelPin = async () => ({});
      export const runMsgToChat = message => message;
      export const updateSessionMetadata = async () => ({});
    ` }));
  } }],
});
const { useChat, bindShared, observeShared, CollaborationClient } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
class Socket {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.onclose?.({}); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
const message = text => ({ id: 'reply', role: 'assistant', text, timestamp: 1 });
const snapshot = (revision, active = true, text = 'Secret') => ({
  type: 'shared_state', session_id: 'chat', revision,
  turns: [{ id: 'turn', runId: 'request', active, startedAt: 1, messages: [message(text)] }],
});
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.__sharedHistory = async () => [];
  globalThis.__sharedPage = async () => ({ messages: [] });
  useChat.getState().clearAll();
  useChat.setState({ sessions: [{ id: 'chat', title: 'Chat', messages: [], isProcessing: false }], sessionHistoryMode: 'legacy' });
  const sockets = [];
  const client = new CollaborationClient('http://localhost', () => { const ws = new Socket(); sockets.push(ws); return ws; });
  client.commands = async () => ({ session_id: 'chat', revision: 0, turns: [] });
  const unbind = bindShared(client), release = observeShared(['chat'], { kind: 'session', id: 'chat' });
  sockets[0].receive({ type: 'auth_ok', shared: true });
  t.after(() => { client.dispose(); release(); unbind(); useChat.getState().clearAll(); });
  return { client, sockets, texts: () => useChat.getState().sessions.find(s => s.id === 'chat')?.messages.map(m => m.text) ?? [] };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('a shared run acknowledgement retires a local draft, but an empty observation does not', async t => {
  const { sockets } = setup(t);
  useChat.setState(s => ({ sessions: s.sessions.map(session => ({ ...session, localDraft: true })) }));
  sockets[0].receive({ type: 'shared_state', session_id: 'chat', revision: 0, turns: [] });
  await flush();
  assert.equal(useChat.getState().sessions[0].localDraft, true);
  sockets[0].receive(snapshot(1, true, 'Accepted run'));
  assert.equal(useChat.getState().sessions[0].localDraft, false);
});

test('native live frames and canonical history also retire the local draft', async t => {
  setup(t);
  useChat.setState(s => ({ sessions: s.sessions.map(session => ({ ...session, localDraft: true })) }));
  useChat.getState().applyLiveState('chat', [{ type: 'delta', session_id: 'chat', text: 'Native reply' }], true);
  assert.equal(useChat.getState().sessions[0].localDraft, false);
  useChat.setState(s => ({ sessions: s.sessions.map(session => ({ ...session, localDraft: true, isProcessing: false })) }));
  globalThis.__sharedHistory = async () => [message('Durable reply')];
  await useChat.getState().reconcileSession('chat');
  assert.equal(useChat.getState().sessions[0].localDraft, false);
});

test('revocation after a disconnect clears the retained transcript', t => {
  const { sockets, texts } = setup(t);
  sockets[0].receive(snapshot(1));
  sockets[0].close();
  assert.deepEqual(texts(), ['Secret']);
  t.mock.timers.tick(250);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  sockets[1].receive({ type: 'shared_revoked', session_id: 'chat' });
  assert.deepEqual(texts(), []);
});

test('logout after disconnect clears the retained transcript', t => {
  const { client, sockets, texts } = setup(t);
  sockets[0].receive(snapshot(1)); sockets[0].close(); client.dispose();
  assert.deepEqual(texts(), []);
});

test('history begun before revocation cannot restore a revoked transcript', async t => {
  const { sockets, texts } = setup(t);
  let resolve;
  globalThis.__sharedHistory = () => new Promise(done => { resolve = done; });
  sockets[0].receive(snapshot(1, false));
  assert.equal(typeof resolve, 'function');
  sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
  assert.deepEqual(texts(), []);
  resolve([message('Old private history')]);
  await flush();
  assert.deepEqual(texts(), []);
});

test('regrant cannot accept a history response from the previous grant', async t => {
  const { sockets, texts } = setup(t);
  let resolve;
  globalThis.__sharedHistory = () => new Promise(done => { resolve = done; });
  sockets[0].receive(snapshot(1, false));
  sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
  globalThis.__sharedHistory = async () => [];
  sockets[0].receive(snapshot(2, false, 'Fresh'));
  resolve([message('Old private history')]);
  await flush();
  assert.deepEqual(texts(), ['Fresh']);
});

test('account reset fences in-flight reads even when the new account has the same session id', async t => {
  const { texts } = setup(t);
  let resolve;
  globalThis.__sharedHistory = () => new Promise(done => { resolve = done; });
  const pending = useChat.getState().reconcileSession('chat');
  useChat.getState().clearAll();
  useChat.setState({ sessions: [{ id: 'chat', title: 'Other account', messages: [], isProcessing: false }] });
  resolve([message('Previous account')]);
  await pending;
  assert.deepEqual(texts(), []);
});

for (const loader of ['focus', 'hydrate']) {
  test(`${loader} history cannot apply after revocation before the first snapshot`, async t => {
    const { sockets, texts } = setup(t);
    let resolve;
    globalThis.__sharedHistory = () => new Promise(done => { resolve = done; });
    if (loader === 'focus') {
      useChat.setState({ sessionsHydrated: true });
      useChat.getState().setActiveSession('chat');
    } else {
      useChat.setState({ sessions: [], activeSessionId: null });
      useChat.getState().hydrateFromServer([{ session_id: 'chat', title: 'Chat' }]);
    }
    assert.equal(typeof resolve, 'function');
    sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
    resolve([message('Old history')]);
    await flush();
    assert.deepEqual(texts(), []);
    assert.equal(useChat.getState().sessions[0].accessRevoked, true);
    useChat.getState().handleServerMessage({ type: 'delta', session_id: 'chat', text: 'late frame' });
    assert.deepEqual(texts(), []);
  });
}

test('revocation clears pagination and rejects a page started under the old grant', async t => {
  const { sockets, texts } = setup(t);
  let resolve;
  globalThis.__sharedPage = () => new Promise(done => { resolve = done; });
  useChat.setState({ sessionHistoryMode: 'v2', sessions: [{ id: 'chat', title: 'Chat', isProcessing: false,
    messages: [message('Current')], messageWindow: { beforeCursor: 'older', hasMoreBefore: true } }] });
  const pending = useChat.getState().loadEarlierMessages('chat');
  sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
  assert.equal(useChat.getState().sessions[0].messageWindow, undefined);
  resolve({ session_id: 'chat', messages: [{ id: 'old', role: 'assistant', text: 'Old page', author: { kind: 'agent' }, created_at: '2026-01-01' }] });
  await pending;
  assert.deepEqual(texts(), []);
});

test('a completed turn receives its durable fork anchor while the next turn streams', async t => {
  const { sockets } = setup(t);
  useChat.setState({ sessionHistoryMode: 'v2' });
  globalThis.__sharedPage = async () => ({
    revision: 'test-revision',
    messages: [{
      id: 'durable-answer', run_id: 'first-run', ordinal: 3, status: 'complete',
      role: 'assistant', text: 'Earlier answer', created_at: '2026-01-01T00:00:00Z',
      author: { kind: 'agent' },
    }],
  });
  const now = Date.parse('2026-01-01T00:00:00Z') / 1000;
  sockets[0].receive({
    type: 'shared_state', session_id: 'chat', revision: 1, turns: [
      { id: 'first-turn', runId: 'first-run', providerRunId: 'first-run', active: false,
        startedAt: now, messages: [{ ...message('Earlier answer'), timestamp: now }] },
      { id: 'second-turn', runId: 'second-run', providerRunId: 'second-run', active: true,
        startedAt: now + 1, messages: [{ ...message('Still streaming'), timestamp: now + 1 }] },
    ],
  });
  await flush();
  const session = useChat.getState().sessions[0];
  assert.equal(session.isProcessing, true);
  assert.deepEqual(session.messages.map(row => [row.id, row.ordinal, !!row.streaming]), [
    ['durable-answer', 3, false], ['shared:second-turn:reply', undefined, true],
  ]);
});

test('six parallel tool completions replace a frozen live projection after the terminal HTTP receipt', async t => {
  const { client, sockets } = setup(t);
  useChat.setState({ sessionHistoryMode: 'v2' });
  const calls = Array.from({ length: 6 }, (_, i) => ({ tool_name: 'vault_write_note', tool_call_id: `save-${i}` }));
  const live = { id: 'turn', runId: 'request', providerRunId: 'request', active: true, startedAt: 1,
    messages: [{ id: 'input', role: 'user', text: 'Save notes', timestamp: 1 }],
    tools: calls.map((toolInfo, i) => ({ id: toolInfo.tool_call_id, timestamp: 1, afterText: 0,
      toolInfo: i < 2 ? { ...toolInfo, result: 'Saved' } : toolInfo })) };
  sockets[0].receive({ type: 'shared_state', session_id: 'chat', revision: 1, turns: [live] });
  const rows = calls.map((toolInfo, i) => ({ id: `durable-${i}`, run_id: 'request', ordinal: i + 1,
    status: 'complete', role: 'tool', text: '', tool_summary: { ...toolInfo, status: 'success' },
    created_at: '2026-01-01T00:00:00Z', author: { kind: 'agent' } }));
  globalThis.__sharedPage = async () => ({ revision: 'finished', messages: [...rows, {
    id: 'final-answer', run_id: 'request', ordinal: 7, status: 'complete', role: 'assistant',
    text: 'All notes saved', model: 'provider:turn-model', created_at: '2026-01-01T00:00:01Z', author: { kind: 'agent' },
  }] });
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ session_id: 'chat', request_id: 'request', response: 'All notes saved' }) };
  });
  await client.sendTurn('chat', 'request', 'Save notes');
  // The exact terminal receipt must retire the old live overlay immediately,
  // before the read socket is repaired or a final snapshot arrives.
  await useChat.getState().reconcileSession('chat');
  assert.equal(useChat.getState().sessions[0].isProcessing, false);
  assert.equal(useChat.getState().sessions[0].messages.filter(row => row.toolInfo?.status === 'success').length, 6);
  sockets[0].receive({ type: 'shared_state', session_id: 'chat', revision: 2, turns: [live] });
  await flush();
  assert.equal(useChat.getState().sessions[0].isProcessing, false);
  assert.equal(useChat.getState().sessions[0].messages.filter(row => row.toolInfo?.status === 'success').length, 6);
  t.mock.timers.tick(500); t.mock.timers.tick(250);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  // Completed projections may already have been pruned after one minute.
  sockets[1].receive({ type: 'shared_state', session_id: 'chat', revision: 3, turns: [] });
  await flush();
  const session = useChat.getState().sessions[0];
  assert.equal(session.isProcessing, false);
  assert.equal(session.messages.filter(row => row.toolInfo?.status === 'success').length, 6);
  assert.equal(session.messages.some(row => row.text === 'All notes saved'), true);
  assert.equal(session.messages.find(row => row.text === 'All notes saved').model, 'provider:turn-model');
  assert.equal(session.messages.some(row => row.streaming), false);
  assert.equal(posts.length, 1);
});
