/**
 * RunLaunchCard — a clickable card for a chat turn that launched a scheduled
 * task or a workflow (the agent called the scheduler / workflow-manager MCP's
 * run-now tool). Pressing it deep-links into that run's execution screen
 * (``/runs/{id}``), the run analogue of a DelegationCard.
 *
 * Until the tool returns a run id the card renders as a non-clickable
 * "running…" card (the same affordance DelegationCard uses while a sub-agent's
 * child session id is still being minted), so the chat never shows the raw
 * run-now tool chip.
 */

import { memo } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import type { RunLaunchTarget } from '../../common/types';
import { colors, radius } from '../theme';

const DOT_COLOR: Record<string, string> = {
  running: colors.accent,
  received: colors.warning,
  success: colors.success,
  failed: colors.error,
  cancelled: colors.textMuted,
};

const KIND_META: Record<RunLaunchTarget['kind'], { icon: keyof typeof Feather.glyphMap; label: string }> = {
  task: { icon: 'clock', label: 'scheduled task' },
  workflow: { icon: 'git-branch', label: 'workflow' },
  event: { icon: 'zap', label: 'event' },
};

const RunLaunchCard = memo(function RunLaunchCard({
  target, onOpen,
}: {
  target: RunLaunchTarget;
  onOpen?: (target: RunLaunchTarget) => void;
}) {
  const meta = KIND_META[target.kind];
  const running = (target.status ?? 'running') === 'running';
  const clickable = !!(target.runId && onOpen);
  const dot = DOT_COLOR[target.status ?? 'running'] ?? colors.textMuted;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={!clickable}
      onPress={() => { if (target.runId) onOpen?.(target); }}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open ${meta.label} run`}
      // @ts-ignore — web entrance + hover affordance
      {...(Platform.OS === 'web'
        ? { className: clickable ? 'oa-msg-in oa-row-hover oa-card-hover' : 'oa-msg-in' }
        : {})}
    >
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Feather name={meta.icon} size={12} color={colors.textMuted} style={styles.icon} />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>{target.name || meta.label}</Text>
        <Text style={styles.kind} numberOfLines={1}>{meta.label}</Text>
      </View>
      <Text style={styles.label}>{running ? 'running…' : (target.status || 'open')}</Text>
      {clickable ? (
        <Feather name="chevron-right" size={14} color={colors.textMuted} />
      ) : null}
    </TouchableOpacity>
  );
});

export default RunLaunchCard;

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginVertical: 4,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  icon: { opacity: 0.8 },
  body: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 13, fontWeight: '600' },
  kind: { color: colors.textMuted, fontSize: 11, marginTop: 1, textTransform: 'capitalize' },
  label: {
    color: colors.textMuted,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
