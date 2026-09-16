/**
 * Properties editor for an ``mcp-tool`` block.
 *
 * Two-step picker:
 *   1. Pick an MCP (from the live /api/mcp-tools list)
 *   2. Pick a tool exposed by that MCP
 *
 * Then the ``args`` JSON is edited as text — still supports templating
 * via {{...}}. Phase 4 keeps this as a raw JSON textarea; a schema-
 * driven form builder lands in Phase 5 (when we have JSON-schema
 * inputs to drive it).
 */

import { useMemo } from 'react';
import type { WorkflowNode } from '../../../../common/types';
import { useWorkflows } from '../../../stores/workflows';
import { colors, font, radius } from '../../../theme';
import FormField from './FormField';

type OnError = 'halt' | 'continue' | 'branch';

interface Props {
  node: WorkflowNode;
  onChange: (patch: Partial<WorkflowNode>) => void;
}

export default function McpToolProperties({ node, onChange }: Props) {
  const config = (node.config || {}) as Record<string, any>;
  const mcps = useWorkflows((s) => s.mcpTools);

  const setConfig = (patch: Record<string, unknown>) => {
    onChange({ config: { ...config, ...patch } });
  };

  const currentMcp = config.mcp_name as string | undefined;
  const currentTool = config.tool_name as string | undefined;

  const toolsForMcp = useMemo(() => {
    if (!currentMcp) return [];
    const entry = mcps.find((m) => m.mcp_name === currentMcp);
    return entry?.tools || [];
  }, [mcps, currentMcp]);

  const argsText = useMemo(() => {
    try {
      return JSON.stringify(config.args ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [config.args]);

  const onArgsChange = (text: string) => {
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      setConfig({ args: parsed });
    } catch {
      // Keep the text as a raw string so the user can finish typing;
      // persist as ``_args_raw`` so validation upstream can surface
      // the error without losing their work.
      setConfig({ args: {}, _args_raw: text });
    }
  };

  return (
    <div>
      <div id="workflow-field-mcp_name" style={{ marginBottom: 10 }}>
        <div style={styles.label}>MCP</div>
        {mcps.length === 0 ? (
          <div style={styles.emptyNote}>
            No MCPs loaded yet. Install or enable an MCP from the MCPs
            tab, then return here.
          </div>
        ) : (
          <select
            value={currentMcp || ''}
            onChange={(e) => {
              setConfig({ mcp_name: e.target.value || null, tool_name: null });
            }}
            style={styles.select as any}
          >
            <option value="">— choose an MCP —</option>
            {mcps.map((m) => (
              <option key={m.mcp_name} value={m.mcp_name}>
                {m.mcp_name} ({m.tools.length})
              </option>
            ))}
          </select>
        )}
      </div>

      <div id="workflow-field-tool_name" style={{ marginBottom: 10 }}>
        <div style={styles.label}>Tool</div>
        <select
          value={currentTool || ''}
          onChange={(e) => setConfig({ tool_name: e.target.value || null })}
          disabled={!currentMcp}
          style={styles.select as any}
        >
          <option value="">— pick a tool —</option>
          {toolsForMcp.map((t) => (
            <option key={t.name} value={t.name} title={t.description}>
              {t.name}
            </option>
          ))}
        </select>
        {currentTool && toolsForMcp.length > 0 && (
          <div style={styles.hint}>
            {toolsForMcp.find((t) => t.name === currentTool)?.description}
          </div>
        )}
      </div>

      <FormField
        fieldKey="args"
        label="Arguments (JSON)"
        value={argsText}
        onChange={onArgsChange}
        placeholder='{ "text": "{{inputs.message}}" }'
        hint="String values support {{...}} templating — resolved per run."
        multiline
        monospaced
        rows={8}
      />

      <div id="workflow-field-on_error" style={{ marginBottom: 10 }}>
        <div style={styles.label}>On error</div>
        <div style={styles.chipRow}>
          {(['halt', 'continue', 'branch'] as OnError[]).map((e) => (
            <button
              key={e}
              onClick={() => setConfig({ on_error: e })}
              style={{
                ...styles.chip,
                ...((config.on_error || 'halt') === e
                  ? styles.chipActive
                  : {}),
              } as any}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  label: {
    fontSize: 10,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  select: {
    width: '100%',
    padding: '7px 9px',
    backgroundColor: colors.inputBg,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 12,
    fontFamily: font.sans,
    outline: 'none',
    boxSizing: 'border-box',
  },
  emptyNote: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: '15px',
    padding: 8,
    background: colors.primarySoft,
    border: `1px dashed ${colors.border}`,
    borderRadius: radius.md,
  },
  hint: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
    lineHeight: '14px',
  },
  chipRow: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  chip: {
    padding: '5px 10px',
    borderRadius: radius.pill,
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.inputBg,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: 500,
    fontFamily: font.sans,
    cursor: 'pointer',
  },
  chipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
    color: colors.primary,
  },
};
