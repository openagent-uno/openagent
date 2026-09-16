import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveTool, isMemoryTool, runLaunchTarget, toolPhase } from '../types.ts';
import {
  compactToolFallback,
  legacyToolInfoFromText,
  toolCardHasExpandableDetails,
  toolInfoFromInvocationDetail,
  toolInfoFromSummary,
  toolMessageRenderKey,
} from '../tool-presentation.ts';

test('compact transcript summary becomes a completed collapsed-card model without result JSON', () => {
  const info = toolInfoFromSummary({
    id: 'tool-1',
    tool_call_id: 'call-1',
    tool_server: 'builtin',
    tool_name: 'shell_execute',
    status: 'success',
    child_run_id: null,
    child_session_id: null,
    completeness: 'complete',
  });

  assert.ok(info);
  assert.equal(toolPhase(info), 'completed');
  assert.equal(info.result, '');
  assert.deepEqual(info.tool_args, {});
  assert.equal(info.tool_invocation_id, 'tool-1');
  assert.equal(info.tool_call_id, 'call-1');
  assert.equal(info.tool_server, 'builtin');
  assert.equal(info.server, 'builtin');
});

test('live and canonical tool rows keep one React identity across reconciliation', () => {
  const live = {
    tool_name: 'filesystem_write_file',
    tool_call_id: 'call-stable',
    tool_args: { path: '/tmp/example' },
  };
  const canonical = toolInfoFromSummary({
    id: 'invocation-durable',
    tool_call_id: 'call-stable',
    tool_name: 'filesystem_write_file',
    status: 'success',
  });

  assert.ok(canonical);
  assert.equal(
    toolMessageRenderKey('message-live', live),
    toolMessageRenderKey('message-durable', canonical, 'invocation-durable'),
  );
  assert.equal(toolMessageRenderKey('message-only'), 'message-only');
});

test('redacted canonical tool card remains expandable for execution host details', () => {
  const info = toolInfoFromSummary({
    id: 'tool-hosted',
    tool_call_id: 'call-hosted',
    tool_name: 'filesystem_write_file',
    status: 'success',
  });
  assert.ok(info);
  assert.equal(toolCardHasExpandableDetails(info), false);

  info.execution_host = {
    kind: 'client',
    device_label: 'Desktop runner',
    device_id: 'device-1',
    client_instance_id: 'desktop-1',
    generation: 1,
  };
  assert.equal(toolCardHasExpandableDetails(info), true);
});

test('summary preserves child run and session links used by specialized cards', () => {
  const info = toolInfoFromSummary({
    id: 'tool-child',
    tool_name: 'delegate_task',
    status: 'running',
    child_run_id: 'run-child',
    child_session_id: 'session-child',
  });

  assert.ok(info);
  assert.equal(info.child_run_id, 'run-child');
  assert.equal(info.child_session_id, 'session-child');
});

test('authorized normalized run target reopens launcher cards without result JSON', () => {
  for (const [kind, runId, parentId] of [
    ['task', 'task-run-1', 'task-1'],
    ['workflow', 'workflow-run-1', 'workflow-1'],
    ['event', 'event-delivery-1', 'event-1'],
  ]) {
    const info = toolInfoFromSummary({
      id: `tool-${kind}`,
      tool_name: 'tool_search_call_tool',
      effective_tool_name: kind === 'task'
        ? 'scheduler_run_scheduled_task_now'
        : kind === 'workflow'
          ? 'workflow_manager_run_workflow'
          : 'events_manager_trigger_event',
      status: 'success',
      run_target: {
        kind,
        run_id: runId,
        parent_id: parentId,
      },
    });

    assert.ok(info);
    assert.deepEqual(info.tool_args, {});
    assert.equal(info.result, '');
    assert.deepEqual(runLaunchTarget(info), {
      kind,
      runId,
      parentId,
      status: 'success',
    });
  }
});

test('deferred summary preserves only the inner identity for friendly specialized cards', () => {
  const info = toolInfoFromSummary({
    id: 'tool-deferred',
    tool_server: 'tool-search',
    tool_name: 'tool_search_call_tool',
    effective_tool_server: 'vault',
    effective_tool_name: 'read_note',
    status: 'success',
  });

  assert.ok(info);
  assert.equal(info.effective_tool_server, 'vault');
  assert.equal(info.effective_tool_name, 'read_note');
  assert.deepEqual(info.tool_args, {});
  assert.deepEqual(effectiveTool(info), {
    tool_name: 'read_note',
    server: 'vault',
    tool_args: {},
    result: '',
    tool_call_error: false,
    child_session_id: undefined,
    child_session_title: undefined,
    child_model: undefined,
  });
  assert.equal(isMemoryTool(info), true);
});

test('summary lifecycle maps running and failed tools without using message text', () => {
  const running = toolInfoFromSummary({
    id: 'tool-running',
    tool_name: 'fetch_data',
    status: 'running',
  });
  const failed = toolInfoFromSummary({
    id: 'tool-failed',
    tool_name: 'fetch_data',
    status: 'error',
  });

  assert.ok(running);
  assert.ok(failed);
  assert.equal(toolPhase(running), 'running');
  assert.equal(toolPhase(failed), 'error');
  assert.equal(failed.result, 'Tool execution failed');
});

test('cancelled and interrupted summaries are stopped, not errors', () => {
  for (const status of ['cancelled', 'interrupted']) {
    const info = toolInfoFromSummary({
      id: `tool-${status}`,
      tool_name: 'fetch_data',
      status,
    });
    assert.ok(info);
    assert.equal(toolPhase(info), 'stopped');
    assert.equal(info.tool_call_error, false);
    assert.equal(info.result, 'Tool execution stopped');
  }
});

test('authorized detail uses the same card adapter and bounds a large result preview', () => {
  const detail = toolInfoFromInvocationDetail({
    id: 'tool-detail',
    tool_call_id: 'call-detail',
    root_kind: 'chat',
    root_id: 'session-1',
    tool_server: 'files',
    tool_name: 'read_file',
    status: 'success',
    args_safe: { path: '/tmp/example' },
    result_safe: 'x'.repeat(20_000),
    error_safe: null,
    child_session_id: null,
    sensitivity: 'safe',
    completeness: 'complete',
    artifacts: [],
    created_at: '2026-08-28T10:00:00Z',
  });

  assert.ok(detail);
  assert.equal(toolPhase(detail), 'completed');
  assert.deepEqual(detail.tool_args, { path: '/tmp/example' });
  assert.match(detail.result, /result truncated in chat/);
  assert.ok(detail.result.length < 13_000);
});

test('legacy compatibility parses only bounded ToolExecution envelopes', () => {
  assert.equal(legacyToolInfoFromText('{"tool_name":"shell_execute","result":"ok"}')?.tool_name, 'shell_execute');
  assert.equal(legacyToolInfoFromText(`{"payload":"${'x'.repeat(70_000)}"}`), undefined);
});

test('raw normalized tool output is replaced by a safe compact fallback title', () => {
  const hugeJson = JSON.stringify({ records: ['sensitive'.repeat(30_000)] });
  assert.equal(compactToolFallback(hugeJson), 'Tool result');
  assert.equal(compactToolFallback('Using shell_execute…'), 'Using shell_execute…');
  assert.ok(compactToolFallback(`Using ${'x'.repeat(300)}`).length <= 120);
});
