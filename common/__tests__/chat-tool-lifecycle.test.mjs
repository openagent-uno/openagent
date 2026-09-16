import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const storeEntry = fileURLToPath(
  new URL('../../universal/stores/chat.ts', import.meta.url),
);
const appRoot = fileURLToPath(new URL('../..', import.meta.url));

const bundle = await build({
  absWorkingDir: appRoot,
  bundle: true,
  entryPoints: [storeEntry],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  nodePaths: [
    fileURLToPath(new URL('../../universal/node_modules', import.meta.url)),
    fileURLToPath(new URL('../../desktop/node_modules', import.meta.url)),
  ],
  plugins: [{
    name: 'chat-store-test-boundaries',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\.\/services\/api$/ }, () => ({
        path: 'api', namespace: 'chat-store-test',
      }));
      buildApi.onLoad({ filter: /^api$/, namespace: 'chat-store-test' }, () => ({
        loader: 'js',
        contents: `
          export const deleteSession = async () => {};
          export const fetchSessionRuns = async () => [];
          export const getSessionContext = async () => ({});
          export const listSessionMessages = async () => ({ messages: [] });
          export const runMsgToChat = (message) => message;
          export const updateSessionMetadata = async (...args) => {
            const handler = globalThis.__oaUpdateSessionMetadata;
            return handler ? handler(...args) : { ok: true };
          };
        `,
      }));
    },
  }],
});

const bundledSource = bundle.outputFiles[0].text;
const { appendOrPatchTool, preserveToolMetadataAcrossReplay, useChat } = await import(
  `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`
);

test('a new local chat has recency before its first durable history row exists', () => {
  useChat.setState({ sessions: [], activeSessionId: null, sessionsHydrated: true });
  const before = Math.floor(Date.now() / 1000);
  const id = useChat.getState().createSession();
  const session = useChat.getState().sessions.find((entry) => entry.id === id);

  assert.equal(useChat.getState().activeSessionId, id);
  assert.ok(session);
  assert.ok(session.lastActiveAt >= before);
});

test('technical commands do not name a chat and the next real request repairs it', () => {
  const calls = [];
  globalThis.__oaUpdateSessionMetadata = async (...args) => { calls.push(args); };
  useChat.setState({
    sessions: [{ id: 'title-repair', title: 'New Chat', messages: [], isProcessing: false }],
    activeSessionId: 'title-repair',
  });

  useChat.getState().addUserMessage('title-repair', '/model codex:gpt-5.6-sol:high');
  assert.equal(useChat.getState().sessions[0].title, 'New Chat');
  useChat.getState().addUserMessage('title-repair', '  Start   BuzzerBeater locally with Aspire!  ');

  assert.equal(useChat.getState().sessions[0].title, 'Start BuzzerBeater locally with Aspire');
  assert.deepEqual(calls, [[
    'title-repair',
    { title: 'Start BuzzerBeater locally with Aspire' },
  ]]);
  delete globalThis.__oaUpdateSessionMetadata;
});

test('renameSession persists a normalized title and keeps the optimistic value on success', async () => {
  const calls = [];
  globalThis.__oaUpdateSessionMetadata = async (...args) => {
    calls.push(args);
    return { ok: true };
  };
  useChat.setState({
    sessions: [{ id: 'rename-ok', title: 'Old title', messages: [], isProcessing: false }],
    activeSessionId: 'rename-ok',
  });

  await useChat.getState().renameSession('rename-ok', '  New title  ');

  assert.equal(useChat.getState().sessions[0].title, 'New title');
  assert.deepEqual(calls, [['rename-ok', { title: 'New title' }]]);
  delete globalThis.__oaUpdateSessionMetadata;
});

test('renameSession rolls the optimistic title back when persistence fails', async () => {
  globalThis.__oaUpdateSessionMetadata = async () => {
    throw new Error('server refused rename');
  };
  useChat.setState({
    sessions: [{ id: 'rename-fail', title: 'Stable title', messages: [], isProcessing: false }],
    activeSessionId: 'rename-fail',
  });

  await assert.rejects(
    useChat.getState().renameSession('rename-fail', 'Temporary title'),
    /server refused rename/,
  );
  assert.equal(useChat.getState().sessions[0].title, 'Stable title');
  delete globalThis.__oaUpdateSessionMetadata;
});

test('a sparse terminal frame preserves execution host from the started frame', () => {
  const executionHost = {
    kind: 'client',
    device_label: 'Alessandro MacBook',
    device_id: 'device-1',
    client_instance_id: 'desktop-1',
    generation: 7,
  };
  const started = {
    tool_name: 'filesystem_write_file',
    tool_call_id: 'call-1',
    tool_args: { path: '/tmp/client-only.txt' },
    tool_call_error: false,
    execution_host: executionHost,
  };
  const messages = [{
    id: 'tool-message-1',
    role: 'tool',
    text: 'Writing client-only.txt',
    timestamp: 1,
    toolInfo: started,
  }];

  const patched = appendOrPatchTool(messages, {
    tool_name: 'filesystem_write_file',
    tool_call_id: 'call-1',
    result: 'written',
    status: 'success',
  });

  assert.equal(patched.length, 1);
  assert.notStrictEqual(patched, messages);
  assert.notStrictEqual(patched[0], messages[0]);
  assert.deepEqual(patched[0].toolInfo.execution_host, executionHost);
  assert.deepEqual(patched[0].toolInfo.tool_args, started.tool_args);
  assert.equal(patched[0].toolInfo.result, 'written');
  assert.equal(patched[0].toolInfo.status, 'success');
  assert.equal(messages[0].toolInfo.result, undefined);
});

