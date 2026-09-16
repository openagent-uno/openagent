import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: { key?: string; value_expr?: string };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const SetVariableNode = memo(function SetVariableNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const key = data.config?.key;
  const expr = data.config?.value_expr;
  const preview = key && expr ? `${key} = ${expr}` : 'Set a variable';
  return (
    <BaseNode
      icon="edit-3"
      typeLabel="Set var"
      label={data.label || 'Set variable'}
      preview={preview}
      status={data.status}
      selected={selected}
    />
  );
});
