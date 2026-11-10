/**
 * DelegationCard — a clickable card for a delegation that spawned a full
 * child session (a sub-agent, or a workflow AI node). Unlike a generic
 * ToolCard, pressing it deep-links into the child session's own transcript
 * (OpenCode-style), rather than expanding an inline tool result.
 *
 * Used by MessageList (for a tool message whose ``toolInfo.child_session_id``
 * is set) and by RunDetailView (one per ai-prompt node in a workflow run).
 */

import { memo } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { colors, radius } from '../theme';
import { ToolShine } from './TranscriptMotion';

export type DelegationPhase = 'running' | 'completed' | 'stopped' | 'error';

const DOT_COLOR: Record<DelegationPhase, string> = {
  running: colors.accent,
  completed: colors.success,
  stopped: colors.textMuted,
  error: colors.error,
};

export interface DelegationCardProps {
  /** The authorized child session, available as soon as it starts. */
  childSessionId?: string;
  title: string;
  model?: string;
  label?: string;
  phase?: DelegationPhase;
  onOpen?: (childSessionId: string, meta?: { title?: string; model?: string }) => void;
}

const DelegationCard = memo(function DelegationCard({
  childSessionId, title, model, label = 'sub-agent', phase = 'completed', onOpen,
}: DelegationCardProps) {
  const clickable = !!(childSessionId && onOpen);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={!clickable}
      onPress={() => { if (childSessionId) onOpen?.(childSessionId, { title, model }); }}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open sub-agent session ${title}`}
      // @ts-ignore — web entrance + hover affordance
      {...(Platform.OS === 'web'
        ? { className: clickable ? 'oa-msg-in oa-row-hover oa-card-hover' : 'oa-msg-in' }
        : {})}
    >
      {phase === 'running' ? <ToolShine /> : null}
      <View style={[styles.dot, { backgroundColor: DOT_COLOR[phase] }]} />
      <Feather name="git-branch" size={12} color={colors.textMuted} style={styles.icon} />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {model ? <Text style={styles.model} numberOfLines={1}>{model}</Text> : null}
      </View>
      <Text style={styles.label}>
        {phase === 'running' ? 'running…' : phase === 'stopped' ? 'stopped' : label}
      </Text>
      {clickable ? (
        <Feather name="chevron-right" size={14} color={colors.textMuted} />
      ) : null}
    </TouchableOpacity>
  );
});

export default DelegationCard;

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
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
  model: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  label: {
    color: colors.textMuted,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
