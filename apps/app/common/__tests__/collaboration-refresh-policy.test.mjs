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
  plugins: [{ name: 'refresh-api-fixture', setup(api) {
    api.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    api.onLoad({ filter: /^api$/, namespace: 'fixture' }, () => ({ contents: `
      export const deleteSession = async () => {};
      export const fetchSessionRuns = (...args) => globalThis.__refreshFixture.read('history', args);
      export const listSessionMessages = async () => ({ messages: [] });
      export const getSessionContext = async () => ({});
      export const getSessionModelPin = (...args) => globalThis.__refreshFixture.read('pin', args);
      export const runMsgToChat = row => row;
      export const updateSessionMetadata = async () => ({});
    ` }));
  } }],
});
const { useChat, bindShared, observeShared, CollaborationClient } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Socket {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.onclose?.({}); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
const turn = (input = {}) => ({ id: 'turn', runId: 'request', providerRunId: 'provider-run',
  active: false, startedAt: 1, messages: [{ id: 'answer', role: 'assistant', text: 'Done', timestamp: 1 }], ...input });
const snapshot = (revision, turns = [turn()]) => ({ type: 'shared_state', session_id: 'chat', revision, turns });
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const counts = { history: 0, commands: 0, pin: 0 };
  const answers = { history: async () => [{ id: 'durable-answer', providerRunId: 'provider-run',
      role: 'assistant', text: 'Done', timestamp: 1 }], pin: async () => ({}),
    commands: async () => ({ session_id: 'chat', revision: 0, turns: [] }) };
  globalThis.__refreshFixture = { read(endpoint, args) { counts[endpoint]++; return answers[endpoint](...args); } };
  useChat.getState().clearAll();
  useChat.setState({ sessions: [{ id: 'chat', title: 'Chat', messages: [], isProcessing: false }], sessionHistoryMode: 'legacy' });
  const sockets = [];
  const client = new CollaborationClient('http://localhost', () => { const socket = new Socket(); sockets.push(socket); return socket; });
  client.commands = (...args) => globalThis.__refreshFixture.read('commands', args);
  const unbind = bindShared(client);
  const release = observeShared(['chat'], { kind: 'session', id: 'chat' });
  sockets[0].receive({ type: 'auth_ok', shared: true });
  t.after(() => { client.dispose(); release(); unbind(); useChat.getState().clearAll(); delete globalThis.__refreshFixture; });
  return { counts, answers, client, sockets, release, session: () => useChat.getState().sessions.find(row => row.id === 'chat') };
}

test('three equivalent idle revisions share one canonical refresh cycle', async t => {
  const { sockets, counts } = setup(t);
  for (let revision = 1; revision <= 3; revision++) { sockets[0].receive(snapshot(revision)); await flush(); }
  t.diagnostic(JSON.stringify({ idleRevisions: 3, counts, totalReads: Object.values(counts).reduce((a, b) => a + b, 0) }));
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
});

test('changed idle message or tool history still refreshes canonical data', async t => {
  const { sockets, counts } = setup(t);
  sockets[0].receive(snapshot(1)); await flush();
  const changed = turn({ messages: [{ id: 'answer', role: 'assistant', text: 'Corrected', timestamp: 1 }] });
  sockets[0].receive(snapshot(2, [changed])); await flush();
  sockets[0].receive(snapshot(3, [{ ...changed, tools: [{ id: 'call', timestamp: 1,
    toolInfo: { tool_name: 'fixture_read', tool_call_id: 'call', result: 'Complete' } }] }]));
  await flush();
  assert.deepEqual(counts, { history: 3, commands: 3, pin: 3 });
});

test('idle status and finish timestamps alone do not invalidate durable history', async t => {
  const { sockets, counts } = setup(t);
  sockets[0].receive(snapshot(1)); await flush();
  sockets[0].receive(snapshot(2, [turn({ finishedAt: 5, reasoning: false, status: 'finished' })])); await flush();
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
});

