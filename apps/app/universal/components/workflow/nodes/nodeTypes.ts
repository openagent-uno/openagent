/**
 * React Flow nodeTypes map — keyed by the workflow block type string
 * so graph_json round-trips unchanged. Order mirrors BLOCK_CATALOG
 * groups (triggers, tools, ai, flow, utility) for palette grouping.
 */

import type { ComponentType } from 'react';
import { AiPromptNode } from './AiPromptNode';
import { HttpRequestNode } from './HttpRequestNode';
import { IfNode } from './IfNode';
import { LoopNode } from './LoopNode';
import { McpToolNode } from './McpToolNode';
import { MergeNode } from './MergeNode';
import { ParallelNode } from './ParallelNode';
import { SetVariableNode } from './SetVariableNode';
import { TriggerAiNode } from './TriggerAiNode';
import { TriggerManualNode } from './TriggerManualNode';
import { TriggerScheduleNode } from './TriggerScheduleNode';
import { WaitNode } from './WaitNode';

export const nodeTypes: Record<string, ComponentType<any>> = {
  'trigger-manual': TriggerManualNode,
  'trigger-schedule': TriggerScheduleNode,
  'trigger-ai': TriggerAiNode,
  'mcp-tool': McpToolNode,
  'ai-prompt': AiPromptNode,
  'set-variable': SetVariableNode,
  if: IfNode,
  loop: LoopNode,
  wait: WaitNode,
  parallel: ParallelNode,
  merge: MergeNode,
  'http-request': HttpRequestNode,
};
