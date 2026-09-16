/**
 * Scheduled-task editor — /tasks/{id}.
 *
 * Opened detached from the list: a separate desktop window, or a pushed
 * full-screen route on web / native. ``id === 'new'`` is the create
 * sentinel (task ids are uuids, so they never collide with the literal
 * "new"); any other id loads that task for editing.
 *
 * Each desktop window is its own renderer with a fresh store, so the
 * task is fetched here over REST rather than read from the list's
 * store. Saving routes through the tasks store (which calls the API and
 * the gateway broadcasts a ``scheduled_task`` event), then the screen
 * dismisses — the list window refetches off that broadcast.
 */

import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import SharedPresence, { useSharedView } from '../../../components/SharedPresence';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius } from '../../../theme';
import { useConnection } from '../../../stores/connection';
import { useTasks } from '../../../stores/tasks';
import { setBaseUrl, getScheduledTask, listDbModels } from '../../../services/api';
import type { ModelEntry } from '../../../../common/types';
import { goBack } from '../../../services/windows';
import CronPicker from '../../../components/CronPicker';
import { HeaderAction, useHeaderInset } from '../../../components/screenHeader';

interface TaskForm {
  name: string;
  cron_expression: string;
  prompt: string;
  /** Optional runtime_id pinning the firing's model; null = default/router. */
  model: string | null;
}

const EMPTY_FORM: TaskForm = { name: '', cron_expression: '', prompt: '', model: null };

