import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeCanonicalWorkflowTrace } from '../workflow-trace.ts';

function run(trace, trace_steps) {
  return {
    id: 'run-1', workflow_id: 'wf-1', trigger: 'manual', status: 'success',
    started_at: 1, finished_at: 2, inputs: {}, outputs: {}, error: null,
    trace, trace_steps,
  };
}

test('merges published canonical id into the rich legacy trace', () => {
  const merged = mergeCanonicalWorkflowTrace(run([
    { node_id: 'n1', type: 'mcp-tool', status: 'success', started_at: 1,
      finished_at: 2, input: { tool_name: 'lookup' }, output: { ok: true } },
  ], [
    { id: 'step-1', node_id: 'n1', type: 'mcp-tool', status: 'success',
      started_at: '2026-08-26T10:00:00Z', finished_at: '2026-08-26T10:00:01Z',
      tool_invocation_ids: ['tool-1'] },
  ]));

  assert.equal(merged.trace[0].id, 'step-1');
  assert.equal(merged.trace[0].trace_step_id, 'step-1');
  assert.deepEqual(merged.trace[0].input, { tool_name: 'lookup' });
  assert.deepEqual(merged.trace[0].tool_invocation_ids, ['tool-1']);
});

test('accepts beta trace_step_id and builds a canonical-only fallback', () => {
  const merged = mergeCanonicalWorkflowTrace(run([], [
    { trace_step_id: 'step-beta', node_id: 'n2', type: 'wait', status: 'cancelled',
      started_at: '2026-08-26T10:00:00Z', finished_at: null, tool_invocation_ids: [] },
  ]));

  assert.equal(merged.trace[0].id, 'step-beta');
  assert.equal(merged.trace[0].status, 'failed');
  assert.equal(merged.trace[0].started_at, Date.parse('2026-08-26T10:00:00Z') / 1000);
});

test('normalizes legacy-only ISO and millisecond trace dates to epoch seconds', () => {
  const started = '2026-08-26T10:00:00Z';
  const finishedMs = Date.parse('2026-08-26T10:00:01Z');
  const merged = mergeCanonicalWorkflowTrace(run([
    { node_id: 'n1', type: 'wait', status: 'success', started_at: started,
      finished_at: finishedMs },
  ], undefined));

  assert.equal(merged.trace[0].started_at, Date.parse(started) / 1000);
  assert.equal(merged.trace[0].finished_at, finishedMs / 1000);
  assert.equal(merged.trace[0].finished_at - merged.trace[0].started_at, 1);
});