test('a new completed turn and an active-to-idle transition each refresh once', async t => {
  const { sockets, counts } = setup(t);
  sockets[0].receive(snapshot(1)); await flush();
  const second = turn({ id: 'second', runId: 'second-request', providerRunId: undefined, active: true });
  sockets[0].receive(snapshot(2, [turn(), second])); await flush();
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
  sockets[0].receive(snapshot(3, [turn(), { ...second, active: false }])); await flush();
  sockets[0].receive(snapshot(4, [turn(), { ...second, active: false }])); await flush();
  assert.deepEqual(counts, { history: 2, commands: 2, pin: 2 });
});

test('an earlier turn finishing while a later turn is already finished is detected during streaming', async t => {
  const { sockets, counts } = setup(t);
  const first = turn({ id: 'first', active: true });
  const second = turn({ id: 'second', runId: 'second-request' });
  const third = turn({ id: 'third', runId: 'third-request', active: true });
  sockets[0].receive(snapshot(1, [first, second, third])); await flush();
  const before = { ...counts };
  sockets[0].receive(snapshot(2, [{ ...first, active: false }, second, third])); await flush();
  assert.equal(counts.history, before.history + 1);
  assert.equal(counts.commands, 0);
  assert.equal(counts.pin, 0);
});

test('reconnect fetches the same finished turn again', async t => {
  const { sockets, counts } = setup(t);
  sockets[0].receive(snapshot(1)); await flush();
  sockets[0].close(); t.mock.timers.tick(250);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  sockets[1].receive(snapshot(1)); await flush();
  assert.deepEqual(counts, { history: 2, commands: 2, pin: 2 });
});

test('regrant and observation reattachment fetch the same finished turn again', async t => {
  const { sockets, counts, release } = setup(t);
  sockets[0].receive(snapshot(1)); await flush();
  sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
  sockets[0].receive(snapshot(1)); await flush();
  release();
  const reattach = observeShared(['chat'], { kind: 'session', id: 'chat' });
  t.after(reattach);
  sockets[0].receive(snapshot(1)); await flush();
  assert.deepEqual(counts, { history: 3, commands: 3, pin: 3 });
});

test('stale and duplicate wire revisions cannot refresh or replace newer history', async t => {
  const { sockets, counts, session } = setup(t);
  sockets[0].receive(snapshot(5)); await flush();
  for (const revision of [4, 5]) sockets[0].receive(snapshot(revision, [turn({ messages: [
    { id: 'answer', role: 'assistant', text: 'Stale', timestamp: 1 },
  ] })]));
  await flush();
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
  assert.equal(session().messages.some(row => row.text === 'Stale'), false);
});

test('duplicate terminal HTTP receipts do not repeat reconciliation', async t => {
  const { sockets, counts, client } = setup(t);
  sockets[0].receive(snapshot(1, [turn({ active: true })])); await flush();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true,
    json: async () => ({ session_id: 'chat', request_id: 'request', response: 'Done' }) }));
  await client.sendTurn('chat', 'request', 'Hello'); await flush();
  await client.sendTurn('chat', 'request', 'Hello'); await flush();
  sockets[0].receive(snapshot(2, [turn({ finishedAt: 20 })])); await flush();
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
});

for (const endpoint of ['history', 'commands', 'pin']) {
  test(`a failed ${endpoint} read stays dirty and recovers on an equivalent idle snapshot`, async t => {
    const { sockets, counts, answers } = setup(t);
    const succeed = answers[endpoint];
    let fail = true;
    answers[endpoint] = async (...args) => { if (fail) throw new Error('Fixture offline'); return succeed(...args); };
    sockets[0].receive(snapshot(1)); await flush();
    fail = false;
    sockets[0].receive(snapshot(2)); await flush();
    sockets[0].receive(snapshot(3)); await flush();
    assert.deepEqual(counts, { history: 2, commands: 2, pin: 2 });
  });
}

test('equivalent idle snapshots during an in-flight refresh do not restart it', async t => {
  const { sockets, counts, answers } = setup(t);
  let finish;
  answers.history = () => new Promise(resolve => { finish = resolve; });
  sockets[0].receive(snapshot(1));
  sockets[0].receive(snapshot(2));
  sockets[0].receive(snapshot(3));
  finish([]); await flush();
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
});

