import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { build } = await import(process.env.OPENAGENT_TEST_ESBUILD || '../../desktop/node_modules/esbuild/lib/main.js');
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../universal/services/collaboration.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm' });
const { CollaborationClient } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

class Socket {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

function client(origin = 'http://localhost:8765') {
  const sockets = [];
  const value = new CollaborationClient(origin, url => {
    const socket = new Socket(); socket.url = url; sockets.push(socket); return socket;
  });
  return { value, sockets };
}
const snapshot = (revision, text = 'Hello') => ({ type: 'shared_state', session_id: 'chat', revision,
  turns: [{ id: 'turn', runId: 'request', active: true, startedAt: 1,
    messages: [{ id: 'response', role: 'assistant', text, timestamp: 1 }] }] });

test('replay replaces text, rejects old revisions and clears revoked sessions', t => {
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.observe(['chat'], { kind: 'session', id: 'chat' });
  const ws = sockets[0];
  assert.equal(ws.sent.length, 0);
  ws.receive({ type: 'auth_ok', shared: true });
  assert.deepEqual(ws.sent, [{ type: 'observe', sessions: ['chat'], focus: { kind: 'session', id: 'chat' } }]);
  ws.receive(snapshot(1, 'Hel')); ws.receive(snapshot(2)); ws.receive(snapshot(1, 'duplicate'));
  assert.equal(value.snapshot('chat').turns[0].messages[0].text, 'Hello');
  ws.receive({ type: 'shared_revoked', session_id: 'chat' });
  assert.equal(value.snapshot('chat'), undefined);
});

test('disconnect resets and reconnect reobserves current view without sending a turn', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { value, sockets } = client('https://agent.example'); t.after(() => value.dispose());
  value.observe(['chat']);
  assert.equal(sockets[0].url, 'wss://agent.example/ws/collaboration');
  sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1)); sockets[0].close();
  assert.equal(value.snapshot('chat'), undefined);
  value.observe(['next']);
  t.mock.timers.tick(250);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  assert.deepEqual(sockets[1].sent, [{ type: 'observe', sessions: ['next'], focus: null }]);
  sockets[0].receive(snapshot(9));
  assert.equal(value.snapshot('chat'), undefined);
});

test('account instances and views never share cached text or presence', t => {
  const alice = client(), bob = client();
  t.after(() => { alice.value.dispose(); bob.value.dispose(); });
  for (const account of [alice, bob]) { account.value.observe(['chat']); account.sockets[0].receive({ type: 'auth_ok', shared: true }); }
  alice.sockets[0].receive(snapshot(1, 'Private'));
  assert.equal(bob.value.snapshot('chat'), undefined);
  alice.value.observe(['other']);
  assert.equal(alice.value.snapshot('chat'), undefined);
});

test('steering, queued commands and exact stop use the additive API', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return { ok: true, json: async () => ({ response: 'ok' }) };
  });
  const { value } = client(); t.after(() => value.dispose());
  const controller = new AbortController();
  await value.sendTurn('chat', 'one', 'Correction', 'steer', controller.signal);
  await value.sendTurn('chat', 'two', '/compact');
  await value.stopTurn('chat', 'one');
  assert.equal(requests[0].url, 'http://localhost:8765/api/collaboration/turns');
  assert.equal(requests[0].body.delivery, 'steer');
  assert.equal(requests[0].signal, controller.signal);
  assert.equal(requests[1].body.delivery, 'queue');
  assert.deepEqual(requests[2].body, { session_id: 'chat', request_id: 'one' });
});

test('invalid snapshots close the observer and discard cached content', t => {
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  sockets[0].receive({ type: 'shared_state', session_id: 'chat', revision: 2, turns: [null] });
  assert.equal(value.snapshot('chat'), undefined);
  assert.equal(sockets[0].readyState, 3);
});
