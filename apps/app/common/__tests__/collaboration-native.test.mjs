import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const { build } = await import(process.env.OPENAGENT_TEST_ESBUILD || '../../desktop/node_modules/esbuild/lib/main.js');
async function load(path) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}
const { OpenAgentWS } = await load('../../universal/services/ws.ts');
const { mergeSharedTranscript, placeSharedTools } = await load('../shared-transcript.ts');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('native chat sends text, commands and exact Stop through collaboration', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => url.endsWith('/api/collaboration') ? { version: 1 } : { response: 'Done' } };
  });
  const ws = new OpenAgentWS('ws://localhost:8765/ws');
  const shared = await ws.enableShared();
  ws.sendMessage('Alice', 'chat'); await tick();
  ws.sendMessage('Bob steers', 'chat'); await tick();
  await ws.sendSharedCommand('chat', '/model auto');
  shared.snapshot = () => ({ turns: [{ active: true, runId: 'active-request' }] });
  ws.sendInterrupt('chat'); await tick();
  const turns = requests.filter(r => r.url.endsWith('/turns')).map(r => r.body);
  assert.deepEqual(turns.map(t => t.message), ['Alice', 'Bob steers', '/model auto']);
  assert.equal(turns[1].delivery, 'steer');
  assert.notEqual(turns[0].request_id, turns[1].request_id);
  assert.deepEqual(requests.find(r => r.url.endsWith('/stop')).body, { session_id: 'chat', request_id: 'active-request' });
  ws.disconnect();
});

test('old server fallback is explicit and transient discovery errors do not masquerade as legacy', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 404, ok: false }));
  assert.equal(await new OpenAgentWS('ws://localhost/ws').enableShared(), null);
  globalThis.fetch = async () => ({ status: 503, ok: false });
  await assert.rejects(new OpenAgentWS('ws://localhost/ws').enableShared());
});

test('replay replaces stable turns, keeps identical inputs and reconciles canonical runs', () => {
  const turn = (id, name, active) => ({ id, runId: id, providerRunId: `run:chat:${id}`, active, startedAt: 1,
    messages: [{ id: 'input', role: 'user', text: 'Same', timestamp: 1, author: { kind: 'human', handle: name } },
      { id: 'response', role: 'assistant', text: 'Answer', timestamp: 2 }] });
  const snapshot = { session_id: 'chat', revision: 1, turns: [turn('a', 'alice', false), turn('b', 'bob', true)] };
  const first = mergeSharedTranscript([], snapshot);
  assert.equal(first.filter(m => m.role === 'user').length, 2);
  assert.deepEqual(mergeSharedTranscript(first, snapshot), first);
  const canonical = { id: 'durable', providerRunId: 'run:chat:a', role: 'user', text: 'Same', timestamp: 1000 };
  const merged = mergeSharedTranscript([canonical, ...first], snapshot);
  assert.equal(merged.filter(m => m.providerRunId === 'run:chat:a').length, 1);
  assert.equal(merged.find(m => m.id === 'shared:b:input').author.handle, 'bob');
});

test('catalog tool cards preserve exact destination and reconcile with durable run history', () => {
  const toolInfo = { tool_name: 'read_text_file', tool_call_id: 'call-1', result: 'done',
    execution_host: { kind: 'capability', device_label: 'Alice laptop', source_id: 'app/verified/filesystem', instance_id: 'device-instance' } };
  const snapshot = { session_id: 'chat', revision: 1, turns: [{ id: 'turn', runId: 'request',
    providerRunId: 'run:chat:request', active: true, startedAt: 1,
    messages: [{ id: 'input', role: 'user', text: 'Read', timestamp: 1 }],
    tools: [{ id: 'call-1', toolInfo, timestamp: 2 }] }] };
  const live = mergeSharedTranscript([], snapshot);
  assert.equal(live.length, 2);
  assert.deepEqual(live[1].toolInfo.execution_host, toolInfo.execution_host);
  snapshot.turns[0].active = false;
  const canonical = [{ id: 'canonical-tool', role: 'tool', text: '', timestamp: 2000,
    providerRunId: 'run:chat:request', toolInfo }];
  assert.deepEqual(mergeSharedTranscript([...live, ...canonical], snapshot), canonical);
});

test('shared replies interleave prose and tool calls even with identical timestamps and late results', () => {
  const tool = (id, afterText) => ({ id, afterText, timestamp: 1, toolInfo: { tool_name: id, tool_call_id: id } });
  const turn = { id: 'turn', runId: 'request', providerRunId: 'run', active: true, startedAt: 1,
    messages: [{ id: 'input', role: 'user', text: 'Read', timestamp: 1 },
      { id: 'response', role: 'assistant', text: '🔍 Read. Checked. Done.', timestamp: 1 }],
    tools: [tool('start', 0), tool('read', 8), tool('parallel', 8), tool('check', 17)] };
  const snapshot = { session_id: 'chat', revision: 1, turns: [turn] };
  const projected = rows => placeSharedTools(rows).map(row => row.toolInfo?.tool_call_id ?? row.text);
  const order = ['Read', 'start', '🔍 Read. ', 'read', 'parallel', 'Checked. ', 'check', 'Done.'];
  const live = mergeSharedTranscript([], snapshot);
  assert.deepEqual(projected(live), order);
  turn.tools[1].toolInfo.result = 'late completion';
  assert.deepEqual(projected(mergeSharedTranscript(live, snapshot)), order);

  turn.active = false;
  const durable = [
    { id: 'user', role: 'user', text: 'Read', timestamp: 1000, providerRunId: 'run' },
    { id: 'persisted-tool', role: 'tool', text: '', timestamp: 1000, providerRunId: 'run',
      toolInfo: { tool_name: 'read', tool_call_id: 'read' }, toolInvocationId: 'invocation' },
    { id: 'answer', role: 'assistant', text: turn.messages[1].text, timestamp: 1000, providerRunId: 'run',
      parts: [{ kind: 'text', text: '🔍 Read. Checked. ' }, { kind: 'ui_view', view_id: 'view', revision: 1 },
        { kind: 'text', text: 'Done.' }] },
  ];
  const reconciled = mergeSharedTranscript([...live, ...durable], snapshot);
  assert.deepEqual(projected(reconciled), order);
  assert.equal(placeSharedTools(reconciled).find(row => row.id === 'persisted-tool').toolInvocationId, 'invocation');
  assert.deepEqual(placeSharedTools(reconciled).at(-1).parts, durable.at(-1).parts.slice(1));
  assert.deepEqual(mergeSharedTranscript(reconciled, snapshot), reconciled);

  const revised = [...durable.slice(0, -1), { ...durable.at(-1), text: 'Authorized replacement' }];
  assert.deepEqual(mergeSharedTranscript(revised, snapshot), revised);
});