test('an error after completion corrects the same tool card instead of duplicating it', () => {
  const messages = [{
    id: 'tool-message-1',
    role: 'tool',
    text: 'Creating view',
    timestamp: 1,
    toolInfo: {
      tool_name: 'ui_create_view',
      tool_call_id: 'call-create-view',
      tool_args: { title: 'Release smoke' },
      status: 'running',
    },
  }];

  const completed = appendOrPatchTool(messages, {
    tool_name: 'ui_create_view',
    tool_call_id: 'call-create-view',
    result: 'view created',
    status: 'completed',
  });
  const failed = appendOrPatchTool(completed, {
    tool_name: 'ui_create_view',
    tool_call_id: 'call-create-view',
    tool_call_error: true,
    result: 'schema validation failed',
    status: 'error',
  });

  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'tool-message-1');
  assert.equal(failed[0].toolInfo.tool_call_error, true);
  assert.equal(failed[0].toolInfo.result, 'schema validation failed');
  assert.equal(failed[0].toolInfo.status, 'error');
  assert.deepEqual(failed[0].toolInfo.tool_args, { title: 'Release smoke' });
});

test('repeated terminal frames are idempotent by tool call id', () => {
  const completed = {
    tool_name: 'filesystem_write_file',
    tool_call_id: 'call-write',
    result: 'written',
    status: 'completed',
  };

  const first = appendOrPatchTool([], completed);
  const repeated = appendOrPatchTool(first, {
    ...completed,
    result: 'written once',
  });

  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, first[0].id);
  assert.equal(repeated[0].toolInfo.result, 'written once');
});

test('a late running frame cannot downgrade an error terminal state', () => {
  const failed = appendOrPatchTool([], {
    tool_name: 'filesystem_write_file',
    tool_call_id: 'call-write',
    tool_call_error: true,
    result: 'permission denied',
    status: 'error',
  });
  const lateStart = appendOrPatchTool(failed, {
    tool_name: 'filesystem_write_file',
    tool_call_id: 'call-write',
    tool_args: { path: '/root/forbidden' },
    tool_call_error: false,
    status: 'running',
  });

  assert.equal(lateStart.length, 1);
  assert.equal(lateStart[0].id, failed[0].id);
  assert.equal(lateStart[0].toolInfo.tool_call_error, true);
  assert.equal(lateStart[0].toolInfo.result, 'permission denied');
  assert.equal(lateStart[0].toolInfo.status, 'error');
  assert.deepEqual(lateStart[0].toolInfo.tool_args, { path: '/root/forbidden' });
});

test('same-name concurrent tools retain call-id ordering and identity', () => {
  const first = appendOrPatchTool([], {
    tool_name: 'filesystem_read_file',
    tool_call_id: 'call-a',
    tool_args: { path: '/tmp/a' },
  });
  const bothRunning = appendOrPatchTool(first, {
    tool_name: 'filesystem_read_file',
    tool_call_id: 'call-b',
    tool_args: { path: '/tmp/b' },
  });
  const firstCompleted = appendOrPatchTool(bothRunning, {
    tool_name: 'filesystem_read_file',
    tool_call_id: 'call-a',
    result: 'a',
    status: 'completed',
  });

  assert.equal(firstCompleted.length, 2);
  assert.deepEqual(
    firstCompleted.map((message) => message.toolInfo.tool_call_id),
    ['call-a', 'call-b'],
  );
  assert.equal(firstCompleted[0].toolInfo.result, 'a');
  assert.equal(firstCompleted[1].toolInfo.result, undefined);
});

test('a reused tool call id in a later turn cannot rewrite the earlier card', () => {
  const history = [{
    id: 'user-old',
    role: 'user',
    text: 'read the old file',
    timestamp: 1,
  }, {
    id: 'tool-old',
    role: 'tool',
    text: 'Read old.txt',
    timestamp: 2,
    toolInfo: {
      tool_name: 'filesystem_read_file',
      tool_call_id: 'provider-reused-id',
      tool_args: { path: '/tmp/old.txt' },
      result: 'old contents',
      status: 'completed',
    },
  }, {
    id: 'assistant-old',
    role: 'assistant',
    text: 'The old file is ready.',
    timestamp: 3,
  }, {
    id: 'user-new',
    role: 'user',
    text: 'now read the new file',
    timestamp: 4,
  }];

  const started = appendOrPatchTool(history, {
    tool_name: 'filesystem_read_file',
    tool_call_id: 'provider-reused-id',
    tool_args: { path: '/tmp/new.txt' },
    status: 'running',
  });
  const completed = appendOrPatchTool(started, {
    tool_name: 'filesystem_read_file',
    tool_call_id: 'provider-reused-id',
    result: 'new contents',
    status: 'completed',
  });

  assert.equal(completed.length, history.length + 1);
  assert.equal(completed[1].id, 'tool-old');
  assert.equal(completed[1].toolInfo.result, 'old contents');
  assert.deepEqual(completed[1].toolInfo.tool_args, { path: '/tmp/old.txt' });
  assert.equal(completed[4].toolInfo.tool_call_id, 'provider-reused-id');
  assert.equal(completed[4].toolInfo.result, 'new contents');
  assert.deepEqual(completed[4].toolInfo.tool_args, { path: '/tmp/new.txt' });
});

