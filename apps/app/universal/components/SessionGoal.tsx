/**
 * The conversation's goal, in the session details panel.
 *
 * A goal keeps the agent working in this conversation until it is achieved,
 * blocked or out of budget (server: ``/api/sessions/{id}/goal``, Core:
 * ``openagent_core.session_goal``). The panel shows its state and offers the
 * same controls as ``/goal``: set, pause, resume, mark done and clear.
 *
 * A goal can run to a few thousand characters, so the panel previews its
 * first lines only; reading the whole objective, setting a goal and editing
 * it happen in a dedicated dialog (``GoalDialog``).
 *
 * It refreshes when the session's turn starts or ends (the agent changes the
 * goal with its ``[goal: …]`` markers), on a ``session`` resource event (REST
 * changes from any client) and after a ``/goal`` command result.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { colors, font, glassSurface, radius, spacing } from '../theme';
import Button from './Button';

type State = { key: string; goal: Goal | null; loading: boolean; unsupported: boolean; error: string | null };

/** Core caps an objective at 4000 characters (``session_goal.MAX_OBJECTIVE``). */
const MAX_OBJECTIVE = 4000;
/** Lines of the objective shown in the side panel before "Open goal". */
const PREVIEW_LINES = 5;

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

// Every mounted view of a conversation's goal (side panel, composer bar)
// reloads when one of them changes it, without waiting for the server's
// resource event.
const goalListeners = new Set<(sessionId: string) => void>();
function announceGoalChange(sessionId: string) {
  for (const listener of goalListeners) listener(sessionId);
}

/** The conversation's goal, kept current: it reloads when the session's
 *  turn starts or ends, on a ``session`` resource event and after a
 *  ``/goal`` command result. Shared by the side panel and the composer bar. */
function useSessionGoal(sessionId: string | undefined, isProcessing: boolean | undefined) {
  const ws = useConnection((s) => s.ws);
  const key = sessionId ?? '';
  const [state, setState] = useState<State>({ key, goal: null, loading: true, unsupported: false, error: null });
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
    if (!sessionId) return;
    const listener = (changed: string) => { if (changed === sessionId) refresh(); };
    goalListeners.add(listener);
    return () => { goalListeners.delete(listener); };
  }, [sessionId, refresh]);

  useEffect(() => {
    if (!ws || !sessionId) return;
    return ws.onMessage((msg: any) => {
      if (msg?.type === 'command_result' && typeof msg.text === 'string' && /goal/i.test(msg.text)) refresh();
    });
  }, [ws, sessionId, refresh]);

  const goal = state.key === key ? state.goal : null;
  const setError = useCallback((error: string | null) => setState((previous) => ({ ...previous, error })), []);
  // Editing keeps an active or paused goal running with its budget; saving
  // over an achieved goal (or with none) starts a new one.
  const save = useCallback(async (objective: string) => {
    if (!sessionId) return;
    if (goal && goal.status !== 'achieved') await updateSessionGoal(sessionId, { objective });
    else await setSessionGoal(sessionId, objective);
    announceGoalChange(sessionId);
  }, [sessionId, goal]);
  const clear = useCallback(async () => {
    if (!sessionId) return;
    await clearSessionGoal(sessionId);
    announceGoalChange(sessionId);
  }, [sessionId]);
  return { state, key, goal, refresh, setError, save, clear };
}

/** One line above the composer: the goal's state and the start of its
 *  objective, with a button that opens the goal dialog (read, edit, remove).
 *  Renders nothing without a goal. */
export function SessionGoalBar({ sessionId, isProcessing }: { sessionId?: string; isProcessing?: boolean }) {
  const { goal, save, clear } = useSessionGoal(sessionId, isProcessing);
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!sessionId || !goal) return null;
  return (
    <>
      <Pressable
        onPress={() => setDialogOpen(true)}
        style={styles.bar}
        accessibilityRole="button"
        accessibilityLabel="Goal bar"
        {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
      >
        <Feather name="target" size={12} color={statusColor(goal.status)} />
        <Text style={[styles.barStatus, { color: statusColor(goal.status) }]}>{STATUS_LABEL[goal.status]}</Text>
        <Text style={styles.barObjective} numberOfLines={1}>{goal.objective.replace(/\s+/g, ' ')}</Text>
        <Text style={styles.barMeta}>{goal.continuations}/{goal.max_continuations}</Text>
        <View style={styles.barButton}>
          <Feather name="edit-2" size={11} color={colors.textSecondary} />
          <Text style={styles.barButtonText}>Goal</Text>
        </View>
      </Pressable>
      <GoalDialog
        visible={dialogOpen}
        goal={goal}
        startEditing={false}
        onClose={() => setDialogOpen(false)}
        onSave={save}
        onClear={clear}
      />
    </>
  );
}

