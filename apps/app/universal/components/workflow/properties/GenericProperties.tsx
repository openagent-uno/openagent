/**
 * GenericProperties — fallback editor for block types that don't (yet)
 * have a purpose-built properties component. Renders a FormField per
 * config_schema entry using the type hints from BLOCK_CATALOG. Covers
 * set-variable, if, loop, wait, parallel, merge, http-request,
 * trigger-schedule, trigger-ai out of the box.
 */

import type {
  BlockTypeFieldSpec,
  BlockTypeSpec,
  WorkflowNode,
} from '../../../../common/types';
import { colors, font, radius } from '../../../theme';
import FormField from './FormField';

interface Props {
  node: WorkflowNode;
  spec?: BlockTypeSpec;
  onChange: (patch: Partial<WorkflowNode>) => void;
}

export default function GenericProperties({ node, spec, onChange }: Props) {
  const config = (node.config || {}) as Record<string, any>;

  const setConfig = (patch: Record<string, unknown>) => {
    onChange({ config: { ...config, ...patch } });
  };

  if (!spec) {
    return (
      <div style={styles.empty}>
        No schema for block type <code>{node.type}</code> — reload the
        page to re-fetch the block-type catalog.
      </div>
    );
  }

  const entries = Object.entries(spec.config_schema || {}) as Array<
    [string, BlockTypeFieldSpec]
  >;

  return (
    <div>
      <div style={styles.description}>{spec.description}</div>
      {entries.map(([key, field]) => (
        <Field
          key={key}
          name={key}
          field={field}
          value={config[key]}
          onChange={(v) => setConfig({ [key]: v })}
        />
      ))}
    </div>
  );
}

function Field({
  name,
  field,
  value,
  onChange,
}: {
  name: string;
  field: BlockTypeFieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = formatLabel(name) + (field.required ? ' *' : '');
  const hint = field.description;

  if (field.enum && field.enum.length > 0) {
    const current = (value as string) ?? (field.default as string) ?? '';
    return (
      <div id={`workflow-field-${encodeURIComponent(name)}`} style={{ marginBottom: 10 }}>
        <div style={styles.label}>{label}</div>
        <div style={styles.chipRow}>
          {field.enum.map((opt) => (
            <button
              key={String(opt)}
              onClick={() => onChange(opt)}
              style={{
                ...styles.chip,
                ...(current === opt ? styles.chipActive : {}),
              } as any}
            >
              {String(opt)}
            </button>
          ))}
        </div>
        {hint && <div style={styles.hint}>{hint}</div>}
      </div>
    );
  }

  if (field.type === 'object' || field.type === 'array') {
    const text =
      value === undefined || value === null
        ? ''
        : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
    return (
      <FormField
        fieldKey={name}
        label={label}
        value={text}
        onChange={(v) => {
          try {
            onChange(v.trim() ? JSON.parse(v) : null);
          } catch {
            onChange(v); // keep raw so user can keep typing
          }
        }}
        placeholder={field.type === 'array' ? '[]' : '{}'}
        hint={hint}
        multiline
        monospaced
        rows={5}
      />
    );
  }

  if (field.type === 'boolean') {
    const v = Boolean(value);
    return (
      <div id={`workflow-field-${encodeURIComponent(name)}`} style={{ marginBottom: 10 }}>
        <div style={styles.label}>{label}</div>
        <button
          onClick={() => onChange(!v)}
          style={{
            ...styles.chip,
            ...(v ? styles.chipActive : {}),
            minWidth: 60,
          } as any}
        >
          {v ? 'on' : 'off'}
        </button>
        {hint && <div style={styles.hint}>{hint}</div>}
      </div>
    );
  }

  const isNumeric = field.type === 'integer' || field.type === 'number';
  return (
    <FormField
      fieldKey={name}
      label={label}
      value={value == null ? '' : String(value)}
      onChange={(v) => {
        if (isNumeric) {
          const n = v === '' ? null : Number(v);
          onChange(Number.isFinite(n as number) ? n : v);
        } else {
          onChange(v);
        }
      }}
      placeholder={field.default != null ? String(field.default) : undefined}
      hint={hint}
      multiline={field.type === 'string' && (field.description?.length || 0) > 60}
      monospaced={isNumeric || name.toLowerCase().includes('expr') || name.toLowerCase().includes('cron')}
      type={isNumeric ? 'number' : 'text'}
      rows={3}
    />
  );
}

function formatLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const styles: Record<string, any> = {
  description: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: '16px',
    marginBottom: 10,
    fontFamily: font.sans,
  },
  label: {
    fontSize: 10,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
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
  empty: {
    fontSize: 11,
    color: colors.textMuted,
    padding: 10,
    background: colors.primarySoft,
    border: `1px dashed ${colors.border}`,
    borderRadius: radius.md,
  },
};
