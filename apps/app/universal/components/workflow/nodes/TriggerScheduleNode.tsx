import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { cron_expression?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const TriggerScheduleNode = memo(function TriggerScheduleNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  return (
    <BaseNode
      icon="clock"
      typeLabel="Schedule"
      label={data.label || 'On schedule'}
      preview={data.config?.cron_expression || 'Not scheduled yet'}
      status={data.status}
      selected={selected}
      targetHandles={[]}
    />
  );
});
