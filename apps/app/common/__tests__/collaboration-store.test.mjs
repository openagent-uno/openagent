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
