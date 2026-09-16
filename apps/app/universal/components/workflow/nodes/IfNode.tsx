import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { expression?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const IfNode = memo(function IfNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  return (
    <BaseNode
      icon="git-pull-request"
      typeLabel="If"
      label={data.label || 'Conditional'}
      preview={data.config?.expression || 'Write an expression'}
      status={data.status}
      selected={selected}
      sourceHandles={['true', 'false']}
      handleLabels={{ true: 'true', false: 'false' }}
    />
  );
});
