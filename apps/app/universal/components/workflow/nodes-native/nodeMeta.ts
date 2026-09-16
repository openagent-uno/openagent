/**
 * Per-block-type metadata used by the native editor (icon, label,
 * category, handle layout, preview renderer). Single source of truth
 * so the native canvas, the bottom-sheet palette, and the native
 * properties modal all agree on shape + colour.
 */

import type { BlockType } from '../../../../common/types';

export interface NativeNodeMeta {
  type: BlockType;
  icon: string; // Feather icon name
  label: string;
  category: 'triggers' | 'ai' | 'tools' | 'flow' | 'utility';
  sourceHandles: string[];
  targetHandles: string[];
  // Returns a short single-line preview from the node's config
  preview: (config: Record<string, unknown>) => string;
}

function truncate(v: unknown, n = 48): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export const NODE_META: Record<BlockType, NativeNodeMeta> = {
  'trigger-manual': {
    type: 'trigger-manual',
    icon: 'play-circle',
    label: 'Manual trigger',
    category: 'triggers',
    sourceHandles: ['out'],
    targetHandles: [],
    preview: (c) => {
      const schema = c.inputs_schema as Record<string, unknown> | undefined;
      return schema && Object.keys(schema).length
        ? `inputs: ${Object.keys(schema).join(', ')}`
        : 'Triggered by the Run button';
    },
  },
  'trigger-schedule': {
    type: 'trigger-schedule',
    icon: 'clock',
    label: 'Scheduled trigger',
    category: 'triggers',
    sourceHandles: ['out'],
    targetHandles: [],
    preview: (c) => (c.cron_expression as string) || 'No cron set',
  },
  'trigger-ai': {
    type: 'trigger-ai',
    icon: 'cpu',
    label: 'AI trigger',
    category: 'triggers',
    sourceHandles: ['out'],
    targetHandles: [],
    preview: (c) => truncate(c.description || 'AI-invoked via run_workflow()'),
  },
  'trigger-event': {
    type: 'trigger-event',
    icon: 'zap',
    label: 'Event trigger',
    category: 'triggers',
    sourceHandles: ['out'],
    targetHandles: [],
    preview: (c) => truncate((c.event as string) || 'Fired by a webhook event'),
  },
  'ai-prompt': {
    type: 'ai-prompt',
    icon: 'message-square',
    label: 'AI prompt',
    category: 'ai',
    sourceHandles: ['out'],
    targetHandles: ['in'],
    preview: (c) => {
      const m = c.model_override ? `[${c.model_override}] ` : '';
      return truncate(m + (c.prompt || 'Write a prompt'));
    },
  },
  'mcp-tool': {
    type: 'mcp-tool',
    icon: 'tool',
    label: 'MCP tool',
    category: 'tools',
    sourceHandles: ['out'],
    targetHandles: ['in'],
    preview: (c) => {
      const mcp = c.mcp_name as string | undefined;
      const tool = c.tool_name as string | undefined;
      return mcp && tool ? `${mcp} · ${tool}` : 'Pick an MCP tool';
    },
  },
  'set-variable': {
    type: 'set-variable',
    icon: 'edit-3',
    label: 'Set variable',
    category: 'utility',
    sourceHandles: ['out'],
    targetHandles: ['in'],
    preview: (c) => {
      const k = c.key as string | undefined;
      const v = c.value_expr as string | undefined;
      return k && v ? `${k} = ${truncate(v)}` : 'Set a variable';
    },
  },
  if: {
    type: 'if',
    icon: 'git-pull-request',
    label: 'If / branch',
    category: 'flow',
    sourceHandles: ['true', 'false'],
    targetHandles: ['in'],
    preview: (c) => truncate(c.expression || 'Write an expression'),
  },
  loop: {
    type: 'loop',
    icon: 'repeat',
    label: 'Loop',
    category: 'flow',
    sourceHandles: ['body', 'done'],
    targetHandles: ['in'],
    preview: (c) => {
      const it = (c.iteration_var as string) || 'item';
      const items = c.items_expr as string | undefined;
      return items ? `for ${it} in ${truncate(items, 30)}` : 'Loop over a list';
    },
  },
  wait: {
    type: 'wait',
    icon: 'pause-circle',
    label: 'Wait',
    category: 'flow',
    sourceHandles: ['out'],
    targetHandles: ['in'],
    preview: (c) => {
      const m = c.mode as string | undefined;
      if (m === 'duration' && c.seconds) return `wait ${c.seconds}s`;
      if (m === 'until' && c.until_iso) return `until ${c.until_iso}`;
      return 'Pick duration or until';
    },
  },
  parallel: {
    type: 'parallel',
    icon: 'share-2',
    label: 'Parallel',
    category: 'flow',
    sourceHandles: ['branch_0', 'branch_1', 'branch_2', 'branch_3'],
    targetHandles: ['in'],
    preview: (c) => `Run ${c.branches || 2} branches concurrently`,
  },
  merge: {
    type: 'merge',
    icon: 'git-merge',
    label: 'Merge',
    category: 'flow',
    sourceHandles: ['out'],
    targetHandles: ['in'],
    preview: (c) =>
      c.strategy ? `strategy: ${c.strategy}` : 'Join upstream branches',
  },
  'http-request': {
    type: 'http-request',
    icon: 'globe',
    label: 'HTTP request',
    category: 'tools',
    sourceHandles: ['out'],
    targetHandles: ['in'],
    preview: (c) => {
      const m = ((c.method as string) || 'GET').toUpperCase();
      return c.url ? `${m} ${truncate(c.url as string, 30)}` : `${m} — enter URL`;
    },
  },
};

export const CATEGORY_ORDER: NativeNodeMeta['category'][] = [
  'triggers',
  'ai',
  'tools',
  'flow',
  'utility',
];

export const CATEGORY_LABEL: Record<NativeNodeMeta['category'], string> = {
  triggers: 'Triggers',
  ai: 'AI',
  tools: 'Tools',
  flow: 'Flow control',
  utility: 'Utility',
};
