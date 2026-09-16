import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { description?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const TriggerAiNode = memo(function TriggerAiNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  return (
    <BaseNode
      icon="cpu"
      typeLabel="AI trigger"
      label={data.label || 'When AI invokes'}
      preview={data.config?.description || 'AI-invoked via run_workflow()'}
      status={data.status}
      selected={selected}
      targetHandles={[]}
    />
  );
});
