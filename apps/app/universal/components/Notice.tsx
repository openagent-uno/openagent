/**
 * Notice — the one inline banner for errors, warnings, and confirmations.
 *
 * The app had no shared way to tell the user something went wrong: failures
 * went to `console.error`, and every screen that needed to say anything grew
 * its own bar with its own colours and spacing. That is how a UI drifts —
 * four almost-identical error bars that look almost-identical, and a fifth
 * screen that silently swallows the error because building a sixth wasn't
 * worth it.
 *
 * Deliberately not a toast. A toast disappears, and most of what this shows
 * is a rejection the user has to act on — a server refusing a model pin, a
 * duplicate budget scope. It sits where the action was until dismissed.
 */

import type { ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, radius } from '../theme';

export type NoticeTone = 'error' | 'warning' | 'success' | 'info';

const TONES: Record<NoticeTone, {
  icon: keyof typeof Feather.glyphMap;
  tint: string;
  bg: string;
  border?: string;
}> = {
  error: { icon: 'alert-triangle', tint: colors.error, bg: colors.errorSoft, border: colors.errorBorder },
  warning: { icon: 'alert-circle', tint: colors.warning, bg: colors.mutedSoft },
  success: { icon: 'check-circle', tint: colors.success, bg: colors.successSoft },
  info: { icon: 'info', tint: colors.accent, bg: colors.accentSoft },
};

interface Props {
  tone?: NoticeTone;
  /** The message. Pass a node when it needs its own markup. */
  children: ReactNode;
  /** When set, renders a dismiss control. Omit for a notice that should
   *  stay until the state behind it changes. */
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

export default function Notice({ tone = 'error', children, onDismiss, style }: Props) {
  const t = TONES[tone];
  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: t.bg },
        t.border ? { borderWidth: 1, borderColor: t.border } : null,
        style,
      ]}
      accessibilityRole="alert"
    >
      <Feather name={t.icon} size={13} color={t.tint} style={styles.icon} />
      {typeof children === 'string' ? (
        // An error tints its text; the calmer tones keep body colour so a
        // long explanation stays readable.
        <Text style={[styles.text, tone === 'error' ? { color: colors.error } : null]}>
          {children}
        </Text>
      ) : (
        <View style={styles.slot}>{children}</View>
      )}
      {onDismiss && (
        <Pressable onPress={onDismiss} hitSlop={8} accessibilityLabel="Dismiss">
          <Feather name="x" size={13} color={colors.textSecondary} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  // Nudge the icon onto the first line's optical centre; `alignItems`
  // is flex-start so a two-line message doesn't centre the icon vertically.
  icon: { marginTop: 1 },
  text: { flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  slot: { flex: 1 },
});
