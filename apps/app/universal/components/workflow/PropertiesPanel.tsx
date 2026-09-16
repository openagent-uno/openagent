/**
 * PropertiesPanel — right-rail editor for the currently selected node.
 *
 * Dispatches to a per-type properties editor. When none is registered,
 * falls back to the schema-driven ``GenericProperties`` renderer which
 * reads the ``BLOCK_CATALOG`` entry served by
 * /api/workflow-block-types.
 *
 * Also lets the user edit the block's label (shown on the node
 * badge) and delete the node entirely.
 */

import Feather from '@expo/vector-icons/Feather';
import { useEffect } from 'react';
import type { BlockTypeSpec, WorkflowNode } from '../../../common/types';
import { colors, font, radius } from '../../theme';
import AiPromptProperties from './properties/AiPromptProperties';
import FormField from './properties/FormField';
import GenericProperties from './properties/GenericProperties';
import McpToolProperties from './properties/McpToolProperties';
import TriggerManualProperties from './properties/TriggerManualProperties';
import TriggerScheduleProperties from './properties/TriggerScheduleProperties';

interface Props {
  node: WorkflowNode | null;
  blockTypes: BlockTypeSpec[];
  initialField?: string;
  onChange: (nodeId: string, patch: Partial<WorkflowNode>) => void;
  onDelete: (nodeId: string) => void;
}

const DEDICATED_EDITORS: Record<string, any> = {
  'ai-prompt': AiPromptProperties,
  'mcp-tool': McpToolProperties,
  'trigger-manual': TriggerManualProperties,
  'trigger-schedule': TriggerScheduleProperties,
};

export default function PropertiesPanel({
  node,
  blockTypes,
  initialField,
  onChange,
  onDelete,
}: Props) {
  const nodeId = node?.id;
  useEffect(() => {
    if (!nodeId || !initialField || typeof document === 'undefined') return;
    const candidates = [initialField, initialField.split('.').pop()].filter(Boolean) as string[];
    const timer = setTimeout(() => {
      for (const candidate of candidates) {
        const element = document.getElementById(`workflow-field-${encodeURIComponent(candidate)}`);
        if (!element) continue;
        element.scrollIntoView({ block: 'center' });
        element.focus?.({ preventScroll: true });
        break;
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [initialField, nodeId]);

  if (!node) {
    return (
      <div style={styles.sidebar}>
        <div style={styles.header}>
          <span style={styles.headerText}>Properties</span>
        </div>
        <div style={styles.emptyPane}>
          <Feather name="mouse-pointer" size={14} color={colors.textMuted} />
          <span style={styles.emptyText}>
            Select a block on the canvas to edit its settings.
          </span>
        </div>
      </div>
    );
  }

  const spec = blockTypes.find((b) => b.type === node.type);
  const Editor = DEDICATED_EDITORS[node.type];

  const handlePatch = (patch: Partial<WorkflowNode>) => onChange(node.id, patch);

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <div style={styles.headerRow}>
          <span style={styles.headerText}>
            {spec?.type || node.type}
          </span>
          <button
            onClick={() => onDelete(node.id)}
            style={styles.deleteBtn as any}
            title="Delete block"
          >
            <Feather name="trash-2" size={13} color={colors.error} />
          </button>
        </div>
        <span style={styles.headerHint}>{node.id}</span>
      </div>

      <div style={styles.scroll}>
        <FormField
          fieldKey="label"
          label="Label"
          value={node.label || ''}
          onChange={(v) => handlePatch({ label: v })}
          placeholder={spec?.type || node.type}
          hint="Shown on the node on the canvas."
        />

        {Editor ? (
          <Editor node={node} onChange={handlePatch} />
        ) : (
          <GenericProperties node={node} spec={spec} onChange={handlePatch} />
        )}
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  sidebar: {
    width: 320,
    backgroundColor: colors.sidebar,
    borderLeft: `1px solid ${colors.border}`,
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
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerText: {
    fontSize: 11,
    fontWeight: 700,
    color: colors.primary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerHint: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: font.mono,
  },
  deleteBtn: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 4,
    borderRadius: radius.sm,
  },
  emptyPane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: '15px',
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 14px',
  },
};
