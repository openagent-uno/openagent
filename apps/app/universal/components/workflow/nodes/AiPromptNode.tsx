import { memo } from 'react';
import { BaseNode } from './BaseNode';

interface NodeData {
  label?: string;
  config?: {
    prompt?: string;
    model_override?: string;
    session_policy?: string;
  };
  status?: 'idle' | 'running' | 'success' | 'failed';
}

export const AiPromptNode = memo(function AiPromptNode({
  data,
  selected,
}: {
  data: NodeData;
  selected: boolean;
}) {
  const prompt = data.config?.prompt;
  const model = data.config?.model_override;
  const preview = prompt
    ? (model ? `[${model}] ` : '') + prompt
    : 'Write a prompt';
  return (
    <BaseNode
      icon="message-square"
      typeLabel="AI prompt"
      label={data.label || 'AI prompt'}
      preview={preview}
      status={data.status}
      selected={selected}
    />
  );
});
