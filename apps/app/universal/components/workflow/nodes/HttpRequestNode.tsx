import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { method?: string; url?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const HttpRequestNode = memo(function HttpRequestNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const method = (data.config?.method || 'GET').toUpperCase();
  const url = data.config?.url;
  const preview = url ? `${method} ${url}` : `${method} — enter URL`;
  return (
    <BaseNode
      icon="globe"
      typeLabel="HTTP"
      label={data.label || 'HTTP request'}
      preview={preview}
      status={data.status}
      selected={selected}
    />
  );
});
