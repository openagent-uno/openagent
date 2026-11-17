import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const { build } = await import(process.env.OPENAGENT_TEST_ESBUILD || '../../desktop/node_modules/esbuild/lib/main.js');
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../turn-rail.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createTurnRailMerge } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Previous TurnRail merge, retained independently as the behavior reference.
function legacyMerge(indexed, recent, currentUserHandle) {
  const result = [...indexed];
  const known = new Set(indexed.map(turn => turn.id));
  for (const message of recent) {
    if (known.has(message.id)) continue;
    const handle = message.author?.handle;
    result.push({
      id: message.id, ordinal: message.ordinal,
      own: !handle || !currentUserHandle || handle === currentUserHandle,
      author: message.author?.display || handle,
      preview: message.text.replace(/\s+/g, ' ').trim(),
      timestamp: message.timestamp || undefined,
    });
  }
  return result;
}

const indexedTurn = i => ({ id: `turn-${i}`, ordinal: i * 3, own: i % 3 !== 0, author: i % 3 ? 'Alice' : 'Bob', preview: `Prompt ${i}`, timestamp: 1700000000000 + i * 1000 });
const prompt = (id, handle = 'alice') => ({ id, role: 'user', text: '  A shared\n prompt  ', ordinal: 60001, timestamp: 1700005000000, author: { kind: 'user', handle, display: handle === 'alice' ? 'Alice' : 'Bob' } });

test('20k indexed turns retain every jump identity and ownership while assistant deltas reuse the projection', () => {
  const merge = createTurnRailMerge();
  const base = Array.from({ length: 20000 }, (_, i) => indexedTurn(i));
  const first = merge(base, [], 'alice');
  assert.strictEqual(first, base);
  for (let i = 0; i < 120; i++) assert.strictEqual(merge(base, [], 'alice'), first);
  assert.deepEqual(first, legacyMerge(base, [], 'alice'));
  assert.deepEqual(first.map(turn => turn.id), base.map(turn => turn.id));
  assert.equal(first.at(-1).ordinal, 59997);
});

test('stable unindexed prompts reuse output across transport copies and preserve duplicate rules', () => {
  const merge = createTurnRailMerge();
  const base = [indexedTurn(0)];
  const pending = [prompt('pending'), prompt('shared', 'bob')];
  const first = merge(base, pending, 'alice');
  assert.deepEqual(first, legacyMerge(base, pending, 'alice'));
  assert.strictEqual(merge(base, structuredClone(pending), 'alice'), first);
  const withDuplicates = [prompt('turn-0'), ...pending, prompt('pending')];
  assert.deepEqual(merge(base, withDuplicates, 'alice'), legacyMerge(base, withDuplicates, 'alice'));
});

test('ownership follows the signed-in handle for fallback/live prompts, including absent author fields', () => {
  const merge = createTurnRailMerge();
  const base = [];
  const messages = [prompt('a'), prompt('b', 'bob'), { ...prompt('anonymous'), author: undefined, timestamp: 0 }];
  for (const handle of ['alice', 'bob', undefined, '']) {
    assert.deepEqual(merge(base, messages, handle), legacyMerge(base, messages, handle));
  }
});

test('edits, author changes, reordering and timestamp/ordinal recovery invalidate only when needed', () => {
  const merge = createTurnRailMerge();
  const base = [indexedTurn(0)];
  const messages = [prompt('a'), prompt('b', 'bob')];
  let previous = merge(base, messages, 'alice');
  for (const change of [
    () => { messages[0].text = 'Edited prompt'; },
    () => { messages[0].ordinal = 70000; },
    () => { messages[0].timestamp += 1000; },
    () => { messages[0].author.display = 'Updated author'; },
    () => { messages[0].author.handle = 'bob'; },
    () => { messages[0].id = 'canonical-prompt'; },
    () => { messages.reverse(); },
  ]) {
    change();
    const result = merge(base, messages, 'alice');
    assert.notStrictEqual(result, previous);
    assert.deepEqual(result, legacyMerge(base, messages, 'alice'));
    previous = result;
  }
});

test('index catch-up, access refresh, unsupported fallback and recovery never reuse obsolete turns', () => {
  const merge = createTurnRailMerge();
  let base = [indexedTurn(0)];
  const messages = [prompt('pending')];
  merge(base, messages, 'alice');
  base = [...base, { id: 'pending', ordinal: 60001, own: false, author: 'Server author', preview: 'Canonical preview', timestamp: 1700006000000 }];
  assert.strictEqual(merge(base, messages, 'alice'), base);
  const changedAccess = base.map(turn => ({ ...turn, own: !turn.own, author: 'Refreshed author' }));
  assert.strictEqual(merge(changedAccess, messages, 'alice'), changedAccess);
  const unsupported = [];
  const fallback = [prompt('older'), ...messages];
  assert.deepEqual(merge(unsupported, fallback, 'bob'), legacyMerge(unsupported, fallback, 'bob'));
  const recovered = [indexedTurn(0), indexedTurn(1)];
  assert.deepEqual(merge(recovered, messages, 'bob'), legacyMerge(recovered, messages, 'bob'));
  assert.strictEqual(merge(recovered, [], 'bob'), recovered);
});

test('separate mounted sessions/accounts have independent caches even when message ids coincide', () => {
  const first = createTurnRailMerge(), second = createTurnRailMerge();
  const base = [];
  const messages = [prompt('same-id')];
  const alice = first(base, messages, 'alice');
  const bob = second(base, messages, 'bob');
  assert.equal(alice[0].own, true);
  assert.equal(bob[0].own, false);
  assert.strictEqual(first(base, structuredClone(messages), 'alice'), alice);
});
