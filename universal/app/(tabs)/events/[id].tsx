/**
 * Event editor — /events/{id}.
 *
 * ``id === 'new'`` is the create sentinel (event ids are uuids). The editor
 * carries: name, webhook type (preset), the action binding (workflow / task /
 * prompt + its target), an optional model pin, a user-friendly input schema
 * (repeatable field rows), and — for an existing event — a Webhook panel with
 * the connection URL, a one-time secret reveal, a copyable curl example, a
 * rotate-secret control, and a Test button.
 *
 * The per-event secret is shown in clear exactly once: right after create (from
 * the create response) or after a rotate. Reads never return it, so the panel
 * shows ``whsec_…abcd`` (the hint) the rest of the time.
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
import { useEventDefs } from '../../../stores/eventDefs';
import {
  setBaseUrl, getEvent, getWorkflows, getScheduledTasks, listDbModels, triggerEvent,
} from '../../../services/api';
import type {
  AgentEvent, EventActionKind, EventType, EventInputField, ModelEntry,
} from '../../../../common/types';
import { goBack } from '../../../services/windows';
import { HeaderAction, useHeaderInset } from '../../../components/screenHeader';
import ThemedSwitch from '../../../components/ThemedSwitch';

const ACTION_KINDS: { key: EventActionKind; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: 'prompt', label: 'Chat prompt', icon: 'message-circle' },
  { key: 'workflow', label: 'Workflow', icon: 'git-branch' },
  { key: 'scheduled_task', label: 'Scheduled task', icon: 'clock' },
];

const FALLBACK_TYPES: { key: EventType; label: string }[] = [
  { key: 'generic', label: 'Generic' },
  { key: 'generic-hmac', label: 'Generic HMAC' },
  { key: 'github', label: 'GitHub' },
  { key: 'stripe', label: 'Stripe' },
  { key: 'slack', label: 'Slack' },
];

interface Form {
  name: string;
  type: EventType;
  action_kind: EventActionKind;
  action_ref: string | null;
  prompt_template: string;
  model: string | null;
  session_binding_enabled: boolean;
  session_binding_path: string;
  input_schema: EventInputField[];
}

const EMPTY: Form = {
  name: '', type: 'generic', action_kind: 'prompt',
  action_ref: null, prompt_template: '', model: null,
  session_binding_enabled: false, session_binding_path: 'id',
  input_schema: [],
};

export default function EventEditScreen() {
  const { id, field } = useLocalSearchParams<{ id: string; field?: string }>();
  useSharedView('event', id === 'new' ? undefined : id);
  const navigation = useNavigation();
  const router = useRouter();
  const headerInset = useHeaderInset();
  const isNew = id === 'new';
  const connConfig = useConnection((s) => s.config);
  const { createEvent, updateEvent, rotateSecret, types, loadTypes, error: storeError } = useEventDefs();

  const [form, setForm] = useState<Form>(EMPTY);
  const [existing, setExisting] = useState<AgentEvent | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [tasks, setTasks] = useState<{ id: string; name: string }[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [typeMenu, setTypeMenu] = useState(false);
  const [targetMenu, setTargetMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const nameRef = useRef<TextInput>(null);
  const promptRef = useRef<TextInput>(null);

  const typeList = types.length ? types.map((t) => ({ key: t.key, label: t.label })) : FALLBACK_TYPES;

  useEffect(() => {
    if (!connConfig) return;
    if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
    void loadTypes();
    // Targets + models for the pickers (non-fatal on failure).
    (async () => {
      try { setWorkflows((await getWorkflows()).map((w) => ({ id: w.id, name: w.name }))); } catch {}
      try { setTasks((await getScheduledTasks()).map((t) => ({ id: t.id, name: t.name }))); } catch {}
      try { setModels(await listDbModels({ enabledOnly: true, kind: 'llm' })); } catch {}
    })();
    if (isNew || !id) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const ev = await getEvent(id);
        if (!cancelled) {
          setExisting(ev);
          setForm({
            name: ev.name,
            type: ev.type,
            action_kind: ev.action_kind,
            action_ref: ev.action_ref ?? null,
            prompt_template: ev.prompt_template ?? '',
            model: ev.model ?? null,
            session_binding_enabled: Boolean(ev.session_binding_enabled),
            session_binding_path: ev.session_binding_path ?? 'id',
            input_schema: ev.input_schema ?? [],
          });
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connConfig, id, isNew]);

  useEffect(() => {
    if (loading || !field) return;
    const tail = field.split('.').pop() || field;
    const normalized = tail === 'prompt' ? 'prompt_template' : tail;
    const timer = setTimeout(() => {
      if (normalized === 'name') nameRef.current?.focus();
      if (normalized === 'prompt_template') promptRef.current?.focus();
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const element = document.getElementById(`event-field-${normalized}`);
        element?.scrollIntoView({ block: 'center' });
        element?.focus?.({ preventScroll: true });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [field, loading]);

  const modelLabel = useMemo(() => {
    if (!form.model) return 'Auto (default)';
    return models.find((m) => m.runtime_id === form.model)?.display_name || form.model;
  }, [form.model, models]);

  const targetOptions = form.action_kind === 'workflow' ? workflows : tasks;
  const targetLabel = useMemo(() => {
    if (form.action_kind === 'prompt') return '';
    const t = targetOptions.find((x) => x.id === form.action_ref);
    return t?.name || (form.action_ref ? form.action_ref : 'Select…');
  }, [form.action_kind, form.action_ref, targetOptions]);

  const close = () => goBack(router, '/(tabs)/events');

  const handleSave = async () => {
    setLocalError(null);
    const name = form.name.trim();
    if (!name) { setLocalError('Name is required.'); return; }
    if (form.action_kind !== 'prompt' && !form.action_ref) {
      setLocalError('Pick a target for this action.'); return;
    }
    if (form.action_kind === 'prompt' && !form.prompt_template.trim()) {
      setLocalError('A prompt is required for the chat-prompt action.'); return;
    }
    if (form.session_binding_enabled && !form.session_binding_path.trim()) {
      setLocalError('Payload binding needs a payload path.'); return;
    }
    setSaving(true);
    const payload = {
      name,
      type: form.type,
      action_kind: form.action_kind,
      action_ref: form.action_kind === 'prompt' ? null : form.action_ref,
      prompt_template: form.action_kind === 'prompt' ? form.prompt_template : null,
      model: form.model,
      session_binding_enabled: form.session_binding_enabled,
      session_binding_path: form.session_binding_path.trim() || null,
      input_schema: form.input_schema.filter((f) => f.name.trim()),
    };
    if (isNew) {
      const created = await createEvent(payload);
      setSaving(false);
      if (created) {
        // Show the one-time secret in place instead of navigating away, so the
        // user can copy it. Switch the screen into "existing" mode.
        setExisting(created);
        setRevealedSecret(created.secret ?? null);
        // Replace the route id so a save/rotate now targets the created event.
        router.replace(`/events/${created.id}` as any);
      }
    } else {
      const ok = await updateEvent(id, payload);
      setSaving(false);
      if (ok) close();
    }
  };

  const handleRotate = async () => {
    if (!existing) return;
    const ev = await rotateSecret(existing.id);
    if (ev?.secret) setRevealedSecret(ev.secret);
  };

  const handleTest = async () => {
    if (!existing) return;
    await triggerEvent(existing.id, { test: true, ts: Date.now() }, { wait: false });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: isNew ? 'New event' : 'Event',
      headerRight: () => (
        <HeaderAction
          icon="check"
          label={saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
          onPress={handleSave}
          disabled={saving || loading}
        />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, isNew, form, saving, loading]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: headerInset }]}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={[styles.screen, styles.center, { paddingTop: headerInset }]}>
        <Text style={styles.errorMsg}>Failed to load event: {loadError}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: headerInset }]}>
      <SharedPresence kind="event" id={id} />
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {/* Name */}
        <Text style={styles.label}>Name</Text>
        <TextInput
          ref={nameRef}
          nativeID="event-field-name"
          style={styles.input}
          value={form.name}
          onChangeText={(v) => setForm({ ...form, name: v })}
          placeholder="e.g. GitHub push"
          placeholderTextColor={colors.textMuted}
        />

        {/* Webhook type */}
        <Text style={styles.label}>Webhook type</Text>
        <Picker
          value={typeList.find((t) => t.key === form.type)?.label || form.type}
          open={typeMenu}
          onToggle={() => setTypeMenu((o) => !o)}
        />
        {typeMenu && (
          <View style={styles.menu}>
            {typeList.map((t) => (
              <Option
                key={t.key}
                label={t.label}
                active={form.type === t.key}
                onPress={() => { setForm({ ...form, type: t.key }); setTypeMenu(false); }}
              />
            ))}
          </View>
        )}
        <Text style={styles.hint}>
          Controls how a delivery is authenticated. Generic uses the per-event
          secret in a header; GitHub / Stripe / Slack additionally verify the
          provider's signature over the request body.
        </Text>

        {/* Action kind */}
        <Text style={styles.label}>When triggered, this event…</Text>
        <View style={styles.segment}>
          {ACTION_KINDS.map((a) => (
            <Pressable
              key={a.key}
              onPress={() => setForm({ ...form, action_kind: a.key, action_ref: null })}
              style={[styles.segBtn, form.action_kind === a.key && styles.segBtnActive]}
            >
              <Feather name={a.icon} size={13} color={form.action_kind === a.key ? colors.accent : colors.textSecondary} />
              <Text style={[styles.segText, form.action_kind === a.key && styles.segTextActive]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Action target / prompt */}
        {form.action_kind === 'prompt' ? (
          <>
            <Text style={styles.label}>Prompt</Text>
            {Platform.OS === 'web' ? (
              <textarea
                id="event-field-prompt_template"
                value={form.prompt_template}
                onChange={(e: any) => setForm({ ...form, prompt_template: e.target.value })}
                placeholder="What should the agent do? Reference the payload with {{payload.field}}"
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
                nativeID="event-field-prompt_template"
                style={[styles.input, { height: 120, textAlignVertical: 'top' }]}
                value={form.prompt_template}
                onChangeText={(v) => setForm({ ...form, prompt_template: v })}
                placeholder="Prompt — reference the payload with {{payload.field}}"
                placeholderTextColor={colors.textMuted}
                multiline
              />
            )}
            <Text style={styles.hint}>
              The delivered payload is available as {'{{payload.…}}'}. It runs as
              an event run session inside the delivery screen.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.label}>{form.action_kind === 'workflow' ? 'Workflow' : 'Scheduled task'}</Text>
            <Picker value={targetLabel} open={targetMenu} onToggle={() => setTargetMenu((o) => !o)} />
            {targetMenu && (
              <View style={styles.menu}>
                {targetOptions.length === 0 ? (
                  <Text style={styles.emptyOpt}>None available — create one first.</Text>
                ) : targetOptions.map((t) => (
                  <Option
                    key={t.id}
                    label={t.name}
                    active={form.action_ref === t.id}
                    onPress={() => { setForm({ ...form, action_ref: t.id }); setTargetMenu(false); }}
                  />
                ))}
              </View>
            )}
            <Text style={styles.hint}>
              The delivered payload is passed as inputs (reachable in blocks /
              the task prompt).
            </Text>
          </>
        )}

        {/* Event run session binding */}
        <Text style={styles.label}>Event run session</Text>
        <View style={styles.toggleRow}>
          <View style={styles.toggleCopy}>
            <Text style={styles.toggleTitle}>Bind by payload field</Text>
            <Text style={styles.toggleSubtitle}>
              Reuse one internal event run session for deliveries with the same
              payload value. Off creates a fresh run session every time.
            </Text>
          </View>
          <ThemedSwitch
            value={form.session_binding_enabled}
            onValueChange={(value) => setForm({
              ...form,
              session_binding_enabled: value,
              session_binding_path: value && !form.session_binding_path.trim()
                ? 'id'
                : form.session_binding_path,
            })}
          />
        </View>
        {form.session_binding_enabled && (
          <>
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={form.session_binding_path}
              onChangeText={(v) => setForm({ ...form, session_binding_path: v })}
              placeholder="payload path, e.g. id or ticket.id"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={styles.hint}>
              The value at this dot-path is only a lookup key; OpenAgent still
              uses its own internal session id for the run.
            </Text>
          </>
        )}

        {/* Model pin */}
        <Text style={styles.label}>Model</Text>
        <View nativeID="event-field-model">
          <Picker value={modelLabel} muted={!form.model} open={modelMenu} onToggle={() => setModelMenu((o) => !o)} />
        </View>
        {modelMenu && (
          <View style={styles.menu}>
            <Option label="Auto (default)" active={!form.model} onPress={() => { setForm({ ...form, model: null }); setModelMenu(false); }} />
            {models.map((m) => (
              <Option
                key={m.runtime_id}
                label={m.display_name || m.runtime_id}
                active={form.model === m.runtime_id}
                onPress={() => { setForm({ ...form, model: m.runtime_id }); setModelMenu(false); }}
              />
            ))}
          </View>
        )}

        {/* Input schema */}
        <View style={styles.schemaHead}>
          <Text style={[styles.label, { marginBottom: 0 }]}>Input fields (optional)</Text>
          <Pressable onPress={() => setForm({ ...form, input_schema: [...form.input_schema, { name: '', path: '' }] })} style={styles.addField}>
            <Feather name="plus" size={12} color={colors.accent} />
            <Text style={styles.addFieldText}>Add field</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Document the payload you expect — a name and its dot-path (e.g.
          ``pusher.name``). Optional; helps you and the agent read the data.
        </Text>
        {form.input_schema.map((f, i) => (
          <View key={i} style={styles.fieldRow}>
            <TextInput
              style={[styles.input, styles.fieldInput, { marginBottom: 0 }]}
              value={f.name}
              onChangeText={(v) => {
                const next = [...form.input_schema]; next[i] = { ...f, name: v };
                setForm({ ...form, input_schema: next });
              }}
              placeholder="field name"
              placeholderTextColor={colors.textMuted}
            />
            <TextInput
              style={[styles.input, styles.fieldInput, { marginBottom: 0 }]}
              value={f.path || ''}
              onChangeText={(v) => {
                const next = [...form.input_schema]; next[i] = { ...f, path: v };
                setForm({ ...form, input_schema: next });
              }}
              placeholder="payload path"
              placeholderTextColor={colors.textMuted}
            />
            <Pressable
              onPress={() => setForm({ ...form, input_schema: form.input_schema.filter((_, j) => j !== i) })}
              style={styles.removeField}
            >
              <Feather name="x" size={14} color={colors.textMuted} />
            </Pressable>
          </View>
        ))}

        {/* Webhook connection panel (existing events only) */}
        {existing && (
          <WebhookPanel
            ev={existing}
            secret={revealedSecret}
            onRotate={handleRotate}
            onTest={handleTest}
          />
        )}

        {(localError || storeError) && (
          <Text style={styles.errorMsg}>{localError || storeError}</Text>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

function WebhookPanel({
  ev, secret, onRotate, onTest,
}: {
  ev: AgentEvent;
  secret: string | null;
  onRotate: () => void;
  onTest: () => void;
}) {
  const url = ev.webhook_url || `<public-url>${ev.webhook_path}`;
  const secretDisplay = secret || `whsec_…${ev.secret_hint ?? '????'}`;
  const curl =
    `curl -X POST ${url} \\\n` +
    `  -H 'X-OpenAgent-Event-Secret: ${secret || '<secret>'}' \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '{"hello":"world"}'`;

  const copy = (text: string) => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
  };

  return (
    <View style={styles.panel}>
      <View style={styles.panelHead}>
        <Feather name="link" size={14} color={colors.accent} />
        <Text style={styles.panelTitle}>Webhook</Text>
      </View>

      <Text style={styles.panelLabel}>Endpoint</Text>
      <Pressable onPress={() => copy(url)} style={styles.codeBox}>
        <Text style={styles.code} numberOfLines={2}>{url}</Text>
        <Feather name="copy" size={13} color={colors.textMuted} />
      </Pressable>
      {!ev.webhook_url && (
        <Text style={styles.hint}>
          Set the public URL in Settings → Channels → Webhook to get a complete,
          copy-pasteable address.
        </Text>
      )}

      <Text style={styles.panelLabel}>Secret</Text>
      {secret ? (
        <View style={styles.secretRevealed}>
          <Feather name="eye" size={12} color={colors.warning} />
          <Text style={styles.code} selectable numberOfLines={1}>{secretDisplay}</Text>
          <Pressable onPress={() => copy(secret)}><Feather name="copy" size={13} color={colors.textMuted} /></Pressable>
        </View>
      ) : (
        <Text style={styles.secretHidden}>{secretDisplay} — shown only once at creation.</Text>
      )}
      {secret && (
        <Text style={[styles.hint, { color: colors.warning }]}>
          Copy this now — it won't be shown again. Rotate to generate a new one.
        </Text>
      )}

      <Text style={styles.panelLabel}>Example</Text>
      <Pressable onPress={() => copy(curl)} style={styles.codeBox}>
        <Text style={styles.code} numberOfLines={4}>{curl}</Text>
        <Feather name="copy" size={13} color={colors.textMuted} />
      </Pressable>

      <View style={styles.panelActions}>
        <Pressable onPress={onTest} style={styles.panelBtn}>
          <Feather name="play" size={13} color={colors.accent} />
          <Text style={styles.panelBtnText}>Send test delivery</Text>
        </Pressable>
        <Pressable onPress={onRotate} style={styles.panelBtn}>
          <Feather name="refresh-cw" size={13} color={colors.textSecondary} />
          <Text style={styles.panelBtnText}>Rotate secret</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Picker({
  value, open, onToggle, muted,
}: { value: string; open: boolean; onToggle: () => void; muted?: boolean }) {
  return (
    <Pressable style={styles.pickerBox} onPress={onToggle} accessibilityRole="button">
      <Text style={[styles.pickerValue, muted && styles.pickerValueMuted]} numberOfLines={1}>{value}</Text>
      <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
    </Pressable>
  );
}

function Option({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.optionRow} accessibilityRole="button">
      <Text style={[styles.optionLabel, active && styles.optionLabelActive]} numberOfLines={1}>{label}</Text>
      {active ? <Feather name="check" size={15} color={colors.accent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { flex: 1 },
  bodyContent: { padding: 20, maxWidth: 640, width: '100%', alignSelf: 'center' },
  label: {
    fontSize: 11, fontWeight: '600', color: colors.textSecondary,
    marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14,
  },
  input: {
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 9,
    color: colors.text, fontSize: 12, fontFamily: font.mono,
  },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 16 },
  errorMsg: { marginTop: 12, fontSize: 12, color: colors.error },

  segment: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  segBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg,
  },
  segBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  segText: { color: colors.textSecondary, fontSize: 12, fontWeight: '500' },
  segTextActive: { color: colors.accent, fontWeight: '600' },

  pickerBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 10, gap: 8,
  },
  pickerValue: { flex: 1, color: colors.text, fontSize: 12 },
  pickerValueMuted: { color: colors.textSecondary },
  menu: {
    marginTop: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg, overflow: 'hidden',
  },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 11, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  optionLabel: { flex: 1, color: colors.text, fontSize: 12 },
  optionLabelActive: { color: colors.accent, fontWeight: '600' },
  emptyOpt: { color: colors.textMuted, fontSize: 12, padding: 11 },

  schemaHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  addField: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addFieldText: { color: colors.accent, fontSize: 12, fontWeight: '500' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  fieldInput: { flex: 1 },
  removeField: { padding: 6 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, paddingHorizontal: 11, paddingVertical: 10,
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  toggleCopy: { flex: 1, gap: 3 },
  toggleTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
  toggleSubtitle: { color: colors.textMuted, fontSize: 11, lineHeight: 15 },

  panel: {
    marginTop: 20, padding: 14, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, gap: 6,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  panelTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  panelLabel: {
    fontSize: 10, fontWeight: '600', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 10,
  },
  codeBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 10, marginTop: 4,
  },
  code: { flex: 1, color: colors.text, fontSize: 11, fontFamily: font.mono, lineHeight: 16 },
  secretRevealed: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.warning, padding: 10, marginTop: 4,
  },
  secretHidden: { color: colors.textMuted, fontSize: 11, fontFamily: font.mono, marginTop: 4 },
  panelActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  panelBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 11, paddingVertical: 8, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg,
  },
  panelBtnText: { color: colors.textSecondary, fontSize: 12, fontWeight: '500' },
});
