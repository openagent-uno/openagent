/**
 * The conversation's loops, in the session details panel.
 *
 * A loop is a scheduled task bound to this conversation (``session_id`` on
 * ``POST /api/scheduled-tasks``): every firing is a turn of this chat, run with
 * the authority the user granted when creating it. The panel lists them and
 * offers the same controls as the Scheduled screen (pause/resume, run now,
 * delete) plus a small form to add one. ``/loop <interval> <prompt>`` in the
 * composer creates one too.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { ScheduledTask } from '../../common/types';
import {
  createSessionLoop,
  deleteScheduledTask,
  describeLoopCron,
  getSessionLoops,
  isUnsupportedByAgent,
  runScheduledTask,
  updateScheduledTask,
} from '../services/api';
import { useEvents } from '../stores/events';
import { colors, font, radius, spacing } from '../theme';

const INTERVALS = ['15m', '30m', '1h', '2h', '6h', '1d'];

function Button({ icon, label, onPress, disabled, selected }: {
  icon?: keyof typeof Feather.glyphMap; label: string; onPress: () => void; disabled?: boolean; selected?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, selected && styles.buttonSelected, disabled && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
    >
      {icon ? <Feather name={icon} size={12} color={colors.textSecondary} /> : null}
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function nextRunLabel(task: ScheduledTask): string | null {
  if (!task.enabled || !task.next_run) return null;
  const date = new Date(task.next_run * 1000);
  return `next ${date.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

export default function SessionLoops({ sessionId }: { sessionId?: string }) {
  const [loops, setLoops] = useState<ScheduledTask[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interval, setLoopInterval] = useState('1h');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    getSessionLoops(sessionId).then(
      (rows) => { if (!cancelled) { setLoops(rows); setUnsupported(false); } },
      (err) => {
        if (cancelled) return;
        setLoops([]);
        if (isUnsupportedByAgent(err)) setUnsupported(true);
        else setError(String(err?.message ?? err));
      },
    );
    return () => { cancelled = true; };
  }, [sessionId, revision]);

  useEffect(() => useEvents.getState().subscribe('scheduled_task', refresh), [refresh]);

  const run = useCallback(async (action: () => Promise<unknown>, clear = false) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (clear) setPrompt('');
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
      refresh();
    }
  }, [refresh]);

  if (!sessionId) {
    return <Text style={styles.empty}>Send the first message, then add a loop to this conversation.</Text>;
  }
  if (unsupported) {
    return <Text style={styles.empty}>This agent's server does not support loops yet.</Text>;
  }
  if (loops === null) {
    return <ActivityIndicator size="small" color={colors.textMuted} />;
  }

  return (
    <View>
      {loops.length === 0 ? (
        <Text style={styles.empty}>
          No loops. A loop runs a prompt in this conversation on a schedule. You can also type /loop 30m &lt;prompt&gt;.
        </Text>
      ) : loops.map((task) => (
        <View key={task.id} style={styles.loop}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: task.enabled ? colors.success : colors.textMuted }]} />
            <Text style={styles.when}>{describeLoopCron(task.cron_expression)}</Text>
            <Text style={styles.meta}>{task.enabled ? nextRunLabel(task) ?? 'scheduled' : 'paused'}</Text>
          </View>
          <Text selectable style={styles.prompt} numberOfLines={3}>{task.prompt}</Text>
          {task.authorization_required ? (
            <Text style={styles.error}>Needs approval in Scheduled before it can run.</Text>
          ) : null}
          <View style={styles.actions}>
            <Button icon={task.enabled ? 'pause' : 'play'} label={task.enabled ? 'Pause' : 'Resume'} disabled={busy}
              onPress={() => run(() => updateScheduledTask(task.id, { enabled: !task.enabled }))} />
            {/* Pausing a loop withdraws its authority, so only an active loop can run now. */}
            <Button icon="zap" label="Run now" disabled={busy || task.running || !task.enabled}
              onPress={() => run(() => runScheduledTask(task.id))} />
            <Button icon="trash-2" label="Delete" disabled={busy}
              onPress={() => run(() => deleteScheduledTask(task.id))} />
          </View>
        </View>
      ))}
      <View style={styles.form}>
        <View style={styles.actions}>
          {INTERVALS.map((value) => (
            <Button key={value} label={value} selected={value === interval} onPress={() => setLoopInterval(value)} />
          ))}
        </View>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should the agent do each time?"
          placeholderTextColor={colors.textMuted}
          multiline
          style={styles.input}
          accessibilityLabel="Loop prompt"
        />
        <Button icon="repeat" label={`Add loop every ${interval}`} disabled={busy || !prompt.trim()}
          onPress={() => run(() => createSessionLoop(sessionId, interval, prompt), true)} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, color: colors.textMuted },
  loop: { paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, marginBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  when: { fontFamily: font.sans, fontSize: 12, fontWeight: '600', color: colors.text },
  meta: { fontFamily: font.sans, fontSize: 11, color: colors.textMuted, marginLeft: 'auto' },
  prompt: { fontFamily: font.sans, fontSize: 12, lineHeight: 17, color: colors.textSecondary, marginTop: 2 },
  error: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, color: colors.error, marginTop: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.xs },
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  buttonSelected: { borderColor: colors.accent },
  buttonText: { fontFamily: font.sans, fontSize: 11.5, color: colors.textSecondary },
  form: { gap: 6, marginTop: spacing.sm },
  input: {
    minHeight: 48, padding: 8, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border, backgroundColor: colors.inputBg, color: colors.text,
    fontFamily: font.sans, fontSize: 12, textAlignVertical: 'top',
  },
});
