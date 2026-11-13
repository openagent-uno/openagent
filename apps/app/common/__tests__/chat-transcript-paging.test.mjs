import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

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

// A canonical session of ``total`` messages with ordinals 0..total-1.
function server(total) {
  const wire = (ordinal) => ({
    id: `m${ordinal}`, session_id: 'chat', ordinal, role: ordinal % 2 ? 'assistant' : 'user',
    status: 'complete', author: { kind: ordinal % 2 ? 'agent' : 'user' }, text: `#${ordinal}`,
    created_at: '2026-01-01T00:00:00Z', completeness: 'complete',
  });
  const pageOf = (from, to) => ({
    session_id: 'chat', revision: '1', anchor_found: true,
    messages: Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => wire(from + i)),
    has_more_before: from > 0, has_more_after: to < total - 1,
    before_cursor: from > 0 ? `b${from}` : null, after_cursor: to < total - 1 ? `a${to}` : null,
  });
  return (_session, query = {}) => {
    if (query.around) {
      const at = Number(query.around.slice(1));
      return Promise.resolve(pageOf(Math.max(0, at - (query.before ?? 30)), Math.min(total - 1, at + (query.after ?? 30))));
    }
    const limit = query.limit ?? 100;
    return Promise.resolve(pageOf(Math.max(0, total - limit), total - 1));
  };
}

const session = () => useChat.getState().sessions.find((s) => s.id === 'chat');
const ordinals = () => session().messages.map((m) => m.ordinal);

function setup(t, total) {
  globalThis.__page = server(total);
  useChat.getState().clearAll();
  useChat.setState({
    sessionHistoryMode: 'v2',
    sessions: [{ id: 'chat', title: 'Chat', messages: [], isProcessing: false }],
  });
  t.after(() => useChat.getState().clearAll());
}

test('earlier pages and tail reloads keep one contiguous loaded history', async (t) => {
  setup(t, 300);
  await useChat.getState().reconcileSession('chat');
  assert.deepEqual([ordinals()[0], ordinals().at(-1)], [240, 299]);
  assert.deepEqual(session().loadedRanges, [{ start: 240, end: null }]);
  assert.equal(session().messageWindow.hasMoreBefore, true);

  await useChat.getState().loadTranscriptPage('chat', 'm240', 'before');
  assert.equal(ordinals()[0], 180);
  assert.deepEqual(session().loadedRanges, [{ start: 180, end: null }]);

  // A turn completes: the tail reload must not discard the scrolled history.
  globalThis.__page = server(320);
  await useChat.getState().reconcileSession('chat');
  assert.deepEqual([ordinals()[0], ordinals().at(-1), ordinals().length], [180, 319, 140]);
  assert.deepEqual(session().loadedRanges, [{ start: 180, end: null }]);
});

test('a jump far back leaves a gap that paging forward closes', async (t) => {
  setup(t, 400);
  await useChat.getState().reconcileSession('chat');
  await useChat.getState().loadTranscriptPage('chat', 'm30', 'around');
  assert.deepEqual(session().loadedRanges, [{ start: 10, end: 70 }, { start: 340, end: null }]);
  assert.equal(session().messageWindow.hasMoreBefore, true);

  let anchor = 'm70';
  for (let step = 0; step < 10 && session().loadedRanges.length > 1; step += 1) {
    await useChat.getState().loadTranscriptPage('chat', anchor, 'after');
    anchor = `m${session().loadedRanges[0].end}`;
  }
  assert.deepEqual(session().loadedRanges, [{ start: 10, end: null }]);
  const loaded = ordinals();
  assert.deepEqual(loaded, Array.from({ length: 390 }, (_, i) => 10 + i));

  await useChat.getState().loadTranscriptPage('chat', 'm10', 'before');
  assert.deepEqual(session().loadedRanges, [{ start: null, end: null }]);
  assert.equal(session().messageWindow.hasMoreBefore, false);
});
