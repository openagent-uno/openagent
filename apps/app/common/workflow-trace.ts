import type { BlockType, WorkflowRun, WorkflowTraceEntry } from './types';
import { normalizeRunTimestamp } from './run-date-normalization.ts';

/** Canonical additive trace shape returned by v2 gateways. During the beta,
 * some server builds used `trace_step_id` while the published contract uses
 * `id`; accepting both keeps already-indexed search targets resolvable. */
export interface CanonicalWorkflowTraceStep {
  id?: string;
  trace_step_id?: string;
  node_id: string;
  attempt?: number;
  type: string;
  status: string;
  child_session_id?: string | null;
  error_safe?: string | null;
  started_at: string | number;
  finished_at?: string | number | null;
  tool_invocation_ids?: string[];
}

export type WorkflowRunWithCanonicalTrace = WorkflowRun & {
  trace_steps?: CanonicalWorkflowTraceStep[];
};

function epoch(value: string | number | null | undefined, fallback: number | null): number | null {
  return normalizeRunTimestamp(value)?.epochSeconds ?? fallback;
}

function legacyStatus(status: string): WorkflowTraceEntry['status'] {
  if (status === 'running' || status === 'success' || status === 'skipped') return status;
  return 'failed';
}

/** Merge canonical anchors into the rich legacy trace rather than replacing
 * it. Legacy input/output remain available to the existing run UI, while
 * search deep-links gain durable step and tool invocation IDs. */
export function mergeCanonicalWorkflowTrace(
  run: WorkflowRunWithCanonicalTrace,
): WorkflowRun {
  const steps = run.trace_steps;
  const legacy = (run.trace ?? []).map((entry): WorkflowTraceEntry => ({
    ...entry,
    started_at: epoch(entry.started_at, 0) ?? 0,
    finished_at: epoch(entry.finished_at, null),
  }));
  if (!steps?.length) return { ...run, trace: legacy };

  const used = new Set<number>();
  const merged = steps.map((step, canonicalIndex): WorkflowTraceEntry => {
    let legacyIndex = legacy.findIndex(
      (entry, index) => !used.has(index) && index === canonicalIndex && entry.node_id === step.node_id,
    );
    if (legacyIndex < 0) {
      legacyIndex = legacy.findIndex(
        (entry, index) => !used.has(index) && entry.node_id === step.node_id,
      );
    }
    const existing = legacyIndex >= 0 ? legacy[legacyIndex] : undefined;
    if (legacyIndex >= 0) used.add(legacyIndex);
    const stableId = step.id || step.trace_step_id || existing?.id || existing?.trace_step_id;
    const toolInvocationIds = [
      ...(existing?.tool_invocation_ids ?? []),
      ...(step.tool_invocation_ids ?? []),
    ];

    return {
      ...existing,
      id: stableId,
      trace_step_id: stableId,
      node_id: step.node_id,
      type: (existing?.type || step.type) as BlockType,
      status: existing?.status || legacyStatus(step.status),
      started_at: existing?.started_at ?? epoch(step.started_at, 0) ?? 0,
      finished_at: existing?.finished_at ?? epoch(step.finished_at, null),
      child_session_id: step.child_session_id ?? existing?.child_session_id,
      error: existing?.error ?? step.error_safe ?? null,
      tool_invocation_ids: toolInvocationIds.length
        ? [...new Set(toolInvocationIds)]
        : undefined,
    };
  });

  legacy.forEach((entry, index) => {
    if (!used.has(index)) merged.push(entry);
  });
  return { ...run, trace: merged };
}
