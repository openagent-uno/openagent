/**
 * Trigger: Manual — no input handles, one output carrying the
 * run-level inputs dict.
 */

import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { inputs_schema?: unknown };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const TriggerManualNode = memo(function TriggerManualNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const schema = data.config?.inputs_schema as Record<string, unknown> | undefined;
  const preview = schema && Object.keys(schema).length
    ? `inputs: ${Object.keys(schema).join(', ')}`
    : 'Triggered by the Run button';
  return (
    <BaseNode
      icon="play-circle"
      typeLabel="Manual"
      label={data.label || 'Run'}
      preview={preview}
      status={data.status}
      selected={selected}
      targetHandles={[]}
    />
  );
});
