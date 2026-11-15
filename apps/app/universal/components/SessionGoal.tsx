/**
 * The conversation's goal, in the session details panel.
 *
 * A goal keeps the agent working in this conversation until it is achieved,
 * blocked or out of budget (server: ``/api/sessions/{id}/goal``, Core:
 * ``openagent_core.session_goal``). The panel shows its state and offers the
 * same controls as ``/goal``: set, pause, resume, mark done and clear.
 *
 * It refreshes when the session's turn starts or ends (the agent changes the
 * goal with its ``[goal: …]`` markers), on a ``session`` resource event (REST
 * changes from any client) and after a ``/goal`` command result.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import {
  clearSessionGoal,
  getSessionGoal,
  isUnsupportedByAgent,
  setSessionGoal,
  updateSessionGoal,
  type SessionGoal as Goal,
} from '../services/api';
import { useConnection } from '../stores/connection';
import { useEvents } from '../stores/events';
import { colors, font, radius, spacing } from '../theme';

type State = { key: string; goal: Goal | null; loading: boolean; unsupported: boolean; error: string | null };

const STATUS_LABEL: Record<Goal['status'], string> = { active: 'Active', paused: 'Paused', achieved: 'Achieved' };

function statusColor(status: Goal['status']): string {
  if (status === 'active') return colors.warning;
  if (status === 'achieved') return colors.success;
  return colors.textMuted;
}

function ActionButton({ icon, label, onPress, disabled }: {
  icon: keyof typeof Feather.glyphMap; label: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, disabled && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
    >
      <Feather name={icon} size={12} color={colors.textSecondary} />
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export default function SessionGoal({ sessionId, isProcessing }: { sessionId?: string; isProcessing?: boolean }) {
  const ws = useConnection((s) => s.ws);
  const key = sessionId ?? '';
  const [state, setState] = useState<State>({ key, goal: null, loading: true, unsupported: false, error: null });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    setState((previous) => previous.key === key ? { ...previous, loading: true } : { key, goal: null, loading: true, unsupported: false, error: null });
    getSessionGoal(sessionId, controller.signal).then(
      (goal) => { if (!controller.signal.aborted) setState({ key, goal, loading: false, unsupported: false, error: null }); },
      (error) => {
        if (controller.signal.aborted) return;
        setState({ key, goal: null, loading: false, unsupported: isUnsupportedByAgent(error), error: isUnsupportedByAgent(error) ? null : String(error?.message ?? error) });
      },
    );
    return () => controller.abort();
  }, [sessionId, key, revision, isProcessing]);

  useEffect(() => useEvents.getState().subscribe('session', refresh), [refresh]);

  useEffect(() => {
    if (!ws || !sessionId) return;
    return ws.onMessage((msg: any) => {
      if (msg?.type === 'command_result' && typeof msg.text === 'string' && /goal/i.test(msg.text)) refresh();
    });
  }, [ws, sessionId, refresh]);

  const run = useCallback(async (change: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await change();
      setDraft('');
    } catch (error: any) {
      setState((previous) => ({ ...previous, error: String(error?.message ?? error) }));
    } finally {
      setBusy(false);
      refresh();
    }
  }, [refresh]);

  if (!sessionId) {
    return <Text style={styles.empty}>Send the first message, then give this conversation a goal.</Text>;
  }
  if (state.unsupported) {
    return <Text style={styles.empty}>This agent's server does not support goals yet.</Text>;
  }
  if (state.loading && state.key !== key) {
    return <ActivityIndicator size="small" color={colors.textMuted} />;
  }
  const goal = state.key === key ? state.goal : null;

  const setForm = (
    <View style={styles.form}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={goal ? 'New objective…' : 'What should the agent achieve here?'}
        placeholderTextColor={colors.textMuted}
        multiline
        style={styles.input}
        accessibilityLabel="Goal objective"
      />
      <ActionButton
        icon="target"
        label={goal ? 'Replace goal' : 'Set goal'}
        disabled={busy || !draft.trim()}
        onPress={() => run(() => setSessionGoal(sessionId, draft.trim()))}
      />
    </View>
  );

  if (!goal) {
    return (
      <View>
        <Text style={styles.empty}>
          No goal. With a goal the agent keeps working in this conversation until it is done. You can also type /goal &lt;objective&gt;.
        </Text>
        {setForm}
        {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      </View>
    );
  }

  return (
    <View>
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: statusColor(goal.status) }]} />
        <Text style={styles.status}>{STATUS_LABEL[goal.status]}</Text>
        <Text style={styles.meta}>{goal.continuations} of {goal.max_continuations} continuations</Text>
      </View>
      <Text selectable style={styles.objective}>{goal.objective}</Text>
      {goal.note ? <Text selectable style={styles.detail}>Note: {goal.note}</Text> : null}
      {goal.status === 'paused' && goal.paused_reason ? <Text selectable style={styles.detail}>Paused: {goal.paused_reason}</Text> : null}
      {goal.status === 'achieved' && goal.outcome ? <Text selectable style={styles.detail}>Outcome: {goal.outcome}</Text> : null}
      <View style={styles.actions}>
        {goal.status === 'active' ? <ActionButton icon="pause" label="Pause" disabled={busy} onPress={() => run(() => updateSessionGoal(sessionId, { action: 'pause' }))} /> : null}
        {goal.status === 'paused' ? <ActionButton icon="play" label="Resume" disabled={busy} onPress={() => run(() => updateSessionGoal(sessionId, { action: 'resume' }))} /> : null}
        {goal.status !== 'achieved' ? <ActionButton icon="check" label="Mark done" disabled={busy} onPress={() => run(() => updateSessionGoal(sessionId, { action: 'done' }))} /> : null}
        <ActionButton icon="x" label="Clear" disabled={busy} onPress={() => run(() => clearSessionGoal(sessionId))} />
      </View>
      {goal.status !== 'active' ? setForm : null}
      {goal.status === 'active' && isProcessing ? <Text style={styles.detail}>The agent is working on it.</Text> : null}
      {goal.status === 'active' && !isProcessing ? <Text style={styles.detail}>Send a message to continue working on it.</Text> : null}
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, color: colors.textMuted },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.xs },
  dot: { width: 7, height: 7, borderRadius: 4 },
  status: { fontFamily: font.sans, fontSize: 12, fontWeight: '600', color: colors.text },
  meta: { fontFamily: font.sans, fontSize: 11, color: colors.textMuted, marginLeft: 'auto' },
  objective: { fontFamily: font.sans, fontSize: 12.5, lineHeight: 18, color: colors.text },
  detail: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, color: colors.textSecondary, marginTop: spacing.xs },
  error: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, color: colors.error, marginTop: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm },
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  buttonText: { fontFamily: font.sans, fontSize: 11.5, color: colors.textSecondary },
  form: { gap: 6, marginTop: spacing.sm },
  input: {
    minHeight: 54, padding: 8, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, backgroundColor: colors.inputBg, color: colors.text,
    fontFamily: font.sans, fontSize: 12, textAlignVertical: 'top',
  },
});
