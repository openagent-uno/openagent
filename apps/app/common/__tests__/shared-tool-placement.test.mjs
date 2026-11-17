import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const { build } = await import(process.env.OPENAGENT_TEST_ESBUILD || '../../desktop/node_modules/esbuild/lib/main.js');
const bundle = await build({
  stdin: { contents: `export { createSharedToolPlacement } from './shared-tool-placement'; export { placeSharedTools } from './shared-transcript';`, loader: 'ts', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const { createSharedToolPlacement, placeSharedTools } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture() {
  return [
    { id: 'user', role: 'user', text: 'Prompt', providerRunId: 'run', ordinal: 1, timestamp: 100, author: { kind: 'user', handle: 'alice' } },
    { id: 'reply', role: 'assistant', text: 'Before 😀 after', providerRunId: 'run', ordinal: 2, timestamp: 200,
      parts: [{ kind: 'text', text: 'Before 😀 after' }, { kind: 'attachment', attachment: { id: 'image', name: 'image.png', type: 'image', url: 'https://example.invalid/image.png' } }], model: 'model' },
    { id: 'tool', role: 'tool', text: 'result', providerRunId: 'run', ordinal: 3, timestamp: 201,
      toolPosition: { messageId: 'reply', afterText: 8, order: 0 }, toolInfo: { tool_name: 'read', tool_call_id: 'call' } },
    { id: 'live', role: 'assistant', text: 'Live', streaming: true, providerRunId: 'current-run', timestamp: 300 },
  ];
}

// Frozen downstream MessageList action derivation: cached render rows must
// preserve regeneration/fork targets as well as their visible contents.
function actions(transcript, messages) {
  const canonical = new Map(transcript.map(message => [message.id, message]));
  const last = new Map(), assistantRows = new Map(), runs = new Map();
  for (const row of messages) {
    const source = row.role === 'assistant'
      ? canonical.get(row.id) ?? canonical.get(row.id.split(':after:')[0])
      : row.toolPosition && canonical.get(row.toolPosition.messageId);
    if (source) {
      last.set(source.id, row);
      if (row.role === 'assistant') assistantRows.set(source.id, row);
    }
    if (!row.providerRunId) continue;
    const run = runs.get(row.providerRunId) ?? {};
    runs.set(row.providerRunId, run);
    if (row.role === 'user') run.prompt = canonical.get(row.id);
    if (row.role === 'assistant') run.hasAnswer = true;
    if (row.role === 'tool') run.tool = row;
  }
  const turnForks = new Map([...last].map(([id, row]) => [row.id, canonical.get(id)]));
  for (const run of runs.values()) if (!run.hasAnswer && run.prompt && run.tool) turnForks.set(run.tool.id, run.prompt);
  return {
    assistantActions: new Map([...assistantRows].map(([id, row]) => [row.id, canonical.get(id)])),
    turnForks,
  };
}

function verify(project, transcript) {
  const actual = project(transcript);
  const expected = placeSharedTools(transcript);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actions(transcript, actual), actions(transcript, expected));
  return actual;
}

test('streaming tail append preserves Unicode/media/tool order and reuses immutable projected prefix', () => {
  const project = createSharedToolPlacement();
  let messages = fixture();
  const original = verify(project, messages);
  for (let i = 0; i < 120; i++) {
    messages = [...messages.slice(0, -1), { ...messages.at(-1), text: messages.at(-1).text + ' 😀' }];
    const next = verify(project, messages);
    for (let j = 0; j < next.length - 1; j++) assert.strictEqual(next[j], original[j]);
    assert.strictEqual(next.at(-1), messages.at(-1));
    assert.strictEqual(actions(messages, next).assistantActions.get('live'), messages.at(-1));
  }
});

test('historical edits, media replacement, tool changes, reorder and pagination use exact full projection', () => {
  const project = createSharedToolPlacement();
  let messages = fixture();
  verify(project, messages);
  const changes = [
    rows => rows.map(row => row.id === 'reply' ? { ...row, text: 'Edited 😀 answer', parts: [{ kind: 'text', text: 'Edited 😀 answer' }] } : row),
    rows => rows.map(row => row.id === 'reply' ? { ...row, attachments: [{ id: 'new-media', type: 'audio', name: 'clip.mp3', url: 'https://example.invalid/clip.mp3' }] } : row),
    rows => rows.map(row => row.id === 'tool' ? { ...row, toolPosition: { ...row.toolPosition, afterText: 2 }, toolInfo: { ...row.toolInfo, result: 'updated' } } : row),
    rows => [...rows.slice(1, -1).reverse(), rows[0], rows.at(-1)],
    rows => [{ id: 'older', role: 'user', text: 'Earlier page', ordinal: 0 }, ...rows],
    rows => rows.filter(row => row.id !== 'older'),
    rows => rows.map(row => row.id === 'reply' ? { ...row, text: 'Recovered canonical answer', parts: undefined, durableStatus: 'complete' } : row),
  ];
  for (const change of changes) {
    messages = change(messages);
    const result = verify(project, messages);
    assert.notStrictEqual(result.find(row => row.id === 'reply'), messages.find(row => row.id === 'reply'));
  }
});

test('in-place tail edits and metadata changes are checked against the previous snapshot', () => {
  const project = createSharedToolPlacement(), messages = fixture();
  const tail = messages.at(-1);
  verify(project, messages);
  tail.text += ' appended';
  verify(project, messages);
  tail.text = 'Edited text';
  verify(project, messages);
  for (const update of [
    { model: 'replacement-model' }, { author: { kind: 'agent', display: 'Updated agent' } },
    { parts: [{ kind: 'text', text: 'Rich content' }] },
    { attachments: [{ id: 'video', type: 'video', name: 'video.mp4' }] },
    { streaming: false, durableStatus: 'complete' },
  ]) {
    const previous = verify(project, messages);
    Object.assign(tail, update);
    const next = verify(project, messages);
    assert.notStrictEqual(next.find(row => row.id === 'reply'), previous.find(row => row.id === 'reply'), 'metadata changes use full prefix projection');
  }
});

test('interleaved tools on the live reply always use full projection, including rich mismatch to match', () => {
  for (const afterText of [0, 2, 100]) {
    const project = createSharedToolPlacement();
    let messages = fixture();
    messages = [...messages.slice(0, -1), { id: 'live-tool', role: 'tool', text: '', toolPosition: { messageId: 'live', afterText, order: 0 } },
      { ...messages.at(-1), text: 'x', parts: [{ kind: 'text', text: 'xy' }] }];
    verify(project, messages);
    messages = [...messages.slice(0, -1), { ...messages.at(-1), text: 'xy' }];
    verify(project, messages);
    messages = [...messages.slice(0, -1), { ...messages.at(-1), text: 'xyz' }];
    verify(project, messages);
  }
});

test('array slot replacement, response finalization and replacement sessions cannot reuse stale rows', () => {
  const project = createSharedToolPlacement();
  const messages = fixture();
  verify(project, messages);
  messages[0] = { ...messages[0], text: 'Edited prompt', providerRunId: 'new-run' };
  verify(project, messages);
  messages[messages.length - 1] = { ...messages.at(-1), streaming: false, text: 'Final answer', reasoning: 'summary' };
  verify(project, messages);
  verify(project, []);
  const replacement = fixture().map(row => ({ ...row, id: `${row.id}-replacement` }));
  verify(project, replacement);
  verify(createSharedToolPlacement(), fixture());
});

test('plain transcripts retain original array identity and do not impose any history cap', () => {
  const project = createSharedToolPlacement();
  const messages = Array.from({ length: 20000 }, (_, i) => ({ id: `row-${i}`, role: 'user', text: `Prompt ${i}` }));
  messages.push({ id: 'tail', role: 'assistant', text: 'A', streaming: true });
  assert.strictEqual(verify(project, messages), messages);
  const next = [...messages.slice(0, -1), { ...messages.at(-1), text: 'AB' }];
  assert.strictEqual(verify(project, next), next);
  assert.equal(next.length, 20001);
});
