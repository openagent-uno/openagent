/**
 * EventTile — grid card for a webhook event.
 *
 * Mirrors ``TaskTile`` exactly (same rail, head row + switch, body, badge row,
 * meta line, footer) so the Events dashboard reads as the same grid as
 * Scheduled and Workflows. The whole tile is pressable and opens the editor.
 */

import { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { AgentEvent } from '../../../common/types';
import { colors, font, radius } from '../../theme';
import ThemedSwitch from '../ThemedSwitch';

const ACTION_LABEL: Record<AgentEvent['action_kind'], string> = {
  workflow: 'runs a workflow',
  scheduled_task: 'fires a scheduled task',
  prompt: 'opens an event run session',
};
const ACTION_ICON: Record<AgentEvent['action_kind'], keyof typeof Feather.glyphMap> = {
  workflow: 'git-branch',
  scheduled_task: 'clock',
  prompt: 'message-circle',
};

interface Props {
  event: AgentEvent;
  onToggle: (value: boolean) => void;
  onEdit: () => void;
  onHistory: () => void;
  onRemove: () => void;
  /** Fire the event now with a sample payload (the Test delivery). */
  onTest: () => Promise<boolean> | void;
}

export default function EventTile({
  event, onToggle, onEdit, onHistory, onRemove, onTest,
}: Props) {
  const [busy, setBusy] = useState(false);

  const handleTest = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onTest();
    } finally {
      setBusy(false);
    }
  };

  const summary =
    event.description
    || (event.action_kind === 'prompt' ? event.prompt_template : null)
    || `When called, ${ACTION_LABEL[event.action_kind]}.`;

  const lastIso = event.last_triggered_at
    ? new Date(
        event.last_triggered_at < 1e12
          ? event.last_triggered_at * 1000
          : event.last_triggered_at,
      ).toLocaleString()
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onEdit}
      style={[styles.tile, !event.enabled && styles.tileDisabled]}
      accessibilityRole="button"
      accessibilityLabel={`Open event ${event.name}`}
      // @ts-ignore web-only subtle lift
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
    >
      <View style={[styles.rail, event.enabled ? styles.railOn : styles.railOff]} />

      <View style={styles.body}>
        <View style={styles.headRow}>
          <Text style={styles.name} numberOfLines={1}>{event.name}</Text>
          <ThemedSwitch value={event.enabled} onValueChange={onToggle} />
        </View>

        <Text style={styles.prompt} numberOfLines={2}>{summary}</Text>

        <View style={styles.badgesRow}>
          <View style={styles.badge}>
            <Feather name="link" size={10} color={colors.primary} />
            <Text style={styles.badgeText} numberOfLines={1}>{event.type}</Text>
          </View>
          <View style={styles.badge}>
            <Feather name={ACTION_ICON[event.action_kind]} size={10} color={colors.primary} />
            <Text style={styles.badgeText} numberOfLines={1}>
              {event.action_kind === 'scheduled_task' ? 'task' : event.action_kind}
            </Text>
          </View>
          {event.session_binding_enabled ? (
            <View style={styles.badge}>
              <Feather name="hash" size={10} color={colors.primary} />
              <Text style={styles.badgeText} numberOfLines={1}>
                {event.session_binding_path || 'bound'}
              </Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.meta} numberOfLines={1}>
          {lastIso ? `last · ${lastIso}` : event.webhook_path}
        </Text>

        <View style={styles.footRow}>
          <TouchableOpacity onPress={onRemove} style={styles.remove} hitSlop={8} accessibilityRole="button">
            <Feather name="trash-2" size={12} color={colors.textMuted} />
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
          <View style={styles.footRight}>
            <TouchableOpacity
              onPress={handleTest}
              disabled={busy}
              style={styles.runBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Send a test delivery to ${event.name}`}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Feather name="play" size={12} color={colors.primary} />
              )}
              <Text style={styles.runText}>{busy ? 'Sending…' : 'Test'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onHistory}
              style={styles.historyBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Delivery history for ${event.name}`}
            >
              <Feather name="clock" size={12} color={colors.textMuted} />
              <Text style={styles.historyText}>History</Text>
            </TouchableOpacity>
            <View style={styles.editHint}>
              <Text style={styles.editHintText}>Edit</Text>
              <Feather name="chevron-right" size={12} color={colors.textMuted} />
            </View>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    minHeight: 138,
  },
  tileDisabled: { opacity: 0.72 },
  rail: { width: 3 },
  railOn: { backgroundColor: colors.primary },
  railOff: { backgroundColor: colors.borderStrong },
  body: { flex: 1, padding: 14, gap: 8 },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  name: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.2,
  },
  prompt: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: 'transparent',
    maxWidth: '100%',
  },
  badgeText: {
    fontSize: 9.5,
    color: colors.primary,
    fontFamily: font.mono,
    letterSpacing: 0.3,
  },
  meta: { fontSize: 10.5, color: colors.textMuted, fontFamily: font.mono },
  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 'auto',
  },
  footRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3 },
  removeText: { fontSize: 10.5, color: colors.textMuted, fontWeight: '500' },
  runBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3 },
  runText: { fontSize: 10.5, color: colors.primary, fontWeight: '600' },
  historyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3 },
  historyText: { fontSize: 10.5, color: colors.textMuted, fontWeight: '500' },
  editHint: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 3 },
  editHintText: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
