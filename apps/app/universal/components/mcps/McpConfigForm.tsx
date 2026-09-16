/**
 * McpConfigForm — shared create / edit form for an MCP row.
 *
 * The same fields drive three things:
 *   - POST /api/mcps              (new custom — mode="new")
 *   - PUT  /api/mcps/{name}       (edit any row — mode="edit")
 *   - Preview of what will hit the ``mcps`` SQLite table
 *
 * Locking rules:
 *   - ``new``  : name is editable, transport editable, everything editable
 *   - ``edit``, custom row  : name locked (PK), everything else editable
 *   - ``edit``, builtin row : name / transport / command / url all locked;
 *                              only enabled + env + headers are editable
 *                              (those are what builtins exist to configure)
 *
 * Env and headers are rendered as dynamic key/value lists with add + remove
 * row controls. OAuth applies to remote transports only. The form submits
 * a typed payload the caller passes to either createMcp or updateMcp.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { MCPEntry } from '../../../common/types';
import { colors, font, radius, tracking } from '../../theme';
import Button from '../Button';
import ThemedSwitch from '../ThemedSwitch';

export type TransportKind = 'stdio' | 'remote';

export interface McpSubmitPayload {
  name: string;
  command: string[] | null;
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  oauth: boolean;
  enabled: boolean;
}

interface Props {
  mode: 'new' | 'edit';
  initial?: MCPEntry;
  onSubmit: (payload: McpSubmitPayload) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
  submittingLabel?: string;
  /** Server-provided error message to surface above the action row. */
  serverError?: string | null;
}

type Row = { id: string; key: string; value: string };

let _rowSeq = 0;
const newRow = (key = '', value = ''): Row => ({
  id: `r${++_rowSeq}`, key, value,
});

function rowsFromDict(dict: Record<string, string> | null | undefined): Row[] {
  if (!dict) return [];
  return Object.entries(dict).map(([k, v]) => newRow(k, String(v)));
}

function rowsToDict(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
}

function argvToString(command: string[] | null | undefined, args: string[] | null | undefined): string {
  const parts = [...(command || []), ...(args || [])];
  // Preserve existing whitespace in individual tokens by quoting them if they
  // contain spaces. Most real argv entries don't — ``npx -y foo@1.0.0`` joins
  // cleanly — but a ``docker run --label="some value"`` shouldn't get
  // mangled.
  return parts
    .map((tok) => (/\s/.test(tok) ? JSON.stringify(tok) : tok))
    .join(' ');
}

function stringToArgv(raw: string): string[] {
  // Simple tokenizer that understands single/double quoted strings but
  // doesn't do backslash escapes. Sufficient for 99% of MCP commands.
  const out: string[] = [];
  const s = raw.trim();
  if (!s) return out;
  let i = 0;
  let cur = '';
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (/\s/.test(ch)) {
      if (cur.length) { out.push(cur); cur = ''; }
      i++; continue;
    }
    cur += ch; i++;
  }
  if (cur.length) out.push(cur);
  return out;
}

