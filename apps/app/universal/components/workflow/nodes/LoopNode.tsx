import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { items_expr?: string; max_iterations?: number; iteration_var?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const LoopNode = memo(function LoopNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const preview = data.config?.items_expr
    ? `for ${data.config.iteration_var || 'item'} in ${data.config.items_expr}`
    : 'Loop over a list';
  return (
    <BaseNode
      icon="repeat"
      typeLabel="Loop"
      label={data.label || 'For each'}
      preview={preview}
      status={data.status}
      selected={selected}
      sourceHandles={['body', 'done']}
      handleLabels={{ body: 'body', done: 'done' }}
    />
  );
});
