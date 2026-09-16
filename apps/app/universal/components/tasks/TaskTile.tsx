/**
 * TaskTile — grid card for a scheduled task.
 *
 * Mirrors ``McpTile`` so the Scheduled screen reads as the same grid as
 * Connectors: a left status rail (lit when enabled), the task name + an
 * enable switch up top, the prompt as the body, a cron / cadence badge row,
 * and a footer with Remove (left) + run-history and Edit affordances (right).
 * The whole tile is pressable and opens the editor.
 */

import { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { ScheduledTask } from '../../../common/types';
import { colors, font, radius } from '../../theme';
import ThemedSwitch from '../ThemedSwitch';

interface Props {
  task: ScheduledTask;
  onToggle: (value: boolean) => void;
  onEdit: () => void;
  onHistory: () => void;
  onRemove: () => void;
  /** Fire the task now, out of band from its schedule. Resolves once the
   *  run is dispatched (not when the firing finishes). */
  onRun: () => Promise<boolean> | void;
  /** Stop the in-flight firing(s) of the task. Resolves once the stop is
   *  requested; the scheduler hard-stops within ~2s. */
  onStop: () => Promise<boolean> | void;
}

export default function TaskTile({ task, onToggle, onEdit, onHistory, onRemove, onRun, onStop }: Props) {
  // ``task.running`` (server-driven) decides Run-now vs Stop; ``busy`` is a
  // local guard while a run/stop request is in flight so the button can't be
  // double-fired and shows a spinner.
  const isRunning = !!task.running;
  const [busy, setBusy] = useState(false);

  const handleRun = async () => {
    if (busy || isRunning) return;
    setBusy(true);
    try {
      await onRun();
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onStop();
    } finally {
      setBusy(false);
    }
  };

  const cadence = task.run_once
    ? { icon: 'play-circle' as const, label: task.run_at_iso || 'once' }
    : { icon: 'clock' as const, label: task.cron_expression };

  // The whole tile opens the editor; nested switch / buttons intercept their
  // own taps (RN picks the deepest responder).
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onEdit}
      style={[styles.tile, !task.enabled && styles.tileDisabled]}
      accessibilityRole="button"
      accessibilityLabel={`Open task ${task.name}`}
      // @ts-ignore web-only subtle lift
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
    >
      <View style={[styles.rail, task.enabled ? styles.railOn : styles.railOff]} />

      <View style={styles.body}>
        <View style={styles.headRow}>
          <Text style={styles.name} numberOfLines={1}>{task.name}</Text>
          <ThemedSwitch value={task.enabled} onValueChange={onToggle} />
        </View>

        <Text style={styles.prompt} numberOfLines={2}>{task.prompt}</Text>

        <View style={styles.badgesRow}>
          <View style={styles.badge}>
            <Feather name={cadence.icon} size={10} color={colors.primary} />
            <Text style={styles.badgeText} numberOfLines={1}>{cadence.label}</Text>
          </View>
          {task.run_once && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>once</Text>
            </View>
          )}
          {isRunning && (
            <View style={[styles.badge, styles.runningBadge]}>
              <Feather name="activity" size={10} color={colors.success} />
              <Text style={[styles.badgeText, styles.runningBadgeText]}>running</Text>
            </View>
          )}
        </View>

        {task.next_run_iso && task.enabled ? (
          <Text style={styles.meta} numberOfLines={1}>next · {task.next_run_iso}</Text>
        ) : task.last_run_iso ? (
          <Text style={styles.meta} numberOfLines={1}>last · {task.last_run_iso}</Text>
        ) : null}

        <View style={styles.footRow}>
          <TouchableOpacity onPress={onRemove} style={styles.remove} hitSlop={8} accessibilityRole="button">
            <Feather name="trash-2" size={12} color={colors.textMuted} />
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
          <View style={styles.footRight}>
            {isRunning ? (
              <TouchableOpacity
                onPress={handleStop}
                disabled={busy}
                style={styles.stopBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Stop ${task.name}`}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.error} />
                ) : (
                  <Feather name="square" size={12} color={colors.error} />
                )}
                <Text style={styles.stopText}>{busy ? 'Stopping…' : 'Stop'}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={handleRun}
                disabled={busy}
                style={styles.runBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Run ${task.name} now`}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Feather name="play" size={12} color={colors.primary} />
                )}
                <Text style={styles.runText}>{busy ? 'Running…' : 'Run now'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={onHistory}
              style={styles.historyBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Run history for ${task.name}`}
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
  prompt: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
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
  runningBadge: { backgroundColor: colors.successSoft },
  runningBadgeText: { color: colors.success },
  meta: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontFamily: font.mono,
  },
  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 'auto',
  },
  footRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  remove: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  removeText: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '500',
  },
  runBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  runText: {
    fontSize: 10.5,
    color: colors.primary,
    fontWeight: '600',
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  stopText: {
    fontSize: 10.5,
    color: colors.error,
    fontWeight: '600',
  },
  historyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
  },
  historyText: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '500',
  },
  editHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 3,
  },
  editHintText: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
});
