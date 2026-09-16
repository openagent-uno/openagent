/**
 * WorkflowTile — grid card for a workflow.
 *
 * Mirrors ``TaskTile`` / ``EventTile`` exactly (same rail, head row + switch,
 * body, badge row, meta line, footer) so the Workflows dashboard reads as the
 * same grid as Scheduled and Events instead of the old full-width row list.
 * The whole tile is pressable and opens the visual editor.
 */

import { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { WorkflowRun, WorkflowTask } from '../../../common/types';
import { colors, font, radius } from '../../theme';
import ThemedSwitch from '../ThemedSwitch';

// Trigger block type → (label, icon). A workflow renders the union of the
// trigger types its graph carries, so users see "Manual + Scheduled" at a
// glance.
const TRIGGER_LABELS: Record<string, string> = {
  'trigger-manual': 'manual',
  'trigger-schedule': 'scheduled',
  'trigger-ai': 'ai',
  'trigger-event': 'event',
};
const TRIGGER_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  'trigger-manual': 'play-circle',
  'trigger-schedule': 'clock',
  'trigger-ai': 'cpu',
  'trigger-event': 'zap',
};

interface Props {
  workflow: WorkflowTask;
  /** Last run from the store, when one is known (fresher than the row). */
  lastRun?: WorkflowRun | null;
  /** True while this workflow's run is in flight. */
  running: boolean;
  onToggle: (value: boolean) => void;
  onEdit: () => void;
  onHistory: () => void;
  onRemove: () => void;
  onRun: () => Promise<unknown> | void;
  /** Hard-stop the in-flight run. Until this existed the tile could start
   *  a workflow it had no way to stop — a runaway run could only be killed
   *  by asking the agent to call its MCP tool. */
  onStop: () => Promise<unknown> | void;
}

export default function WorkflowTile({
  workflow, lastRun, running, onToggle, onEdit, onHistory, onRemove, onRun, onStop,
}: Props) {
  const [busy, setBusy] = useState(false);
  const isRunning = running;

  const handleRun = async () => {
    if (busy || isRunning) return;
    setBusy(true);
    try {
      await onRun();
    } finally {
      setBusy(false);
    }
  };

  const [stopping, setStopping] = useState(false);
  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      // The run keeps polling to a terminal status on its own; clearing
      // here just re-arms the button if the stop did not take.
      setStopping(false);
    }
  };

  const triggers = workflow.trigger_types ?? [];
  const nodeCount = workflow.graph?.nodes?.length ?? 0;
  const edgeCount = workflow.graph?.edges?.length ?? 0;
  const nextRunIso = workflow.schedules?.[0]?.next_run_at_iso;

  const summary =
    workflow.description
    || `${nodeCount} block${nodeCount === 1 ? '' : 's'} · ${edgeCount} edge${edgeCount === 1 ? '' : 's'}`;

  const meta = nextRunIso && workflow.enabled
    ? `next · ${nextRunIso}`
    : lastRun
      ? `last · ${lastRun.status}${lastRun.error ? ` — ${lastRun.error}` : ''}`
      : workflow.last_run_at_iso
        ? `last · ${workflow.last_run_at_iso}`
        : null;

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onEdit}
      style={[styles.tile, !workflow.enabled && styles.tileDisabled]}
      accessibilityRole="button"
      accessibilityLabel={`Open workflow ${workflow.name}`}
      testID={`workflow-row-${workflow.name}`}
      // @ts-ignore web-only subtle lift
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
    >
      <View style={[styles.rail, workflow.enabled ? styles.railOn : styles.railOff]} />

      <View style={styles.body}>
        <View style={styles.headRow}>
          <Text style={styles.name} numberOfLines={1}>{workflow.name}</Text>
          <ThemedSwitch value={workflow.enabled} onValueChange={onToggle} />
        </View>

        <Text style={styles.prompt} numberOfLines={2}>{summary}</Text>

        <View style={styles.badgesRow}>
          {triggers.length > 0 ? (
            triggers.map((t) => (
              <View key={t} style={styles.badge}>
                <Feather
                  name={TRIGGER_ICONS[t] || 'circle'}
                  size={10}
                  color={colors.primary}
                />
                <Text style={styles.badgeText} numberOfLines={1}>
                  {TRIGGER_LABELS[t] || t.replace('trigger-', '')}
                </Text>
              </View>
            ))
          ) : (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>no triggers</Text>
            </View>
          )}
          {workflow.max_concurrent_runs != null && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>≤{workflow.max_concurrent_runs}</Text>
            </View>
          )}
          {isRunning && (
            <View style={[styles.badge, styles.runningBadge]}>
              <Feather name="activity" size={10} color={colors.success} />
              <Text style={[styles.badgeText, styles.runningBadgeText]}>running</Text>
            </View>
          )}
        </View>

        {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}

        <View style={styles.footRow}>
          <TouchableOpacity onPress={onRemove} style={styles.remove} hitSlop={8} accessibilityRole="button">
            <Feather name="trash-2" size={12} color={colors.textMuted} />
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
          <View style={styles.footRight}>
            {busy || isRunning ? (
              <TouchableOpacity
                onPress={handleStop}
                disabled={stopping}
                style={styles.runBtn}
                hitSlop={8}
                testID={`stop-${workflow.name}`}
                accessibilityRole="button"
                accessibilityLabel={`Stop the running ${workflow.name}`}
              >
                {stopping ? (
                  <ActivityIndicator size="small" color={colors.error} />
                ) : (
                  <Feather name="square" size={12} color={colors.error} />
                )}
                <Text style={[styles.runText, { color: colors.error }]}>
                  {stopping ? 'Stopping…' : 'Stop'}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={handleRun}
                style={styles.runBtn}
                hitSlop={8}
                testID={`run-${workflow.name}`}
                accessibilityRole="button"
                accessibilityLabel={`Run ${workflow.name} now`}
              >
                <Feather name="play" size={12} color={colors.primary} />
                <Text style={styles.runText}>Run now</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={onHistory}
              style={styles.historyBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Run history for ${workflow.name}`}
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
  runningBadge: { backgroundColor: colors.successSoft },
  runningBadgeText: { color: colors.success },
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