test('empty history behind a visible live transcript stays dirty until persistence catches up', async t => {
  const { sockets, counts, answers } = setup(t);
  const persisted = answers.history;
  answers.history = async () => [];
  sockets[0].receive(snapshot(1)); await flush();
  answers.history = persisted;
  sockets[0].receive(snapshot(2)); await flush();
  sockets[0].receive(snapshot(3)); await flush();
  assert.deepEqual(counts, { history: 2, commands: 2, pin: 2 });
});

test('a genuinely empty attachment refreshes once and pruning a finished projection refreshes again', async t => {
  const { sockets, counts, answers } = setup(t);
  answers.history = async () => [];
  sockets[0].receive(snapshot(1, [])); await flush();
  sockets[0].receive(snapshot(2, [])); await flush();
  assert.deepEqual(counts, { history: 1, commands: 1, pin: 1 });
  answers.history = async () => [{ id: 'durable', role: 'assistant', text: 'Done', timestamp: 1 }];
  sockets[0].receive(snapshot(3)); await flush();
  sockets[0].receive(snapshot(4, [])); await flush();
  assert.deepEqual(counts, { history: 3, commands: 3, pin: 3 });
});

test('a newer refresh fences previous commands and model pin responses', async t => {
  const { sockets, counts, answers, session } = setup(t);
  let finishHistory, finishPin;
  answers.history = () => new Promise(resolve => { finishHistory = resolve; });
  answers.pin = () => new Promise(resolve => { finishPin = resolve; });
  sockets[0].receive(snapshot(1));
  const staleHistory = finishHistory, stalePin = finishPin;
  answers.history = async () => [];
  answers.pin = async () => ({ runtime_id: 'current-model' });
  sockets[0].receive(snapshot(2, [turn({ id: 'new-turn', runId: 'new-request' })])); await flush();
  staleHistory([]); stalePin({ runtime_id: 'stale-model' }); await flush();
  assert.equal(counts.commands, 1);
  assert.equal(session().llmPin, 'current-model');
});

test('commands already in flight cannot replace a newer projection', async t => {
  const { sockets, answers, session } = setup(t);
  let finishCommands;
  answers.commands = () => new Promise(resolve => { finishCommands = resolve; });
  sockets[0].receive(snapshot(1)); await flush();
  answers.commands = async () => ({ session_id: 'chat', revision: 0, turns: [] });
  sockets[0].receive(snapshot(2, [turn({ id: 'new-turn', runId: 'new-request' })])); await flush();
  finishCommands({ session_id: 'chat', revision: 0, turns: [turn({ messages: [
    { id: 'obsolete', role: 'assistant', text: 'Obsolete commands', timestamp: 1 },
  ] })] });
  await flush();
  assert.equal(session().messages.some(row => row.text === 'Obsolete commands'), false);
});

test('failed reads can recover on an unchanged projection when presence reports again', async t => {
  const { sockets, counts, answers } = setup(t);
  const succeed = answers.history;
  answers.history = async () => { throw new Error('Fixture offline'); };
  sockets[0].receive(snapshot(1)); await flush();
  answers.history = succeed;
  sockets[0].receive({ type: 'shared_presence', people: [] }); await flush();
  sockets[0].receive({ type: 'shared_presence', people: [] }); await flush();
  assert.deepEqual(counts, { history: 2, commands: 2, pin: 2 });
});

test('withdrawn grants and account unbind cannot apply pending ancillary responses', async t => {
  const { sockets, answers, counts } = setup(t);
  let finishHistory;
  answers.history = () => new Promise(resolve => { finishHistory = resolve; });
  sockets[0].receive(snapshot(1));
  sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
  bindShared(null);
  finishHistory([]); await flush();
  assert.equal(counts.commands, 0);
  assert.equal(useChat.getState().sessions[0].messages.length, 0);
});
