import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { strategy?: string; collect_as?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const MergeNode = memo(function MergeNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  return (
    <BaseNode
      icon="git-merge"
      typeLabel="Merge"
      label={data.label || 'Join branches'}
      preview={data.config?.strategy
        ? `strategy: ${data.config.strategy}`
        : 'Join upstream branches'}
      status={data.status}
      selected={selected}
    />
  );
});
