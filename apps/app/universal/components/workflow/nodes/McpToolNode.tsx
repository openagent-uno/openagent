import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { mcp_name?: string; tool_name?: string; args?: Record<string, unknown> };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const McpToolNode = memo(function McpToolNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const mcp = data.config?.mcp_name;
  const tool = data.config?.tool_name;
  const preview = mcp && tool ? `${mcp} · ${tool}` : 'Pick an MCP tool';
  return (
    <BaseNode
      icon="tool"
      typeLabel="MCP tool"
      label={data.label || 'Tool call'}
      preview={preview}
      status={data.status}
      selected={selected}
    />
  );
});
