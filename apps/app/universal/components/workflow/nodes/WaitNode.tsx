import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { mode?: string; seconds?: number; until_iso?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const WaitNode = memo(function WaitNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const cfg = data.config || {};
  const preview =
    cfg.mode === 'duration' && cfg.seconds
      ? `wait ${cfg.seconds}s`
      : cfg.mode === 'until' && cfg.until_iso
      ? `wait until ${cfg.until_iso}`
      : 'Pick duration or until';
  return (
    <BaseNode
      icon="pause-circle"
      typeLabel="Wait"
      label={data.label || 'Wait'}
      preview={preview}
      status={data.status}
      selected={selected}
    />
  );
});
