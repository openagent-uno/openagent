/**
 * Small building blocks shared by the Models grid, the edit dialog and the
 * add wizard: a modal frame, labelled text fields, selectable chips and the
 * supported-inputs chip row.
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import {
  Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius } from '../../theme';
import type { InputModality } from '../../../common/types';
import { MODALITIES } from './modelHelpers';

// ── Modal frame ──────────────────────────────────────────────────────

export function ModalShell({
  visible, title, subtitle, onClose, footer, children, width = 560,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!visible || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, onClose]);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close dialog"
          {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
        />
        <View
          style={[styles.dialog, { width }]}
          {...(Platform.OS === 'web' ? ({ className: 'oa-slide-up' } as any) : {})}
        >
          <View style={styles.head}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
              {subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text> : null}
            </View>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <Feather name="x" size={16} color={colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

// ── Form pieces ──────────────────────────────────────────────────────

export function SectionLabel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text style={styles.sectionLabel}>{children}</Text>
    </View>
  );
}

export function Field({
  label, hint, error, mono = false, ...input
}: TextInputProps & { label: string; hint?: string; error?: string | null; mono?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        autoCorrect={false}
        accessibilityLabel={label}
        {...input}
        style={[styles.input, mono && styles.inputMono, error ? styles.inputError : null, input.style]}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Chip({
  label, active, onPress, disabled, count, icon,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  count?: number;
  icon?: keyof typeof Feather.glyphMap;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      accessibilityLabel={count !== undefined ? `${label}, ${count}` : label}
      style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
      {...(Platform.OS === 'web' && onPress && !disabled ? ({ className: 'oa-press' } as any) : {})}
    >
      {icon ? <Feather name={icon} size={11} color={active ? colors.primary : colors.textSecondary} /> : null}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
      {count !== undefined ? (
        <Text style={[styles.chipCount, active && styles.chipTextActive]}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

/** Supported inputs. Text is always on and cannot be removed. */
export function ModalityChips({
  value, onChange, mode, compact = false,
}: {
  value: readonly InputModality[];
  onChange?: (next: InputModality[]) => void;
  /** Small hint after the chips: who decided this list. */
  mode?: 'auto' | 'manual';
  compact?: boolean;
}) {
  const set = new Set<InputModality>(['text', ...value]);
  const shown = compact ? MODALITIES.filter((m) => set.has(m.key)) : MODALITIES;
  return (
    <View style={styles.chipRow}>
      {shown.map((m) => {
        const on = set.has(m.key);
        const locked = m.key === 'text';
        if (compact) {
          return (
            <View key={m.key} style={styles.miniChip}>
              <Text style={styles.miniChipText}>{m.label}</Text>
            </View>
          );
        }
        return (
          <Chip
            key={m.key}
            label={m.label}
            active={on}
            icon={on ? 'check' : undefined}
            disabled={locked || !onChange}
            onPress={onChange && !locked ? () => {
              const next = new Set(set);
              if (on) next.delete(m.key); else next.add(m.key);
              onChange(MODALITIES.map((x) => x.key).filter((k) => next.has(k)));
            } : undefined}
          />
        );
      })}
      {mode ? <Text style={styles.modeHint}>{mode}</Text> : null}
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'primary' }) {
  return (
    <View style={[styles.badge, tone === 'primary' && styles.badgePrimary]}>
      <Text style={[styles.badgeText, tone === 'primary' && styles.badgeTextPrimary]}>{label}</Text>
    </View>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text style={styles.errorText}>{children}</Text>;
}

export const formStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  muted: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  body: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  mono: { fontSize: 12, color: colors.textSecondary, fontFamily: font.mono },
  success: { fontSize: 12, color: colors.success },
  divider: { height: 1, backgroundColor: colors.borderLight, marginVertical: 4 },
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    backgroundColor: 'rgba(2, 4, 10, 0.62)',
  },
  dialog: {
    maxWidth: '100%',
    maxHeight: '92%',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    // A long form over a dense grid: a solid panel keeps every field legible.
    backgroundColor: colors.panelBgSolid,
    shadowColor: 'rgba(0,0,0,0.18)',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 1,
    shadowRadius: 48,
    overflow: 'hidden',
  } as any,
  head: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12,
  },
  title: {
    color: colors.text, fontFamily: font.display, fontSize: 16,
    fontWeight: '600', letterSpacing: -0.2,
  },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 3, fontFamily: font.mono },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingHorizontal: 20, paddingBottom: 16, gap: 14 },
  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
    paddingHorizontal: 20, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: colors.borderLight,
  },

  sectionLabel: {
    fontSize: 11, fontWeight: '600', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  field: { gap: 5 },
  label: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  input: {
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 9,
    color: colors.text, fontSize: 13, fontFamily: font.sans,
  },
  inputMono: { fontFamily: font.mono },
  inputError: { borderColor: colors.error },
  hint: { fontSize: 11, color: colors.textMuted, lineHeight: 15 },
  errorText: { fontSize: 12, color: colors.error, lineHeight: 17 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg,
  },
  chipActive: { backgroundColor: colors.primarySoft, borderColor: colors.borderStrong },
  chipDisabled: { opacity: 0.6 },
  chipText: { fontSize: 12, color: colors.textSecondary },
  chipTextActive: { color: colors.primary, fontWeight: '600' },
  chipCount: { fontSize: 11, color: colors.textMuted, fontFamily: font.mono },

  miniChip: {
    paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: radius.sm,
    backgroundColor: colors.mutedSoft,
  },
  miniChipText: { fontSize: 10.5, color: colors.textSecondary },
  modeHint: { fontSize: 10.5, color: colors.textMuted, fontStyle: 'italic', marginLeft: 2 },

  badge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm,
    backgroundColor: colors.sidebar, borderWidth: 1, borderColor: colors.borderLight,
  },
  badgePrimary: { backgroundColor: colors.primarySoft, borderColor: 'transparent' },
  badgeText: { fontSize: 10, color: colors.textSecondary, letterSpacing: 0.2 },
  badgeTextPrimary: { color: colors.primary, fontWeight: '600' },
});
