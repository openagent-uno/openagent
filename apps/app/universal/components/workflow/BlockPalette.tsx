/**
 * BlockPalette — left sidebar showing every available block type,
 * grouped by category. Each tile is draggable; dropping it onto the
 * React Flow canvas creates a new node (see WorkflowEditor.web.tsx
 * onDrop handler for the translation math).
 *
 * Categories mirror BLOCK_CATALOG.category: triggers, ai, tools,
 * flow, utility. The palette reads from the /api/workflow-block-types
 * endpoint via the workflows store, so adding a new block type on
 * the server shows up here without any frontend churn.
 */

import Feather from '@expo/vector-icons/Feather';
import type { DragEvent } from 'react';
import { colors, font, radius } from '../../theme';
import type { BlockTypeSpec } from '../../../common/types';

const CATEGORY_ORDER = ['triggers', 'ai', 'tools', 'flow', 'utility'] as const;

const CATEGORY_LABEL: Record<string, string> = {
  triggers: 'Triggers',
  ai: 'AI',
  tools: 'Tools',
  flow: 'Flow control',
  utility: 'Utility',
};

// Icon per block type. Kept here so palette tiles render without
// instantiating the full custom-node component just for an icon.
const BLOCK_ICON: Record<string, string> = {
  'trigger-manual': 'play-circle',
  'trigger-schedule': 'clock',
  'trigger-ai': 'cpu',
  'ai-prompt': 'message-square',
  'mcp-tool': 'tool',
  'set-variable': 'edit-3',
  if: 'git-pull-request',
  loop: 'repeat',
  wait: 'pause-circle',
  parallel: 'share-2',
  merge: 'git-merge',
  'http-request': 'globe',
};

const BLOCK_LABEL: Record<string, string> = {
  'trigger-manual': 'Manual trigger',
  'trigger-schedule': 'Scheduled trigger',
  'trigger-ai': 'AI trigger',
  'ai-prompt': 'AI prompt',
  'mcp-tool': 'MCP tool',
  'set-variable': 'Set variable',
  if: 'If / branch',
  loop: 'Loop',
  wait: 'Wait',
  parallel: 'Parallel',
  merge: 'Merge',
  'http-request': 'HTTP request',
};

interface Props {
  blockTypes: BlockTypeSpec[];
  onDragStart?: (type: string) => void;
}

export default function BlockPalette({ blockTypes, onDragStart }: Props) {
  const byCategory: Record<string, BlockTypeSpec[]> = {};
  for (const b of blockTypes) {
    (byCategory[b.category] = byCategory[b.category] || []).push(b);
  }

  const handleDragStart = (event: DragEvent, type: string) => {
    // Set the block type in the drag data; the canvas reads it in onDrop.
    event.dataTransfer.setData('application/oa-block', type);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart?.(type);
  };

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <span style={styles.headerText}>Blocks</span>
        <span style={styles.headerHint}>Drag onto the canvas</span>
      </div>
      <div style={styles.scroll}>
        {CATEGORY_ORDER.map((cat) => {
          const items = byCategory[cat];
          if (!items || items.length === 0) return null;
          return (
            <div key={cat} style={styles.category}>
              <div style={styles.categoryLabel}>{CATEGORY_LABEL[cat] || cat}</div>
              {items.map((b) => (
                <div
                  key={b.type}
                  draggable
                  onDragStart={(e) => handleDragStart(e, b.type)}
                  style={styles.tile}
                  title={b.description}
                >
                  <Feather
                    name={(BLOCK_ICON[b.type] || 'box') as any}
                    size={14}
                    color={colors.primary}
                  />
                  <span style={styles.tileLabel}>
                    {BLOCK_LABEL[b.type] || b.type}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  sidebar: {
    width: 220,
    backgroundColor: colors.sidebar,
    borderRight: `1px solid ${colors.border}`,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: font.sans,
  },
  header: {
    padding: '10px 14px',
    borderBottom: `1px solid ${colors.borderLight}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  headerText: {
    fontSize: 11,
    fontWeight: 600,
    color: colors.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  headerHint: {
    fontSize: 10,
    color: colors.textMuted,
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 10px',
  },
  category: {
    marginBottom: 12,
  },
  categoryLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    padding: '6px 2px',
  },
  tile: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    marginBottom: 3,
    backgroundColor: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    cursor: 'grab',
    userSelect: 'none',
  },
  tileLabel: {
    fontSize: 12,
    color: colors.text,
    fontWeight: 500,
  },
};