test('a reconnect replay cannot erase execution host from an observed tool call', () => {
  const executionHost = {
    kind: 'client',
    device_label: 'Alessandro MacBook',
    device_id: 'device-1',
    client_instance_id: 'desktop-1',
    generation: 7,
  };
  const previous = [
    {
      id: 'user-live',
      role: 'user',
      text: 'write the file',
      timestamp: 1,
    },
    {
      id: 'tool-live',
      role: 'tool',
      text: 'Writing file',
      timestamp: 2,
      toolInfo: {
        tool_name: 'filesystem_write_file',
        tool_call_id: 'call-1',
        tool_args: { path: '/tmp/client-only.txt' },
        execution_host: executionHost,
      },
    },
  ];
  const replay = [
    {
      id: 'user-replay',
      role: 'user',
      text: 'write the file',
      timestamp: 3,
    },
    {
      id: 'tool-replay',
      role: 'tool',
      text: 'File written',
      timestamp: 4,
      toolInfo: {
        tool_name: 'filesystem_write_file',
        tool_call_id: 'call-1',
        result: 'written',
      },
    },
  ];

  const merged = preserveToolMetadataAcrossReplay(
    previous,
    replay,
    { preserveMessageIds: true },
  );

  assert.equal(merged[1].id, 'tool-live');
  assert.deepEqual(merged[1].toolInfo.execution_host, executionHost);
  assert.deepEqual(merged[1].toolInfo.tool_args, previous[1].toolInfo.tool_args);
  assert.equal(merged[1].toolInfo.result, 'written');
  assert.equal(replay[1].toolInfo.execution_host, undefined);
});

test('the first reasoning frame creates a live sub-agent stub', () => {
  useChat.setState({
    sessions: [],
    activeSessionId: 'parent',
    sessionsHydrated: true,
    sessionHistoryMode: 'v2',
  });
  const childId = 'parent::sub::researcher::run-1';

  useChat.getState().handleServerMessage({
    type: 'reasoning',
    session_id: childId,
    active: true,
  });

  const child = useChat.getState().sessions.find((entry) => entry.id === childId);
  assert.ok(child, 'the reasoning frame must not be dropped before metadata hydration');
  assert.equal(child.origin, 'delegation');
  assert.equal(child.parentSessionId, 'parent');
  assert.equal(child.isProcessing, true);
  assert.equal(child.isReasoning, true);

  useChat.getState().setActiveSession(childId);
  const focused = useChat.getState().sessions.find((entry) => entry.id === childId);
  assert.equal(useChat.getState().activeSessionId, childId);
  assert.equal(focused.isReasoning, true);

  useChat.getState().handleServerMessage({
    type: 'reasoning',
    session_id: childId,
    active: false,
  });
  assert.equal(
    useChat.getState().sessions.find((entry) => entry.id === childId).isReasoning,
    false,
  );
});

test('metadata hydration cannot roll an in-flight transcript back', () => {
  const live = {
    id: 'live-session',
    title: 'Live chat',
    messages: [
      { id: 'u-live', role: 'user', text: 'latest request', timestamp: 1 },
      {
        id: 'a-live', role: 'assistant', text: 'partial reply', timestamp: 2,
        streaming: true,
      },
    ],
    isProcessing: true,
    isReasoning: true,
    statusText: 'Working',
  };
  useChat.setState({
    sessions: [live, {
      id: 'other-session', title: 'Other', messages: [], isProcessing: false,
    }],
    activeSessionId: 'live-session',
    sessionsHydrated: true,
    sessionHistoryMode: 'v2',
  });

  // A history/title event may carry false until the durable run projection
  // catches up. It is metadata, not proof that this local turn ended.
  useChat.getState().hydrateFromServer([{
    session_id: 'live-session',
    title: 'Live chat',
    _live: false,
    last_active_at: 10,
  }]);

  useChat.getState().setActiveSession('other-session');
  useChat.getState().setActiveSession('live-session');
  const restored = useChat.getState().sessions.find((entry) => entry.id === 'live-session');
  assert.deepEqual(restored.messages, live.messages);
  assert.equal(restored.isProcessing, true);
  assert.equal(restored.isReasoning, true);
  assert.equal(restored.statusText, 'Working');
  assert.equal(restored.messages.at(-1).streaming, true);
});