export default function SessionGoal({ sessionId, isProcessing }: { sessionId?: string; isProcessing?: boolean }) {
  const { state, key, goal, setError, save, clear } = useSessionGoal(sessionId, isProcessing);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (change: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await change();
    } catch (error: any) {
      setError(String(error?.message ?? error));
    } finally {
      setBusy(false);
      if (sessionId) announceGoalChange(sessionId);
    }
  }, [sessionId, setError]);

  if (!sessionId) {
    return <Text style={styles.empty}>Send the first message, then give this conversation a goal.</Text>;
  }
  if (state.unsupported) {
    return <Text style={styles.empty}>This agent's server does not support goals yet.</Text>;
  }
  if (state.loading && state.key !== key) {
    return <ActivityIndicator size="small" color={colors.textMuted} />;
  }
  const dialog = (
    <GoalDialog
      visible={dialogOpen}
      goal={goal}
      startEditing={!goal}
      onClose={() => setDialogOpen(false)}
      onSave={save}
      onClear={clear}
    />
  );

  if (!goal) {
    return (
      <View>
        <Text style={styles.empty}>
          No goal. With a goal the agent keeps working in this conversation until it is done. You can also type /goal &lt;objective&gt;.
        </Text>
        <View style={styles.actions}>
          <ActionButton icon="target" label="Set goal" onPress={() => setDialogOpen(true)} />
        </View>
        {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
        {dialog}
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
      <Pressable
        onPress={() => setDialogOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Open goal"
        {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
      >
        <Text style={styles.objective} numberOfLines={PREVIEW_LINES}>{goal.objective}</Text>
      </Pressable>
      {goal.status === 'paused' && goal.paused_reason ? <Text style={styles.detail} numberOfLines={2}>Paused: {goal.paused_reason}</Text> : null}
      {goal.status === 'achieved' && goal.outcome ? <Text style={styles.detail} numberOfLines={2}>Outcome: {goal.outcome}</Text> : null}
      <View style={styles.actions}>
        <ActionButton icon="maximize-2" label="Open" onPress={() => setDialogOpen(true)} />
        {goal.status === 'active' ? <ActionButton icon="pause" label="Pause" disabled={busy} onPress={() => run(() => updateSessionGoal(sessionId, { action: 'pause' }))} /> : null}
        {goal.status === 'paused' ? <ActionButton icon="play" label="Resume" disabled={busy} onPress={() => run(() => updateSessionGoal(sessionId, { action: 'resume' }))} /> : null}
        {goal.status !== 'achieved' ? <ActionButton icon="check" label="Mark done" disabled={busy} onPress={() => run(() => updateSessionGoal(sessionId, { action: 'done' }))} /> : null}
        <ActionButton icon="x" label="Clear" disabled={busy} onPress={() => run(() => clearSessionGoal(sessionId))} />
      </View>
      {goal.status === 'active' && isProcessing ? <Text style={styles.detail}>The agent is working on it.</Text> : null}
      {goal.status === 'active' && !isProcessing ? <Text style={styles.detail}>Send a message to continue working on it.</Text> : null}
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {dialog}
    </View>
  );
}

/** The whole goal: read it, edit its objective, or set a new one. */
function GoalDialog({ visible, goal, startEditing, onClose, onSave, onClear }: {
  visible: boolean;
  goal: Goal | null;
  startEditing: boolean;
  onClose: () => void;
  onSave: (objective: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setEditing(startEditing);
    setDraft(goal?.objective ?? '');
    setError(null);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on open only

  const close = useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);

  useEffect(() => {
    if (!visible || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, close]);

  const submit = async () => {
    const objective = draft.trim();
    if (!objective) { setError('Describe what the agent should achieve.'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(objective);
      onClose();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await onClear();
      onClose();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setSaving(false);
    }
  };

  const replacing = goal?.status === 'achieved';
  const title = !goal ? 'Set goal' : editing ? (replacing ? 'New goal' : 'Edit goal') : 'Goal';

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
        />
        <View style={styles.dialog} {...(Platform.OS === 'web' ? { className: 'oa-slide-up' } as any : {})}>
          <View style={styles.dialogHeader}>
            <Text style={styles.dialogTitle}>{title}</Text>
            {goal ? (
              <View style={styles.statusRow}>
                <View style={[styles.dot, { backgroundColor: statusColor(goal.status) }]} />
                <Text style={styles.status}>{STATUS_LABEL[goal.status]}</Text>
                <Text style={styles.metaInline}>· {goal.continuations} of {goal.max_continuations} continuations</Text>
              </View>
            ) : null}
          </View>
          {editing ? (
            <>
              <TextInput
                value={draft}
                onChangeText={(value) => { setDraft(value); if (error) setError(null); }}
                placeholder="What should the agent achieve here?"
                placeholderTextColor={colors.textMuted}
                multiline
                autoFocus
                maxLength={MAX_OBJECTIVE}
                editable={!saving}
                style={styles.dialogInput}
                accessibilityLabel="Goal objective"
              />
              <Text style={styles.counter}>
                {draft.length} / {MAX_OBJECTIVE}
                {replacing ? ' · Saving starts a new goal.' : goal ? ' · The goal keeps its status and budget.' : ''}
              </Text>
            </>
          ) : goal ? (
            <ScrollView style={styles.dialogBody} contentContainerStyle={{ paddingRight: 6 }}>
              <Text selectable style={styles.dialogObjective}>{goal.objective}</Text>
              {goal.note ? <Text selectable style={styles.dialogDetail}>Note: {goal.note}</Text> : null}
              {goal.status === 'paused' && goal.paused_reason ? <Text selectable style={styles.dialogDetail}>Paused: {goal.paused_reason}</Text> : null}
              {goal.status === 'achieved' && goal.outcome ? <Text selectable style={styles.dialogDetail}>Outcome: {goal.outcome}</Text> : null}
            </ScrollView>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.dialogActions}>
            {editing ? (
              <>
                <Button
                  variant="secondary"
                  label="Cancel"
                  accessibilityLabel="Cancel goal edit"
                  disabled={saving}
                  onPress={() => (goal ? (setEditing(false), setDraft(goal.objective), setError(null)) : close())}
                />
                <Button variant="primary" label={saving ? 'Saving…' : replacing || !goal ? 'Set goal' : 'Save'} accessibilityLabel="Save goal" disabled={saving || !draft.trim()} onPress={() => void submit()} />
              </>
            ) : (
              <>
                <Button variant="ghost" label="Remove" accessibilityLabel="Remove goal" disabled={saving} onPress={() => void remove()} style={{ marginRight: 'auto' }} />
                <Button variant="secondary" label="Close" accessibilityLabel="Close goal" onPress={close} />
                <Button variant="primary" label={replacing ? 'New goal' : 'Edit'} accessibilityLabel={replacing ? 'New goal' : 'Edit goal'} onPress={() => setEditing(true)} />
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
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
  overlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24,
    backgroundColor: 'rgba(2, 4, 10, 0.45)',
  },
  dialog: {
    width: 680, maxWidth: '100%', maxHeight: '85%', padding: 20,
    borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border,
    backgroundColor: glassSurface.backgroundColor,
    ...(Platform.OS === 'web'
      ? { backdropFilter: glassSurface.webFilter, WebkitBackdropFilter: glassSurface.webFilter }
      : {}),
    shadowColor: 'rgba(0,0,0,0.18)', shadowOffset: { width: 0, height: 24 }, shadowOpacity: 1, shadowRadius: 48,
  } as any,
  dialogHeader: { gap: 6, marginBottom: 14 },
  dialogTitle: { color: colors.text, fontFamily: font.display, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  metaInline: { fontFamily: font.sans, fontSize: 11.5, color: colors.textMuted },
  dialogBody: { flexShrink: 1 },
  dialogObjective: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 21, color: colors.text },
  dialogDetail: { fontFamily: font.sans, fontSize: 12.5, lineHeight: 19, color: colors.textSecondary, marginTop: spacing.sm },
  dialogInput: {
    minHeight: 320, flexShrink: 1, padding: 12, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface, color: colors.text,
    fontFamily: font.sans, fontSize: 13.5, lineHeight: 21, textAlignVertical: 'top', outlineStyle: 'none',
  } as any,
  counter: { fontFamily: font.sans, fontSize: 11.5, color: colors.textMuted, marginTop: 6 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 5,
    backgroundColor: colors.sidebar,
    borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md,
    borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border,
  },
  barStatus: { fontFamily: font.sans, fontSize: 11.5, fontWeight: '600' },
  barObjective: { flex: 1, minWidth: 0, fontFamily: font.sans, fontSize: 12, color: colors.textSecondary },
  barMeta: { fontFamily: font.mono, fontSize: 10.5, color: colors.textMuted },
  barButton: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  barButtonText: { fontFamily: font.sans, fontSize: 11, color: colors.textSecondary },
});
