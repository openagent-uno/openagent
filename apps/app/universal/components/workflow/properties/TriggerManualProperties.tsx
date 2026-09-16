/**
 * Trigger Manual properties editor.
 *
 * The config here is the ``inputs_schema`` object — describes what
 * form the Run dialog shows. We expose it as a raw JSON textarea
 * plus a simple key-based helper row for the common case. Same
 * round-trip shape the AI's ``describe_block_type`` expects.
 */

import { useMemo } from 'react';
import type { WorkflowNode } from '../../../../common/types';
import { colors, font, radius } from '../../../theme';
import FormField from './FormField';

interface Props {
  node: WorkflowNode;
  onChange: (patch: Partial<WorkflowNode>) => void;
}

export default function TriggerManualProperties({ node, onChange }: Props) {
  const config = (node.config || {}) as Record<string, any>;

  const schemaText = useMemo(() => {
    try {
      return JSON.stringify(config.inputs_schema ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [config.inputs_schema]);

  const onSchemaChange = (text: string) => {
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      onChange({ config: { ...config, inputs_schema: parsed } });
    } catch {
      // Keep the raw text so the user can keep typing.
      onChange({ config: { ...config, inputs_schema: {}, _schema_raw: text } });
    }
  };

  return (
    <div>
      <div style={styles.explainer}>
        This block fires when the user clicks <strong>Run</strong> or
        calls <code>POST /api/workflows/&#123;id&#125;/run</code>. The
        inputs schema below drives the Run dialog — each key becomes a
        form field, reachable downstream as
        <code> &#123;&#123;inputs.&lt;key&gt;&#125;&#125;</code>.
      </div>
      <FormField
        fieldKey="inputs_schema"
        label="Inputs schema (JSON)"
        value={schemaText}
        onChange={onSchemaChange}
        placeholder='{ "message": {"type": "string", "required": true} }'
        hint="Keys become form fields in the Run dialog."
        multiline
        monospaced
        rows={8}
      />
    </div>
  );
}

const styles: Record<string, any> = {
  explainer: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: '16px',
    padding: 10,
    background: colors.primarySoft,
    borderRadius: radius.md,
    marginBottom: 10,
    fontFamily: font.sans,
  },
};