export default function McpConfigForm({
  mode, initial, onSubmit, onCancel,
  submitLabel, submittingLabel, serverError,
}: Props) {
  const isBuiltin = !!initial && initial.kind !== 'custom';

  // Locking matrix for the current mode + row-kind combo.
  const locks = useMemo(() => ({
    name: mode === 'edit', // PK is immutable after create
    kind: true,            // we never change kind via this form
    transport: mode === 'edit' && isBuiltin,
    command: mode === 'edit' && isBuiltin,
    url: mode === 'edit' && isBuiltin,
    // Env + headers are editable in all three cases — builtins exist to
    // carry tokens like TELEGRAM_BOT_TOKEN, so disabling this would
    // defeat the whole point of the "edit builtin" flow.
    env: false,
    headers: false,
    oauth: mode === 'edit' && isBuiltin,
    enabled: false,
  }), [mode, isBuiltin]);

  // ── State ──
  const [name, setName] = useState(initial?.name || '');
  const [transport, setTransport] = useState<TransportKind>(
    initial?.url ? 'remote' : 'stdio',
  );
  const [command, setCommand] = useState(
    argvToString(initial?.command, initial?.args),
  );
  const [url, setUrl] = useState(initial?.url || '');
  const [envRows, setEnvRows] = useState<Row[]>(
    rowsFromDict(initial?.env || {}),
  );
  const [headerRows, setHeaderRows] = useState<Row[]>(
    rowsFromDict(initial?.headers || {}),
  );
  const [oauth, setOauth] = useState(!!initial?.oauth);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // ── Derived ──
  const commandPreview = useMemo(() => stringToArgv(command), [command]);
  const isStdio = transport === 'stdio';

  // ── Handlers ──
  const updateRow = useCallback(
    (which: 'env' | 'headers', id: string, patch: Partial<Row>) => {
      const setter = which === 'env' ? setEnvRows : setHeaderRows;
      setter((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [],
  );
  const addRow = useCallback(
    (which: 'env' | 'headers') => {
      const setter = which === 'env' ? setEnvRows : setHeaderRows;
      setter((prev) => [...prev, newRow()]);
    },
    [],
  );
  const removeRow = useCallback(
    (which: 'env' | 'headers', id: string) => {
      const setter = which === 'env' ? setEnvRows : setHeaderRows;
      setter((prev) => prev.filter((r) => r.id !== id));
    },
    [],
  );

  const handleSubmit = async () => {
    setLocalError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError('Name is required.');
      return;
    }
    if (isStdio && commandPreview.length === 0 && !locks.command) {
      setLocalError('Command is required for stdio MCPs.');
      return;
    }
    if (!isStdio && !url.trim() && !locks.url) {
      setLocalError('URL is required for remote MCPs.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: trimmedName,
        command: isStdio ? (commandPreview.length ? commandPreview : null) : null,
        url: isStdio ? null : (url.trim() || null),
        env: rowsToDict(envRows),
        headers: rowsToDict(headerRows),
        oauth: isStdio ? false : oauth,
        enabled,
      });
    } catch (e: any) {
      setLocalError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // If the initial entry's kind changes (e.g. hot reload), sync fields.
  useEffect(() => {
    if (!initial) return;
    setName(initial.name);
    setTransport(initial.url ? 'remote' : 'stdio');
    setCommand(argvToString(initial.command, initial.args));
    setUrl(initial.url || '');
    setEnvRows(rowsFromDict(initial.env || {}));
    setHeaderRows(rowsFromDict(initial.headers || {}));
    setOauth(!!initial.oauth);
    setEnabled(initial.enabled ?? true);
  }, [initial]);

  const compositeError = localError || serverError || null;

  return (
    <View style={{ gap: 22 }}>
      {/* Identity */}
      <Section label="Identity">
        <LabeledField label="Name" hint={locks.name ? 'Primary key — read-only after create.' : 'Used as the key in your mcps table. Use a short, unique slug.'}>
          <TextInput
            style={[styles.input, locks.name && styles.inputLocked]}
            editable={!locks.name}
            value={name}
            onChangeText={setName}
            placeholder="e.g. github"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </LabeledField>

        <View style={styles.inlineRow}>
          {initial && (
            <View style={styles.inlineKind}>
              <Text style={styles.inlineKindLabel}>Kind</Text>
              <View style={styles.kindBadge}>
                <Text style={styles.kindBadgeText}>{initial.kind}</Text>
              </View>
              {initial.builtin_name && (
                <Text style={styles.inlineKindMeta}>
                  builtin · <Text style={{ fontFamily: font.mono }}>{initial.builtin_name}</Text>
                </Text>
              )}
            </View>
          )}
          <View style={{ flex: 1 }} />
          <View style={styles.inlineToggle}>
            <Text style={styles.inlineToggleLabel}>Enabled</Text>
            <ThemedSwitch value={enabled} onValueChange={setEnabled} />
          </View>
        </View>
      </Section>

      {/* Transport */}
      <Section label="Transport" description={locks.transport ? 'Locked for builtin MCPs — their runtime is defined in code.' : undefined}>
        <View style={styles.segRow}>
          <Segment
            icon="terminal"
            label="Local stdio"
            active={isStdio}
            locked={locks.transport}
            onPress={() => !locks.transport && setTransport('stdio')}
          />
          <Segment
            icon="cloud"
            label="Remote HTTP / SSE"
            active={!isStdio}
            locked={locks.transport}
            onPress={() => !locks.transport && setTransport('remote')}
          />
        </View>

        {isStdio ? (
          <LabeledField
            label="Command"
            hint="Full argv — e.g. `npx -y @example/mcp` or `docker run -i --rm image:tag`. We tokenize on whitespace; quote tokens that contain spaces."
          >
            <TextInput
              style={[styles.input, styles.inputMono, locks.command && styles.inputLocked]}
              editable={!locks.command}
              value={command}
              onChangeText={setCommand}
              placeholder="npx -y @modelcontextprotocol/server-memory"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            {commandPreview.length > 0 && !locks.command && (
              <View style={styles.argvPreview}>
                {commandPreview.map((tok, i) => (
                  <View key={i} style={styles.argvChip}>
                    <Text style={styles.argvChipText}>{tok}</Text>
                  </View>
                ))}
              </View>
            )}
          </LabeledField>
        ) : (
          <>
            <LabeledField label="URL" hint="Streamable-HTTP or SSE endpoint exposed by the remote server.">
              <TextInput
                style={[styles.input, styles.inputMono, locks.url && styles.inputLocked]}
                editable={!locks.url}
                value={url}
                onChangeText={setUrl}
                placeholder="https://mcp.example.com/endpoint"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </LabeledField>
            <View style={styles.inlineRow}>
              <View style={styles.inlineToggle}>
                <Text style={styles.inlineToggleLabel}>OAuth</Text>
                <ThemedSwitch
                  value={oauth}
                  onValueChange={locks.oauth ? () => {} : setOauth}
                />
              </View>
              <Text style={styles.inlineHint}>
                {locks.oauth
                  ? 'Locked for builtin MCPs.'
                  : 'Enable if the server negotiates auth via OAuth rather than a static header.'}
              </Text>
            </View>
          </>
        )}
      </Section>

      {/* Env vars */}
      <KvSection
        label="Environment variables"
        description="Passed to the subprocess at launch (stdio) or ignored (remote). Put API keys and tokens here."
        rows={envRows}
        keyPlaceholder="API_KEY"
        valuePlaceholder="value"
        onAdd={() => addRow('env')}
        onRemove={(id) => removeRow('env', id)}
        onChange={(id, patch) => updateRow('env', id, patch)}
      />

      {/* Headers (only meaningful for remote) */}
      <KvSection
        label="HTTP headers"
        description={isStdio
          ? "Unused for stdio — the subprocess doesn't receive HTTP headers."
          : 'Sent with every request to the remote server.'}
        rows={headerRows}
        keyPlaceholder="Authorization"
        valuePlaceholder="Bearer sk-..."
        onAdd={() => addRow('headers')}
        onRemove={(id) => removeRow('headers', id)}
        onChange={(id, patch) => updateRow('headers', id, patch)}
        dim={isStdio}
      />

      {/* Source line (edit only) */}
      {initial?.source && (
        <View style={styles.sourceLine}>
          <Text style={styles.sourceLabel}>Source</Text>
          <Text style={styles.sourceValue}>{initial.source}</Text>
        </View>
      )}

      {/* Action row */}
      {compositeError && (
        <View style={styles.errorBanner}>
          <Feather name="alert-triangle" size={13} color={colors.error} />
          <Text style={styles.errorBannerText}>{compositeError}</Text>
        </View>
      )}
      <View style={styles.footer}>
        <Button variant="ghost" size="md" label="Cancel" onPress={onCancel} disabled={submitting} />
        <Button
          variant="primary"
          size="md"
          label={submitting ? (submittingLabel || 'Saving…') : submitLabel}
          icon={submitting ? undefined : (mode === 'new' ? 'plus' : 'check')}
          iconPosition="right"
          onPress={handleSubmit}
          disabled={submitting}
        />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function Section({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {description && <Text style={styles.sectionDesc}>{description}</Text>}
      <View style={{ marginTop: 10, gap: 12 }}>{children}</View>
    </View>
  );
}

function LabeledField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function Segment({
  icon, label, active, locked, onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  active: boolean;
  locked: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={locked ? 1 : 0.75}
      style={[
        styles.segment,
        active && styles.segmentActive,
        locked && styles.segmentLocked,
      ]}
    >
      <Feather
        name={icon}
        size={13}
        color={active ? colors.primary : (locked ? colors.textMuted : colors.textSecondary)}
      />
      <Text
        style={[
          styles.segmentLabel,
          active && styles.segmentLabelActive,
          locked && styles.segmentLabelLocked,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function KvSection({
  label, description, rows, keyPlaceholder, valuePlaceholder,
  onAdd, onRemove, onChange, dim,
}: {
  label: string;
  description?: string;
  rows: Row[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChange: (id: string, patch: Partial<Row>) => void;
  dim?: boolean;
}) {
  return (
    <View style={[styles.section, dim && styles.sectionDim]}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {description && <Text style={styles.sectionDesc}>{description}</Text>}
      <View style={{ marginTop: 10, gap: 6 }}>
        {rows.length === 0 && (
          <Text style={styles.kvEmpty}>No {label.toLowerCase()} defined.</Text>
        )}
        {rows.map((row) => (
          <View key={row.id} style={styles.kvRow}>
            <TextInput
              style={[styles.input, styles.inputMono, styles.kvKey]}
              value={row.key}
              onChangeText={(v) => onChange(row.id, { key: v })}
              placeholder={keyPlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.kvEquals}>=</Text>
            <TextInput
              style={[styles.input, styles.inputMono, styles.kvValue]}
              value={row.value}
              onChangeText={(v) => onChange(row.id, { value: v })}
              placeholder={valuePlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={() => onRemove(row.id)} hitSlop={8} style={styles.kvRemove}>
              <Feather name="x" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity onPress={onAdd} style={styles.kvAdd}>
          <Feather name="plus" size={12} color={colors.primary} />
          <Text style={styles.kvAddText}>Add {label.toLowerCase().replace('s$', '').replace(/s$/, '')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  section: {},
  sectionDim: { opacity: 0.72 },
  sectionLabel: {
    fontSize: 10, fontWeight: '700', color: colors.textMuted,
    letterSpacing: tracking.wider, textTransform: 'uppercase',
    marginBottom: 2,
  },
  sectionDesc: {
    fontSize: 12, color: colors.textMuted, lineHeight: 17,
  },

  fieldLabel: {
    fontSize: 12.5, fontWeight: '600', color: colors.text,
    fontFamily: font.display, marginBottom: 2,
  },
  fieldHint: {
    fontSize: 11, color: colors.textMuted, lineHeight: 16,
    marginBottom: 6,
  },

  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 9,
    color: colors.text, fontSize: 13, fontFamily: font.sans,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
  },
  inputMono: { fontFamily: font.mono, fontSize: 12.5 },
  inputLocked: {
    backgroundColor: colors.sidebar,
    color: colors.textSecondary,
  },

  inlineRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    flexWrap: 'wrap',
  },
  inlineKind: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inlineKindLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '500' },
  inlineKindMeta: { fontSize: 10.5, color: colors.textMuted, marginLeft: 2 },
  kindBadge: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.sidebar,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  kindBadgeText: {
    fontSize: 10, color: colors.textSecondary, fontFamily: font.mono,
    fontWeight: '600',
  },
  inlineToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineToggleLabel: { fontSize: 11.5, color: colors.text, fontWeight: '500' },
  inlineHint: { flexShrink: 1, fontSize: 11, color: colors.textMuted, lineHeight: 15 },

  segRow: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  segment: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 11, paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmentActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  segmentLocked: { opacity: 0.55 },
  segmentLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  segmentLabelActive: { color: colors.primary, fontWeight: '600' },
  segmentLabelLocked: { color: colors.textMuted },

  argvPreview: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    marginTop: 8,
  },
  argvChip: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.sidebar,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  argvChipText: {
    fontSize: 10.5, color: colors.textSecondary, fontFamily: font.mono,
  },

  kvRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  kvKey: { flex: 1, minWidth: 120 },
  kvValue: { flex: 2, minWidth: 180 },
  kvEquals: { fontSize: 13, color: colors.textMuted, fontFamily: font.mono },
  kvRemove: { padding: 6 },
  kvAdd: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    alignSelf: 'flex-start', marginTop: 4,
    paddingHorizontal: 8, paddingVertical: 5,
  },
  kvAddText: {
    fontSize: 11.5, color: colors.primary, fontWeight: '600',
  },
  kvEmpty: {
    fontSize: 11.5, color: colors.textMuted,
    fontStyle: 'italic',
  },

  sourceLine: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
  sourceLabel: {
    fontSize: 10, fontWeight: '700',
    color: colors.textMuted, letterSpacing: tracking.wider,
    textTransform: 'uppercase',
  },
  sourceValue: {
    flex: 1,
    fontSize: 11, color: colors.textMuted, fontFamily: font.mono,
  },

  errorBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorBannerText: { flex: 1, fontSize: 12, color: colors.error, lineHeight: 17 },

  footer: {
    flexDirection: 'row', justifyContent: 'flex-end', gap: 8,
    paddingTop: 8,
    borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
});
