/**
 * Properties editor for an ``ai-prompt`` block. Covers prompt +
 * system + model_override + session_policy. The model picker shows
 * the live catalog from the models store so hardcoding a specific
 * model per block is trivial — leave blank to fall back to the
 * router's pick.
 */

import { useEffect, useState } from 'react';
import type { WorkflowNode } from '../../../../common/types';
import { colors, font, radius } from '../../../theme';
import { listDbModels } from '../../../services/api';
import FormField from './FormField';

type Policy = 'ephemeral' | 'shared';
type OnError = 'halt' | 'continue' | 'branch';

interface Props {
  node: WorkflowNode;
  onChange: (patch: Partial<WorkflowNode>) => void;
}

export default function AiPromptProperties({ node, onChange }: Props) {
  const config = (node.config || {}) as Record<string, any>;

  const setConfig = (patch: Record<string, unknown>) => {
    onChange({ config: { ...config, ...patch } });
  };

  const [availableModels, setAvailableModels] = useState<string[]>([]);

  useEffect(() => {
    // Load the enabled-model catalog once per selection. The services
    // layer already knows the gateway baseUrl from the login flow, so
    // this reuses that single-source-of-truth client.
    let cancelled = false;
    (async () => {
      try {
        const models = await listDbModels({ enabledOnly: true });
        if (cancelled) return;
        setAvailableModels(models.map((m) => m.runtime_id).filter(Boolean));
      } catch {
        // Non-fatal — fall back to plain text input.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <FormField
        fieldKey="prompt"
        label="Prompt"
        value={config.prompt || ''}
        onChange={(v) => setConfig({ prompt: v })}
        placeholder="What should the AI do?"
        hint="Supports {{inputs.x}}, {{vars.y}}, {{nodes.nX.output.z}}."
        multiline
        rows={5}
      />
      <FormField
        fieldKey="system"
        label="System prompt (optional)"
        value={config.system || ''}
        onChange={(v) => setConfig({ system: v })}
        placeholder="Override the agent's default system prompt"
        hint="Rarely needed — leave blank to inherit the agent default."
        multiline
        rows={3}
      />

      <div id="workflow-field-model_override" style={{ marginBottom: 10 }}>
        <div style={styles.label}>Model override</div>
        {availableModels.length > 0 ? (
          <select
            value={config.model_override || ''}
            onChange={(e) =>
              setConfig({ model_override: e.target.value || null })
            }
            style={styles.select as any}
          >
            <option value="">Let the router pick</option>
            {availableModels.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={config.model_override || ''}
            onChange={(e) =>
              setConfig({ model_override: e.target.value || null })
            }
            placeholder="e.g. openai:gpt-4o-mini"
            style={styles.input as any}
          />
        )}
        <div style={styles.hint}>
          Pin a specific model for this block. Leave blank to let the
          router pick.
        </div>
      </div>

      <div id="workflow-field-session_policy" style={{ marginBottom: 10 }}>
        <div style={styles.label}>Session policy</div>
        <div style={styles.chipRow}>
          {(['ephemeral', 'shared'] as Policy[]).map((p) => (
            <button
              key={p}
              onClick={() => setConfig({ session_policy: p })}
              style={{
                ...styles.chip,
                ...(config.session_policy === p
                  ? styles.chipActive
                  : {}),
              } as any}
            >
              {p}
            </button>
          ))}
        </div>
        <div style={styles.hint}>
          <strong>ephemeral</strong> — fresh conversation per block.&nbsp;
          <strong>shared</strong> — all AI blocks in a single run share
          one session (rolling memory).
        </div>
      </div>

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
  input: {
    width: '100%',
    padding: '7px 9px',
    backgroundColor: colors.inputBg,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 12,
    fontFamily: font.mono,
    outline: 'none',
    boxSizing: 'border-box',
  },
  select: {
    width: '100%',
    padding: '7px 9px',
    backgroundColor: colors.inputBg,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 12,
    fontFamily: font.mono,
    outline: 'none',
    boxSizing: 'border-box',
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
  hint: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
    lineHeight: '14px',
  },
};
