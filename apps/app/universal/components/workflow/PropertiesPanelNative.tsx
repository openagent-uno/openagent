/**
 * PropertiesPanelNative — full-screen modal editor for the selected
 * block. Renders label + one TextInput per config field in the
 * block's BLOCK_CATALOG schema.
 *
 * Parity with the web dispatcher is deliberately narrower here —
 * touch users pick block types from a bottom sheet and tweak the
 * essentials; power editing (template autocomplete, JSON schema
 * form builder, tool picker) stays on web/desktop. Cron picker is
 * the exception: it's cross-platform-ready so we reuse the same
 * component for trigger-schedule blocks.
 */

import { useMemo } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius } from '../../theme';
import CronPicker from '../CronPicker';
import type {
  BlockTypeFieldSpec,
  BlockTypeSpec,
  WorkflowNode,
} from '../../../common/types';

interface Props {
  node: WorkflowNode | null;
  blockTypes: BlockTypeSpec[];
  initialField?: string;
  onChange: (nodeId: string, patch: Partial<WorkflowNode>) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
}

export default function PropertiesPanelNative({
  node,
  blockTypes,
  initialField,
  onChange,
  onDelete,
  onClose,
}: Props) {
  const spec = useMemo(
    () => blockTypes.find((b) => b.type === node?.type),
    [blockTypes, node?.type],
  );

  if (!node) return null;

  const focusedField = initialField?.split('.').pop();

  const config = (node.config || {}) as Record<string, any>;
  const setConfig = (patch: Record<string, unknown>) => {
    onChange(node.id, { config: { ...config, ...patch } });
  };
  const setLabel = (label: string) => {
    onChange(node.id, { label });
  };

  return (
    <Modal
      visible={!!node}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheet}
      >
        <View style={styles.grabber} />
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerType}>
              {spec?.type || node.type}
            </Text>
            <Text style={styles.headerId}>{node.id}</Text>
          </View>
          <TouchableOpacity
            onPress={() => {
              onDelete(node.id);
              onClose();
            }}
            style={styles.deleteBtn}
          >
            <Feather name="trash-2" size={14} color={colors.error} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
          <NativeFormField
            focused={focusedField === 'label'}
            label="Label"
            value={node.label || ''}
            onChange={setLabel}
            placeholder={spec?.type || node.type}
            hint="Shown on the node on the canvas."
          />
          {spec ? (
            <Text style={styles.sectionDescription}>{spec.description}</Text>
          ) : null}

          {/* Special-case cron picker for trigger-schedule */}
          {node.type === 'trigger-schedule' && (
            <CronPicker
              label="Cron expression"
              value={(config.cron_expression as string) || ''}
              onChange={(v) => setConfig({ cron_expression: v })}
            />
          )}

          {/* Schema-driven generic fields for everything else */}
          {spec &&
            Object.entries(spec.config_schema).map(([key, field]) => {
              if (node.type === 'trigger-schedule' && key === 'cron_expression') {
                return null; // handled by CronPicker above
              }
              return (
                <GenericFieldNative
                  key={key}
                  name={key}
                  field={field}
                  value={config[key]}
                  focused={focusedField === key}
                  onChange={(v) => setConfig({ [key]: v })}
                />
              );
            })}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function GenericFieldNative({
  name,
  field,
  value,
  focused,
  onChange,
}: {
  name: string;
  field: BlockTypeFieldSpec;
  value: unknown;
  focused?: boolean;
  onChange: (v: unknown) => void;
}) {
  const label =
    name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) +
    (field.required ? ' *' : '');

  // Enum → chip row
  if (field.enum && field.enum.length > 0) {
    const current = (value as unknown) ?? (field.default as unknown) ?? '';
    return (
      <View style={{ marginBottom: 12 }}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.chipRow}>
          {field.enum.map((opt) => (
            <TouchableOpacity
              key={String(opt)}
              onPress={() => onChange(opt)}
              style={[
                styles.chip,
                current === opt && styles.chipActive,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  current === opt && styles.chipTextActive,
                ]}
              >
                {String(opt)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {field.description ? (
          <Text style={styles.hint}>{field.description}</Text>
        ) : null}
      </View>
    );
  }

  // Object / array → JSON textarea
  if (field.type === 'object' || field.type === 'array') {
    const text =
      value == null
        ? ''
        : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
    return (
      <NativeFormField
        focused={focused}
        label={label}
        value={text}
        onChange={(v) => {
          try {
            onChange(v.trim() ? JSON.parse(v) : null);
          } catch {
            onChange(v); // keep the string so user can finish typing
          }
        }}
        placeholder={field.type === 'array' ? '[]' : '{}'}
        hint={field.description}
        multiline
        monospaced
      />
    );
  }

  if (field.type === 'boolean') {
    const v = Boolean(value);
    return (
      <View style={{ marginBottom: 12 }}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <TouchableOpacity
          onPress={() => onChange(!v)}
          style={[
            styles.chip,
            v && styles.chipActive,
            { alignSelf: 'flex-start', minWidth: 70 },
          ]}
        >
          <Text
            style={[styles.chipText, v && styles.chipTextActive]}
          >
            {v ? 'on' : 'off'}
          </Text>
        </TouchableOpacity>
        {field.description ? (
          <Text style={styles.hint}>{field.description}</Text>
        ) : null}
      </View>
    );
  }

  // string / number / integer → TextInput
  const isNumeric = field.type === 'integer' || field.type === 'number';
  const isMonospaced =
    isNumeric ||
    name.toLowerCase().includes('expr') ||
    name.toLowerCase().includes('cron') ||
    name.toLowerCase().includes('url');

  return (
    <NativeFormField
      focused={focused}
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
      hint={field.description}
      keyboardType={isNumeric ? 'numeric' : undefined}
      multiline={
        field.type === 'string' && (field.description?.length || 0) > 60
      }
      monospaced={isMonospaced}
    />
  );
}

function NativeFormField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  monospaced,
  keyboardType,
  focused,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  monospaced?: boolean;
  keyboardType?: 'numeric';
  focused?: boolean;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        autoFocus={focused}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCorrect={false}
        autoCapitalize="none"
        textAlignVertical={multiline ? 'top' : undefined}
        style={[
          styles.input,
          multiline && { minHeight: 90 },
          monospaced && { fontFamily: font.mono },
        ]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(26, 25, 21, 0.25)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '90%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 20,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginTop: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    paddingBottom: 10,
    gap: 6,
  },
  headerType: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerId: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: font.mono,
    marginTop: 1,
  },
  deleteBtn: { padding: 5 },
  closeBtn: { padding: 5 },
  scroll: {
    paddingHorizontal: 14,
  },
  sectionDescription: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 11,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 12,
  },
  hint: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 4,
    lineHeight: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted,
  },
  chipTextActive: { color: colors.primary },
});
