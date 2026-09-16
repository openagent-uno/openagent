import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { branches?: number };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const ParallelNode = memo(function ParallelNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const n = Math.max(2, Math.min(4, data.config?.branches || 2));
  const handles = Array.from({ length: n }, (_, i) => `branch_${i}`);
  const labels: Record<string, string> = {};
  handles.forEach((h, i) => { labels[h] = `#${i}`; });
  return (
    <BaseNode
      icon="share-2"
      typeLabel="Parallel"
      label={data.label || `Fan-out × ${n}`}
      preview={`Run ${n} branches concurrently`}
      status={data.status}
      selected={selected}
      sourceHandles={handles}
      handleLabels={labels}
    />
  );
});