export default function TaskEditScreen() {
  const { id, field } = useLocalSearchParams<{ id: string; field?: string }>();
  useSharedView('scheduled_task', id === 'new' ? undefined : id);
  const navigation = useNavigation();
  const router = useRouter();
  const headerInset = useHeaderInset();
  const isNew = id === 'new';
  const connConfig = useConnection((s) => s.config);
  const { createTask, updateTask, error: storeError } = useTasks();

  const [form, setForm] = useState<TaskForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Enabled LLM catalog for the optional per-task model pin. Loaded once so
  // the user picks from configured models instead of typing a runtime_id.
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const nameRef = useRef<TextInput>(null);
  const promptRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!connConfig) return;
    if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
    if (isNew || !id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const t = await getScheduledTask(id);
        if (!cancelled) {
          setForm({
            name: t.name,
            cron_expression: t.cron_expression,
            prompt: t.prompt,
            model: t.model ?? null,
          });
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connConfig, id, isNew]);

  useEffect(() => {
    if (loading || !field) return;
    const timer = setTimeout(() => {
      if (field === 'name') nameRef.current?.focus();
      if (field === 'prompt') promptRef.current?.focus();
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        document.getElementById(`task-field-${field}`)?.scrollIntoView({ block: 'center' });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [field, loading]);

  // Load the enabled LLM catalog for the model picker (non-fatal on failure —
  // the picker just shows "Default" only).
  useEffect(() => {
    if (!connConfig) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listDbModels({ enabledOnly: true, kind: 'llm' });
        if (!cancelled) setModels(list);
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, [connConfig]);

  // Human label for the currently-pinned model (or the default sentinel).
  const modelLabel = useMemo(() => {
    if (!form.model) return 'Auto (default)';
    const m = models.find((x) => x.runtime_id === form.model);
    return m?.display_name || form.model;
  }, [form.model, models]);

  // Return to wherever the editor was opened from (the Scheduled list
  // normally) via expo-router history; cold deep-link falls back to it.
  const close = () => { goBack(router, '/(tabs)/tasks'); };

  const handleSave = async () => {
    setLocalError(null);
    const name = form.name.trim();
    const cron = form.cron_expression.trim();
    const prompt = form.prompt.trim();
    if (!name || !cron || !prompt) {
      setLocalError('Name, schedule, and prompt are all required.');
      return;
    }
    // ``model`` is optional: null clears any pin so the firing uses the
    // agent's default/router model. Always send it (create + update) so
    // clearing a previously-pinned model persists.
    const model = form.model || null;
    setSaving(true);
    const ok = isNew
      ? !!(await createTask({ name, cron_expression: cron, prompt, model }))
      : await updateTask(id, { name, cron_expression: cron, prompt, model });
    setSaving(false);
    if (ok) close();
  };

  // Title + Save action in the nav header (back is provided by the stack).
  useLayoutEffect(() => {
    navigation.setOptions({
      title: isNew ? 'New scheduled task' : 'Scheduled task',
      headerRight: () => (
        <HeaderAction
          icon="check"
          label={saving ? 'Saving…' : isNew ? 'Add' : 'Save'}
          onPress={handleSave}
          disabled={saving || loading}
        />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, isNew, form, saving, loading]);

  return (
    <View style={[styles.screen, { paddingTop: headerInset }]}>
      <SharedPresence kind="scheduled_task" id={id} />
      {loading ? (
        <View style={styles.statusPane}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : loadError ? (
        <View style={styles.statusPane}>
          <Text style={styles.errorMsg}>Failed to load task: {loadError}</Text>
        </View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            ref={nameRef}
            nativeID="task-field-name"
            style={styles.input}
            value={form.name}
            onChangeText={(v) => setForm({ ...form, name: v })}
            placeholder="Name (e.g. health-check)"
            placeholderTextColor={colors.textMuted}
          />

          <View style={styles.cronSlot} nativeID="task-field-schedule">
            <CronPicker
              label="Schedule"
              value={form.cron_expression}
              onChange={(v) => setForm({ ...form, cron_expression: v })}
            />
          </View>

          <Text style={styles.label}>Model</Text>
          <Pressable
            style={styles.pickerBox}
            onPress={() => setModelMenuOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel="Pick the model for this task"
          >
            <Text
              style={[styles.pickerValue, !form.model && styles.pickerValueMuted]}
              numberOfLines={1}
            >
              {modelLabel}
            </Text>
            <Feather
              name={modelMenuOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.textMuted}
            />
          </Pressable>
          {modelMenuOpen && (
            <View style={styles.pickerMenu}>
              <ModelOption
                label="Auto (default)"
                active={!form.model}
                onPress={() => { setForm({ ...form, model: null }); setModelMenuOpen(false); }}
              />
              {models.map((m) => (
                <ModelOption
                  key={m.runtime_id}
                  label={m.display_name || m.runtime_id}
                  sublabel={m.display_name ? m.runtime_id : undefined}
                  active={form.model === m.runtime_id}
                  onPress={() => { setForm({ ...form, model: m.runtime_id }); setModelMenuOpen(false); }}
                />
              ))}
            </View>
          )}
          <Text style={styles.hint}>
            Leave on Auto to pick the model automatically, or pin a specific
            model this task always fires on.
          </Text>

          <Text style={styles.label}>Prompt</Text>
          {Platform.OS === 'web' ? (
            <textarea
              id="task-field-prompt"
              value={form.prompt}
              onChange={(e: any) => setForm({ ...form, prompt: e.target.value })}
              placeholder="Prompt — what should the agent do?"
              rows={6}
              style={{
                backgroundColor: colors.inputBg, borderRadius: 8, border: `1px solid ${colors.border}`,
                padding: 10, color: colors.text, fontSize: 13, fontFamily: 'inherit',
                resize: 'vertical', outline: 'none', width: '100%', boxSizing: 'border-box',
              } as any}
            />
          ) : (
            <TextInput
              ref={promptRef}
              nativeID="task-field-prompt"
              style={[styles.input, { height: 120, textAlignVertical: 'top' }]}
              value={form.prompt}
              onChangeText={(v) => setForm({ ...form, prompt: v })}
              placeholder="Prompt"
              placeholderTextColor={colors.textMuted}
              multiline
            />
          )}

          {(localError || storeError) && (
            <Text style={styles.errorMsg}>{localError || storeError}</Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

/** One row in the inline model dropdown — cross-platform (web + native). */
function ModelOption({
  label, sublabel, active, onPress,
}: {
  label: string;
  sublabel?: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.optionRow}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, active && styles.optionLabelActive]} numberOfLines={1}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={styles.optionSub} numberOfLines={1}>{sublabel}</Text>
        ) : null}
      </View>
      {active ? <Feather name="check" size={15} color={colors.primary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  statusPane: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { flex: 1 },
  bodyContent: { padding: 20, maxWidth: 640, width: '100%', alignSelf: 'center' },
  label: {
    fontSize: 11, fontWeight: '600', color: colors.textSecondary,
    marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 9,
    color: colors.text, fontSize: 12, marginBottom: 14, fontFamily: font.mono,
  },
  cronSlot: { marginBottom: 14 },
  errorMsg: { marginTop: 12, fontSize: 12, color: colors.error },
  hint: {
    fontSize: 11, color: colors.textMuted, marginTop: 6, marginBottom: 14,
    lineHeight: 16,
  },
  pickerBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 10, gap: 8,
  },
  pickerValue: { flex: 1, color: colors.text, fontSize: 12, fontFamily: font.mono },
  pickerValueMuted: { color: colors.textSecondary },
  pickerMenu: {
    marginTop: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg, overflow: 'hidden',
  },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 11, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  optionText: { flex: 1 },
  optionLabel: { color: colors.text, fontSize: 12, fontFamily: font.sans },
  optionLabelActive: { color: colors.primary, fontWeight: '600' },
  optionSub: { color: colors.textMuted, fontSize: 10, fontFamily: font.mono, marginTop: 2 },
});
