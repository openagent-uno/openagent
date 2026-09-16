/**
 * FormField — small labeled input used by every per-type properties
 * editor. Supports single-line text, multi-line, number, and a hint
 * describing templating support. No magic — just consistent styling
 * so the right-rail doesn't reinvent itself per block type.
 */

import { colors, font, radius } from '../../../theme';

interface Props {
  fieldKey?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  monospaced?: boolean;
  type?: 'text' | 'number';
  rows?: number;
}

export default function FormField({
  fieldKey,
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline = false,
  monospaced = false,
  type = 'text',
  rows = 3,
}: Props) {
  const commonInputStyle = {
    width: '100%',
    padding: '7px 9px',
    backgroundColor: colors.inputBg,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 12,
    fontFamily: monospaced ? font.mono : font.sans,
    outline: 'none',
    boxSizing: 'border-box',
  } as const;

  return (
    <div
      id={fieldKey ? `workflow-field-${encodeURIComponent(fieldKey)}` : undefined}
      style={{ marginBottom: 10 }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {multiline ? (
        <textarea
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...commonInputStyle, resize: 'vertical' } as any}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={commonInputStyle as any}
        />
      )}
      {hint && (
        <div
          style={{
            fontSize: 10,
            color: colors.textMuted,
            marginTop: 4,
            lineHeight: '14px',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
