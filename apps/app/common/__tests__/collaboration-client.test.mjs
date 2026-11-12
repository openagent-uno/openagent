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

test('withdrawn access is distinguished from a socket that merely dropped', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.observe(['chat'], { kind: 'session', id: 'chat' });
  sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  assert.equal(value.revoked('chat'), false);
  // A dropped socket loses the snapshot but must not look like a revocation:
  // treating it as one would wipe a transcript the viewer may still read.
  sockets[0].close();
  assert.equal(value.snapshot('chat'), undefined);
  assert.equal(value.revoked('chat'), false);
  t.mock.timers.tick(250);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  sockets[1].receive({ type: 'shared_revoked', session_id: 'chat' });
  assert.equal(value.revoked('chat'), true);
  // A regrant delivers a fresh snapshot and clears the withdrawal.
  sockets[1].receive(snapshot(2));
  assert.equal(value.revoked('chat'), false);
  // Losing the device itself withdraws every observed session.
  sockets[1].receive({ type: 'auth_error', text: 'gone' });
  assert.equal(value.revoked('chat'), true);
  // Dropping the observation forgets the withdrawal along with the state.
  value.observe(['other']);
  assert.equal(value.revoked('chat'), false);
});

test('logout marks every session withdrawn so no cached transcript survives', t => {
  const { value, sockets } = client();
  value.observe(['chat']);
  sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  assert.equal(value.revoked('chat'), false);
  value.dispose();
  assert.equal(value.snapshot('chat'), undefined);
  assert.equal(value.revoked('chat'), true);
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

test('a terminal HTTP reply recovers a stale observer without resending the turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ session_id: 'chat', request_id: 'request', response: 'Saved' }) };
  });
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1, 'Memorizing'));
  // Simulate a black hole: close() never dispatches onclose either.
  sockets[0].close = function () { this.readyState = 2; };
  await value.sendTurn('chat', 'request', 'Save notes');
  t.mock.timers.tick(500);
  assert.equal(value.snapshot('chat'), undefined);
  t.mock.timers.tick(250);
  assert.equal(sockets.length, 2);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  sockets[1].receive({ ...snapshot(2, 'Saved'), turns: [{ ...snapshot(2).turns[0], active: false }] });
  sockets[0].receive(snapshot(100, 'Obsolete running turn'));
  assert.equal(value.snapshot('chat').turns[0].active, false);
  assert.equal(posts.length, 1);
  assert.deepEqual(sockets[1].sent, [{ type: 'observe', sessions: ['chat'], focus: null }]);
});

test('terminal recovery preserves a newer running turn and cancels on logout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true,
    json: async () => ({ session_id: 'chat', request_id: 'request', response: 'Done' }) }));
  const { value, sockets } = client();
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  await value.sendTurn('chat', 'request', 'First');
  sockets[0].receive({ ...snapshot(2), turns: [{ ...snapshot(2).turns[0], runId: 'newer' }] });
  t.mock.timers.tick(750);
  assert.equal(sockets.length, 1);
  assert.equal(value.snapshot('chat').turns[0].active, true);
  await value.sendTurn('chat', 'request', 'First');
  value.dispose();
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 1);
});

test('heartbeat timeout replaces a half-open reader, while a long tool keeps running', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { value, sockets } = client(); t.after(() => value.dispose());
  const errors = []; value.onError = error => errors.push(error.message);
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true, heartbeat: true });
  sockets[0].receive(snapshot(1));
  t.mock.timers.tick(15_000);
  const ping = sockets[0].sent.at(-1);
  assert.deepEqual(ping, { type: 'ping', id: 1 });
  sockets[0].receive({ type: 'pong', id: 1 });
  t.mock.timers.tick(15_000);
  assert.equal(sockets[0].sent.at(-1).id, 2);
  assert.equal(value.snapshot('chat').turns[0].active, true);
  sockets[0].receive({ type: 'pong', id: 1 }); // a stale pong is not a fresh acknowledgement
  sockets[0].close = function () { this.readyState = 2; };
  t.mock.timers.tick(10_000);
  assert.equal(value.snapshot('chat'), undefined);
  t.mock.timers.tick(250);
  sockets[1].receive({ type: 'auth_ok', shared: true, heartbeat: true });
  sockets[1].receive(snapshot(1)); // reader replacement never declares a tool successful
  assert.equal(value.snapshot('chat').turns[0].active, true);
  assert.ok(errors.includes('Shared observer heartbeat timed out'));
  assert.equal(sockets.flatMap(ws => ws.sent).some(frame => frame.type === 'stop'), false);
});

test('a silent legacy reader and a hung greeting recover even without onclose', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  sockets[0].close = function () { this.readyState = 2; };
  t.mock.timers.tick(45_000); t.mock.timers.tick(250);
  assert.equal(sockets.length, 2);
  sockets[1].close = function () { this.readyState = 2; };
  t.mock.timers.tick(10_000); t.mock.timers.tick(500);
  assert.equal(sockets.length, 3);
});

test('a throwing listener or diagnostic callback cannot strand the observer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.subscribe(() => { if (value.snapshot('chat')?.revision === 1) throw new Error('render failed'); });
  value.onError = () => { throw new Error('diagnostic failed'); };
  let delivered = 0; value.subscribe(() => delivered++);
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  assert.equal(value.snapshot('chat'), undefined);
  t.mock.timers.tick(250);
  assert.equal(sockets.length, 2);
  sockets[1].receive({ type: 'auth_ok', shared: true });
  sockets[1].receive(snapshot(2));
  assert.equal(value.snapshot('chat').revision, 2);
  assert.ok(delivered >= 3);
});

test('an HTTP reply from before revoke/regrant cannot refresh a replacement grant', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  const { value, sockets } = client(); t.after(() => value.dispose());
  value.observe(['chat']); sockets[0].receive({ type: 'auth_ok', shared: true });
  sockets[0].receive(snapshot(1));
  const pending = value.sendTurn('chat', 'request', 'Save');
  await Promise.resolve();
  sockets[0].receive({ type: 'shared_revoked', session_id: 'chat' });
  sockets[0].receive(snapshot(2, 'Regranted live view'));
  finish({ ok: true, json: async () => ({ session_id: 'chat', request_id: 'request', response: 'Old grant' }) });
  await pending;
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 1);
  assert.equal(value.snapshot('chat').turns[0].messages[0].text, 'Regranted live view');
});

test('an account switch retires pending health checks and cannot reopen the old client', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = client(), next = client(); t.after(() => next.value.dispose());
  old.value.observe(['chat']); old.sockets[0].receive({ type: 'auth_ok', shared: true, heartbeat: true });
  old.sockets[0].receive(snapshot(1, 'Old account'));
  old.value.dispose();
  old.value.observe(['chat']); // late lease cleanup/navigation after logout
  await assert.rejects(old.value.sendTurn('chat', 'request', 'Late submission'), /disposed/);
  next.value.observe(['chat']); next.sockets[0].receive({ type: 'auth_ok', shared: true, heartbeat: true });
  next.sockets[0].receive(snapshot(1, 'New account'));
  t.mock.timers.tick(15_000);
  assert.equal(old.sockets.length, 1);
  assert.equal(old.sockets[0].sent.some(frame => frame.type === 'ping'), false);
  assert.equal(next.value.snapshot('chat').turns[0].messages[0].text, 'New account');
});
