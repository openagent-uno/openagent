import { colors, font, radius } from '../../theme';
/**
 * Model screen — v0.12 vocabulary.
 *
 * Three concepts on this screen:
 *   - **provider row** (anthropic+api-based, openai+api-based…)
 *                      — a (name, framework) pair in the ``providers``
 *                      table, keyed on a surrogate integer ``id``.
 *   - **model**        (gpt-4o-mini, claude-sonnet-4-6, glm-5…) — the bare
 *                      vendor id. Lives in ``models.model`` with a
 *                      ``provider_id`` FK to ``providers.id``.
 *   - **runtime_id**   the derived composite string used in logs + session
 *                      pins — ``<provider>:<model>``.
 *
 * Add flow: pick a provider row → server does /api/models/available?
 * provider_id=N to surface the vendor's catalog → multi-pick → POST
 * /api/models with {provider_id, model}.
 */

import Feather from '@expo/vector-icons/Feather';
import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native';
import { useConnection } from '../../stores/connection';
import {
  setBaseUrl,
  getProviders, addProvider, deleteProvider, testProvider, updateProvider,
  listDbModels, deleteDbModel, enableDbModel, disableDbModel,
  createDbModel, updateDbModel, listAvailableModels,
  setClassifierModel, unsetClassifierModel,
  getUsage, getDailyUsage,
} from '../../services/api';
import Button from '../../components/Button';
import Card from '../../components/Card';
import ThemedSwitch from '../../components/ThemedSwitch';
import TabStrip from '../../components/TabStrip';
import { useHeaderInset } from '../../components/screenHeader';
import { useConfirm } from '../../components/ConfirmDialog';
import type {
  UsageData, DailyUsageEntry, ModelEntry, AvailableModel,
  ProviderConfig, ModelFramework,
} from '../../../common/types';

// Sampling params the server reads off a model row. The whitelist is the
// server's, deliberately narrow: sampling only, never credentials or
// endpoints — a model row must not be able to redirect traffic.
//
// This matters beyond tuning. `extra_kwargs` is keyed by PROVIDER, so two
// models on one provider could never differ, and a provider that sends no
// temperature inherits the backend's own default in silence — llama.cpp's
// is 0.8, which is exactly the setting that turns "I can't verify that"
// into an invented answer. Leave a field empty to inherit; set it to pin.
const SAMPLING_FIELDS: {
  key: string; label: string; placeholder: string; integer?: boolean;
}[] = [
  { key: 'temperature', label: 'Temperature', placeholder: 'e.g. 0.2' },
  { key: 'top_p', label: 'Top P', placeholder: 'e.g. 0.9' },
  { key: 'top_k', label: 'Top K', placeholder: 'e.g. 40', integer: true },
  { key: 'min_p', label: 'Min P', placeholder: 'e.g. 0.05' },
  { key: 'max_tokens', label: 'Max tokens', placeholder: 'e.g. 4096', integer: true },
  { key: 'presence_penalty', label: 'Presence penalty', placeholder: 'e.g. 0' },
  { key: 'frequency_penalty', label: 'Frequency penalty', placeholder: 'e.g. 0' },
  { key: 'repeat_penalty', label: 'Repeat penalty', placeholder: 'e.g. 1.1' },
  { key: 'seed', label: 'Seed', placeholder: 'e.g. 42', integer: true },
];

/**
 * Which slice of the model screen to render. The screen is no longer a
 * standalone tabbed page — it's embedded under Settings as two of its
 * section pills:
 *   - ``manage`` — providers + models merged into one panel.
 *   - ``costs``  — the daily-spend breakdown (its own Settings pill).
 */
type ModelView = 'manage' | 'costs';

const FALLBACK_PROVIDERS = [
  'anthropic', 'openai', 'google', 'zai', 'groq', 'mistral',
  'xai', 'deepseek', 'cerebras', 'openrouter', 'local',
  // Audio-only vendors. They ship via litellm dispatch, so the framework
  // chip auto-flips to "litellm" when one of these is picked.
  'elevenlabs', 'deepgram', 'azure',
];

// Vendors that don't speak any LLM API — picking them in the Providers
// form should default the framework to litellm (TTS/STT only).
const AUDIO_ONLY_VENDORS = new Set(['elevenlabs', 'deepgram']);

export default function ModelScreen({ view = 'manage', embedded = false }: { view?: ModelView; embedded?: boolean } = {}) {
  const connConfig = useConnection((s) => s.config);
  const confirm = useConfirm();
  // Standalone (Model tab) draws behind the transparent header and offsets
  // its own content; when embedded in Settings the parent already insets.
  const headerInset = useHeaderInset();

  // Providers (DB, one row per (name, framework) pair)
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; error?: string }>>({});
  const [testingProv, setTestingProv] = useState<number | null>(null);

  const [addingProv, setAddingProv] = useState(false);
  const [newProvName, setNewProvName] = useState('');
  const [newProvFramework, setNewProvFramework] = useState<ModelFramework>('api-based');
  const [newProvKey, setNewProvKey] = useState('');
  const [newProvUrl, setNewProvUrl] = useState('');

  // Models (DB)
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [addingModel, setAddingModel] = useState(false);
  // The provider-row selected in the Add Model dialog.
  const [addProviderId, setAddProviderId] = useState<number | null>(null);
  const [available, setAvailable] = useState<AvailableModel[]>([]);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  // Optional display_name + tier_hint applied to every model registered
  // from this Add Model session — tier_hint feeds the leader's specialist
  // picker in Team-as-router. Reset when the dialog closes.
  const [addName, setAddName] = useState('');
  const [addTierHint, setAddTierHint] = useState('');

  // Per-row edit panel — only one row's display_name/tier_hint is open at
  // a time. ``editingModelId`` is the row id; the two draft strings hold
  // the in-flight values until the user hits save.
  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  // Sampling params, held as raw strings so an empty field is
  // distinguishable from a zero — clearing one means "drop the override
  // and inherit the provider default", which is not the same as 0.
  const [editSampling, setEditSampling] = useState<Record<string, string>>({});
  // Model id typed by hand. Discovery only works when the endpoint can list
  // its catalogue; a subscription proxy or a self-hosted server often can't,
  // and without this the Add Model form was a dead end for exactly the
  // providers this app is most used with.
  const [addManualId, setAddManualId] = useState('');
  const [editName, setEditName] = useState('');
  const [editTierHint, setEditTierHint] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Usage
  const [_usage, setUsage] = useState<UsageData | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageEntry[]>([]);
  const [costDays, setCostDays] = useState(7);

  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!connConfig) return;
    // Four independent fetches — fire in parallel so the screen doesn't
    // serialise network latency. ``allSettled`` keeps a slow /api/usage
    // from blocking the providers/models panels on first render.
    const [provs, dbModels, usageRes, dailyRes] = await Promise.allSettled([
      getProviders(),
      listDbModels(),
      getUsage(),
      getDailyUsage(costDays),
    ]);
    if (provs.status === 'fulfilled') setProviders(provs.value || []);
    if (dbModels.status === 'fulfilled') setModels(dbModels.value);
    else setError(dbModels.reason?.message || String(dbModels.reason));
    if (usageRes.status === 'fulfilled') setUsage(usageRes.value);
    if (dailyRes.status === 'fulfilled') setDailyUsage(dailyRes.value);
  }, [connConfig, costDays]);

  useEffect(() => {
    if (connConfig) {
      if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
      reload();
    }
  }, [connConfig, reload]);

  // ── Provider ops ──

  const submitAddProvider = async () => {
    if (!newProvName.trim()) return;
    const key = newProvKey.trim() || undefined;
    try {
      await addProvider({
        name: newProvName.trim(),
        framework: newProvFramework,
        api_key: key,
        base_url: newProvUrl.trim() || undefined,
      });
      setAddingProv(false);
      setNewProvName('');
      setNewProvFramework('api-based');
      setNewProvKey('');
      setNewProvUrl('');
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const removeProvider = async (p: ProviderConfig) => {
    const ok = await confirm({
      title: 'Remove provider',
      message: `Remove provider "${p.name}" (${p.framework})?\n\nAll models registered under this row are cascade-deleted.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    await deleteProvider(p.id);
    await reload();
  };

  const testProv = async (p: ProviderConfig) => {
    setTestingProv(p.id);
    try {
      const r = await testProvider(p.id);
      setTestResults((prev) => ({ ...prev, [p.id]: r }));
    } catch (e: any) {
      setTestResults((prev) => ({ ...prev, [p.id]: { ok: false, error: e?.message || String(e) } }));
    }
    setTestingProv(null);
  };

  // ── Model ops ──

  const openAddModel = async (providerId: number) => {
    setAddProviderId(providerId);
    setAddingModel(true);
    setLoadingAvailable(true);
    try {
      const entries = await listAvailableModels(providerId);
      setAvailable(entries);
    } catch (e: any) {
      setAvailable([]);
      setError(e?.message || String(e));
    }
    setLoadingAvailable(false);
  };

  const registerModel = async (entry: AvailableModel) => {
    if (addProviderId == null) return;
    // Empty strings are dropped from the payload so the server stores
    // NULL — never "" — for routing metadata. Same rule applies to the
    // edit panel below. The user-supplied ``addName`` overrides the
    // discovery display_name when present.
    const name = addName.trim();
    const tierHint = addTierHint.trim();
    try {
      await createDbModel({
        provider_id: addProviderId,
        model: entry.id,
        display_name: name || entry.display_name || undefined,
        // ``kind`` comes straight from discovery — ``tts-1`` lands as
        // kind=tts, ``whisper-1`` as kind=stt, everything else as llm.
        kind: entry.kind ?? 'llm',
        ...(tierHint ? { tier_hint: tierHint } : {}),
      });
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const openEditModel = (m: ModelEntry) => {
    setEditingModelId(m.id);
    setEditName(m.display_name ?? '');
    setEditTierHint(m.tier_hint ?? '');
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const seeded: Record<string, string> = {};
    for (const f of SAMPLING_FIELDS) {
      const v = meta[f.key];
      seeded[f.key] = v === undefined || v === null ? '' : String(v);
    }
    setEditSampling(seeded);
  };

  const cancelEditModel = () => {
    setEditingModelId(null);
    setEditName('');
    setEditTierHint('');
    setEditSampling({});
  };

  const saveEditModel = async (m: ModelEntry) => {
    setSavingEdit(true);
    try {
      const name = editName.trim();
      const tier = editTierHint.trim();
      // Merge into the row's existing metadata rather than replacing it:
      // the same object carries non-sampling keys (a tts row's voice_id,
      // a self-hosted row's local flag) that must survive an edit here.
      const metadata: Record<string, unknown> = { ...((m.metadata ?? {}) as Record<string, unknown>) };
      for (const f of SAMPLING_FIELDS) {
        const raw = (editSampling[f.key] ?? '').trim();
        if (!raw) {
          // Emptied → drop the override so the provider default applies.
          delete metadata[f.key];
          continue;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new Error(`${f.label} must be a number (got "${raw}")`);
        }
        metadata[f.key] = f.integer ? Math.round(parsed) : parsed;
      }
      await updateDbModel(m.id, {
        display_name: name ? name : null,
        tier_hint: tier ? tier : null,
        metadata,
      });
      await reload();
      cancelEditModel();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSavingEdit(false);
    }
  };

  // Disabling a provider takes its whole model set out of routing in one
  // move, without deleting anything — the credential and the rows stay,
  // they just stop being reachable. Useful when a key is rotating or a
  // backend is down, where deleting the provider would cascade its models.
  const toggleProvider = async (p: ProviderConfig) => {
    try {
      await updateProvider(p.id, { enabled: !p.enabled });
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const toggleModel = async (m: ModelEntry) => {
    try {
      if (m.enabled) await disableDbModel(m.id);
      else await enableDbModel(m.id);
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  // Flip the is_classifier flag on this row only — i.e. mark it the
  // default router (the entry model that leads a turn when the session
  // has no pin). Multiple rows may carry the flag simultaneously; only
  // the first enabled one in catalog order actually leads, the rest are
  // ordered fallbacks for when it's disabled. Toggling here is a narrow
  // PUT that never touches other rows.
  const toggleClassifier = async (m: ModelEntry) => {
    try {
      if (m.is_classifier) await unsetClassifierModel(m.id);
      else await setClassifierModel(m.id);
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const removeModel = async (m: ModelEntry) => {
    const ok = await confirm({
      title: 'Remove model',
      message: `Remove "${m.runtime_id}"?`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await deleteDbModel(m.id);
      await reload();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  // ── Renders ──

  const renderProviders = () => {
    const existingKeys = new Set(providers.map((p) => `${p.name}:${p.framework}`));
    const duplicate = newProvName
      && existingKeys.has(`${newProvName}:${newProvFramework}`);

    return (
      <>
        <Text style={styles.sectionTitle}>Providers</Text>
        <Text style={styles.hint}>
          Each row is a (vendor, framework) pair. Add a vendor with its API
          key; audio vendors (TTS/STT) use the litellm framework.
        </Text>

        {providers.map((p) => (
          <View key={p.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.providerName}>
                {p.name}
                <Text style={styles.providerFramework}>  ·  {p.framework}</Text>
              </Text>
              <View style={styles.cardActions}>
                <TouchableOpacity onPress={() => testProv(p)} disabled={testingProv === p.id}>
                  <Text style={styles.actionLink}>{testingProv === p.id ? '…' : 'Test'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => removeProvider(p)}>
                  <Text style={[styles.actionLink, { color: colors.error }]}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={styles.keyDisplay}>
              Key: {p.api_key_display}
            </Text>
            {p.base_url && <Text style={styles.keyDisplay}>URL: {p.base_url}</Text>}
            {testResults[p.id] && (
              <Text style={testResults[p.id].ok ? styles.testOk : styles.testFail}>
                {testResults[p.id].ok ? 'Connection OK' : `Failed: ${testResults[p.id].error}`}
              </Text>
            )}
          </View>
        ))}

        {addingProv ? (
          <View style={styles.card}>
            <Text style={styles.label}>Vendor</Text>
            <TextInput
              style={[styles.input, { marginBottom: 8 }]}
              value={newProvName}
              onChangeText={setNewProvName}
              placeholder="Type or pick below"
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.chipRow}>
              {FALLBACK_PROVIDERS.map((p) => (
                <TouchableOpacity
                  key={p}
                  style={[styles.chip, newProvName === p && styles.chipActive]}
                  onPress={() => {
                    setNewProvName(p);
                    // Audio-only vendors default to litellm; everything
                    // else to api-based.
                    if (AUDIO_ONLY_VENDORS.has(p)) {
                      setNewProvFramework('litellm');
                    } else {
                      setNewProvFramework('api-based');
                    }
                  }}
                >
                  <Text style={[styles.chipText, newProvName === p && styles.chipTextActive]}>{p}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>Framework</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.chip, newProvFramework === 'api-based' && styles.chipActive]}
                onPress={() => setNewProvFramework('api-based')}
              >
                <Text style={[styles.chipText, newProvFramework === 'api-based' && styles.chipTextActive]}>API (default)</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.chip, newProvFramework === 'litellm' && styles.chipActive]}
                onPress={() => setNewProvFramework('litellm')}
              >
                <Text style={[styles.chipText, newProvFramework === 'litellm' && styles.chipTextActive]}>
                  litellm (TTS/STT)
                </Text>
              </TouchableOpacity>
            </View>
            {duplicate && (
              <Text style={styles.warnText}>
                {newProvName} already exists under {newProvFramework}. Pick another framework.
              </Text>
            )}
            <Text style={styles.label}>API Key</Text>
            <TextInput
              style={styles.input}
              value={newProvKey}
              onChangeText={setNewProvKey}
              placeholder="sk-..."
              placeholderTextColor={colors.textMuted}
              secureTextEntry
            />
            <Text style={styles.label}>Base URL (optional)</Text>
            <TextInput
              style={styles.input}
              value={newProvUrl}
              onChangeText={setNewProvUrl}
              placeholder="https://api.example.com/v1"
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.formRow}>
              <TouchableOpacity onPress={() => {
                setAddingProv(false); setNewProvName('');
                setNewProvFramework('api-based'); setNewProvKey(''); setNewProvUrl('');
              }}>
                <Text style={{ color: colors.textMuted }}>Cancel</Text>
              </TouchableOpacity>
              <Button
                variant="primary" size="md" label="Add"
                onPress={submitAddProvider}
                disabled={!newProvName.trim() || !!duplicate}
              />
            </View>
          </View>
        ) : (
          <TouchableOpacity style={styles.addBtn} onPress={() => setAddingProv(true)}>
            <View style={styles.addBtnContent}>
              <Feather name="plus" size={14} color={colors.primary} />
              <Text style={styles.addBtnText}>Add Provider</Text>
            </View>
          </TouchableOpacity>
        )}
      </>
    );
  };

  const renderModels = () => {
    // Group by provider row id so each (vendor, framework) pair owns a card.
    const byProviderId = new Map<number, ModelEntry[]>();
    for (const m of models) {
      const bucket = byProviderId.get(m.provider_id) ?? [];
      bucket.push(m);
      byProviderId.set(m.provider_id, bucket);
    }

    const noProviders = providers.length === 0;
    const noModels = models.length === 0;
    const selectedProvider = addProviderId != null
      ? providers.find((p) => p.id === addProviderId) ?? null
      : null;

    return (
      <>
        <Text style={styles.sectionTitle}>Models</Text>
        <Text style={styles.hint}>
          Each row is a (provider_row, model) pair. Every turn starts at the router — it answers
          directly, or delegates to the other enabled models based on their tier hints.
        </Text>

        {/* Empty-state hint: no providers → no models possible. The
            Providers section with its add form sits directly above. */}
        {noProviders && noModels && (
          <Card>
            <Text style={styles.emptyStateTitle}>No providers configured</Text>
            <Text style={styles.emptyStateBody}>
              Add a provider row above first (framework=api-based) and supply
              its API key — then register models against it here.
            </Text>
          </Card>
        )}

        {providers.map((p) => {
          const rows = byProviderId.get(p.id) ?? [];
          // A provider with no models used to vanish from this list, so a
          // freshly added one looked like it had failed — and now that the
          // header carries the enable switch, hiding it would also hide the
          // only control for that credential. Render it with an empty note.
          return (
            <View key={p.id} style={{ marginBottom: 14 }}>
              <View style={styles.providerHeaderRow}>
                <Text style={[styles.frameworkHeader, !p.enabled && styles.frameworkHeaderOff]}>
                  {p.name}
                  <Text style={styles.frameworkSub}>  ·  {p.framework}</Text>
                  {!p.enabled && <Text style={styles.providerOffTag}>  ·  off</Text>}
                </Text>
                <ThemedSwitch value={!!p.enabled} onValueChange={() => toggleProvider(p)} />
              </View>
              <Card padded={false}>
                {rows.length === 0 && (
                  <Text style={styles.providerEmpty}>
                    No models registered under this provider yet.
                  </Text>
                )}
                {rows.map((m, i) => {
                  const isEditing = editingModelId === m.id;
                  // Only LLM rows feed the Team-as-router specialist
                  // picker, so the tier/description editor is hidden
                  // on tts/stt rows where the field has no consumer.
                  const editable = (m.kind ?? 'llm') === 'llm';
                  return (
                    <View key={m.id}>
                      <View style={[styles.row, i > 0 && styles.rowBorder]}>
                        <View style={styles.rowInfo}>
                          <Text style={styles.rowTitle}>
                            <Text style={styles.rowModel}>{m.display_name || m.model}</Text>
                            {m.kind && m.kind !== 'llm' && (
                              <>
                                <Text style={styles.rowSep}>  ·  </Text>
                                <Text style={styles.kindBadge}>{m.kind.toUpperCase()}</Text>
                              </>
                            )}
                            {m.is_classifier && (
                              <>
                                <Text style={styles.rowSep}>  ·  </Text>
                                <Text style={styles.routerTag}>default router</Text>
                              </>
                            )}
                          </Text>
                          {m.display_name && (
                            <Text style={styles.rowModelId}>{m.model}</Text>
                          )}
                          {m.kind === 'tts' ? (
                            <Text style={styles.rowMeta}>
                              voice: {((m.metadata as Record<string, unknown>)?.voice_id as string) ?? '—'}
                              {(m.metadata as Record<string, unknown>)?.voice_id_source === 'default' && (
                                <Text style={styles.rowMetaMuted}> (default)</Text>
                              )}
                            </Text>
                          ) : m.kind === 'stt' ? (
                            <Text style={styles.rowMeta}>transcription</Text>
                          ) : (m.input_cost_per_million || m.output_cost_per_million) ? (
                            <Text style={styles.rowMeta}>
                              ${m.input_cost_per_million ?? '-'} / ${m.output_cost_per_million ?? '-'} per M
                            </Text>
                          ) : (
                            <Text style={styles.rowMeta}>no pricing</Text>
                          )}
                          {m.tier_hint && (
                            <Text style={styles.rowTierHint}>{m.tier_hint}</Text>
                          )}
                        </View>
                        {editable && (
                          <TouchableOpacity
                            style={styles.classifierBtn}
                            onPress={() => (isEditing ? cancelEditModel() : openEditModel(m))}
                            accessibilityLabel={
                              isEditing ? 'Close edit panel' : 'Edit tier hint and description'
                            }
                          >
                            <Feather
                              name="edit-2"
                              size={13}
                              color={isEditing ? colors.primary : colors.textMuted}
                            />
                          </TouchableOpacity>
                        )}
                        {editable && (
                          <TouchableOpacity
                            style={styles.classifierBtn}
                            onPress={() => toggleClassifier(m)}
                            accessibilityLabel={
                              m.is_classifier ? 'Clear default router' : 'Set as default router'
                            }
                          >
                            <Feather
                              name="git-branch"
                              size={14}
                              color={m.is_classifier ? colors.primary : colors.textMuted}
                            />
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity style={styles.toggleBtn} onPress={() => toggleModel(m)}>
                          <View style={[styles.toggleDot, m.enabled ? styles.toggleOn : styles.toggleOff]} />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.removeBtn} onPress={() => removeModel(m)}>
                          <Feather name="x" size={14} color={colors.textMuted} />
                        </TouchableOpacity>
                      </View>
                      {isEditing && (
                        <View style={styles.editPanel}>
                          <Text style={styles.label}>Name</Text>
                          <TextInput
                            style={styles.input}
                            value={editName}
                            onChangeText={setEditName}
                            placeholder="Opus (coding)"
                            placeholderTextColor={colors.textMuted}
                          />
                          <Text style={styles.label}>Tier hint</Text>
                          <TextInput
                            style={styles.input}
                            value={editTierHint}
                            onChangeText={setEditTierHint}
                            placeholder="best for coding, complex reasoning"
                            placeholderTextColor={colors.textMuted}
                          />
                          <Text style={styles.label}>Sampling</Text>
                          <Text style={styles.samplingHint}>
                            Empty inherits the provider default. Set a value to
                            pin it for this model only.
                          </Text>
                          <View style={styles.samplingGrid}>
                            {SAMPLING_FIELDS.map((f) => (
                              <View key={f.key} style={styles.samplingField}>
                                <Text style={styles.samplingLabel}>{f.label}</Text>
                                <TextInput
                                  style={[styles.input, styles.samplingInput]}
                                  value={editSampling[f.key] ?? ''}
                                  onChangeText={(v) =>
                                    setEditSampling((prev) => ({ ...prev, [f.key]: v }))
                                  }
                                  placeholder={f.placeholder}
                                  placeholderTextColor={colors.textMuted}
                                  keyboardType="numeric"
                                  autoCapitalize="none"
                                />
                              </View>
                            ))}
                          </View>
                          <View style={styles.formRow}>
                            <TouchableOpacity onPress={cancelEditModel} disabled={savingEdit}>
                              <Text style={{ color: colors.textMuted }}>Cancel</Text>
                            </TouchableOpacity>
                            <Button
                              variant="primary"
                              size="md"
                              label={savingEdit ? 'Saving…' : 'Save'}
                              onPress={() => saveEditModel(m)}
                              disabled={savingEdit}
                            />
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}
              </Card>
            </View>
          );
        })}

        {addingModel ? (
          <Card>
            <Text style={styles.label}>Provider row</Text>
            <View style={styles.chipRow}>
              {providers.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.chip, addProviderId === p.id && styles.chipActive]}
                  onPress={() => openAddModel(p.id)}
                >
                  <Text style={[styles.chipText, addProviderId === p.id && styles.chipTextActive]}>
                    {p.name}  ·  {p.framework}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {selectedProvider && (
              <>
                <Text style={styles.label}>Name (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={addName}
                  onChangeText={setAddName}
                  placeholder="Opus (coding)"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={styles.label}>Tier hint (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={addTierHint}
                  onChangeText={setAddTierHint}
                  placeholder="best for coding, complex reasoning"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={styles.hintInline}>
                  Applied to every model picked in this session. Tier hint
                  feeds the leader's specialist picker — leave blank to skip.
                </Text>

                <Text style={styles.label}>
                  Available from {selectedProvider.name} ({selectedProvider.framework})
                </Text>
                {loadingAvailable ? (
                  <Text style={styles.emptyText}>Loading…</Text>
                ) : available.length === 0 ? (
                  <Text style={styles.emptyText}>
                    This endpoint didn't list a catalogue — add the model id by hand below.
                  </Text>
                ) : (
                  <View style={{ gap: 4 }}>
                    {available.map((a) => (
                      <TouchableOpacity
                        key={a.id}
                        style={styles.pickerItem}
                        onPress={() => registerModel(a)}
                        disabled={a.added}
                      >
                        <Text style={styles.pickerItemText}>
                          {a.id}
                          {a.kind && a.kind !== 'llm' && (
                            <Text style={styles.kindBadgeInline}>  {a.kind.toUpperCase()}</Text>
                          )}
                        </Text>
                        <Text style={styles.pickerItemMeta}>
                          {a.added ? 'added' : a.display_name || ''}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                <Text style={styles.label}>Or enter a model id</Text>
                <View style={styles.manualRow}>
                  <TextInput
                    style={[styles.input, styles.manualInput]}
                    value={addManualId}
                    onChangeText={setAddManualId}
                    placeholder="gpt-5.6-sol"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Button
                    variant="secondary"
                    size="md"
                    label="Add"
                    disabled={!addManualId.trim()}
                    onPress={() => {
                      const id = addManualId.trim();
                      if (!id) return;
                      // Typed ids are always llm: the tts/stt inference is a
                      // property of discovery's naming, not of a free string.
                      void registerModel({ id, display_name: '', kind: 'llm' });
                      setAddManualId('');
                    }}
                  />
                </View>
              </>
            )}

            <View style={[styles.formRow, { marginTop: 10 }]}>
              <TouchableOpacity onPress={() => {
                setAddingModel(false); setAddProviderId(null); setAvailable([]);
                setAddName(''); setAddTierHint('');
              }}>
                <Text style={{ color: colors.textMuted }}>Close</Text>
              </TouchableOpacity>
            </View>
          </Card>
        ) : (
          <TouchableOpacity style={styles.addBtn} onPress={() => setAddingModel(true)}>
            <View style={styles.addBtnContent}>
              <Feather name="plus" size={14} color={colors.primary} />
              <Text style={styles.addBtnText}>Add Model</Text>
            </View>
          </TouchableOpacity>
        )}
      </>
    );
  };

  const renderCosts = () => (
    <>
      <Text style={styles.sectionTitle}>Costs</Text>
      <Card>
        <TabStrip
          tabs={[{ id: '7', label: '7d' }, { id: '30', label: '30d' }]}
          active={String(costDays)}
          onChange={(v) => setCostDays(parseInt(v, 10))}
          size="sm"
          style={{ marginBottom: 12 }}
        />
        {dailyUsage.length > 0 ? (
          <>
            <View style={styles.costSummary}>
              <View style={styles.costStat}>
                <Text style={styles.costStatValue}>${dailyUsage.reduce((s, e) => s + e.cost, 0).toFixed(3)}</Text>
                <Text style={styles.costStatLabel}>Total</Text>
              </View>
              <View style={styles.costStat}>
                <Text style={styles.costStatValue}>{dailyUsage.reduce((s, e) => s + e.request_count, 0)}</Text>
                <Text style={styles.costStatLabel}>Requests</Text>
              </View>
              <View style={styles.costStat}>
                <Text style={styles.costStatValue}>
                  {(dailyUsage.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0) / 1000).toFixed(0)}K
                </Text>
                <Text style={styles.costStatLabel}>Tokens</Text>
              </View>
            </View>
            <View style={styles.costTable}>
              <View style={styles.costHeaderRow}>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 1.2 }]}>Date</Text>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 2 }]}>Model</Text>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 0.6 }]}>Req</Text>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 1 }]}>Cost</Text>
              </View>
              {dailyUsage.slice(0, 20).map((e, i) => (
                <View key={i} style={styles.costRow}>
                  <Text style={[styles.costCell, { flex: 1.2 }]}>{e.date.slice(5)}</Text>
                  <Text style={[styles.costCell, { flex: 2 }]} numberOfLines={1}>{e.model}</Text>
                  <Text style={[styles.costCell, { flex: 0.6 }]}>{e.request_count}</Text>
                  <Text style={[styles.costCell, { flex: 1 }]}>${e.cost.toFixed(4)}</Text>
                </View>
              ))}
            </View>
          </>
        ) : (
          <Text style={styles.emptyText}>No usage data yet.</Text>
        )}
      </Card>
    </>
  );

  // The screen renders as a single panel — no internal tab strip. Settings
  // owns the section switching: ``manage`` (providers + models merged) and
  // ``costs`` are two of its pills.
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, !embedded && { paddingTop: headerInset + 24 }]}
    >
      {error && <Text style={styles.error}>{error}</Text>}
      {view === 'costs' ? (
        renderCosts()
      ) : (
        <>
          {renderProviders()}
          <View style={{ height: 28 }} />
          {renderModels()}
        </>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, maxWidth: 640, width: '100%', alignSelf: 'center' },

  sectionTitle: {
    fontSize: 18, fontWeight: '500', color: colors.text, marginBottom: 4,
    fontFamily: font.display, letterSpacing: -0.3,
  },
  hint: { fontSize: 12, color: colors.textMuted, marginBottom: 14, lineHeight: 17 },
  error: { color: colors.error, fontSize: 12, marginBottom: 10 },

  label: {
    fontSize: 10, fontWeight: '600', color: colors.textSecondary,
    marginBottom: 5, marginTop: 8,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.inputBg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, paddingVertical: 9,
    color: colors.text, fontSize: 13, fontFamily: font.mono,
  },
  hintInline: {
    fontSize: 11, color: colors.textMuted, marginTop: 6, marginBottom: 4, lineHeight: 15,
  },

  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardActions: { flexDirection: 'row', gap: 12 },
  providerName: {
    fontSize: 14, fontWeight: '600', color: colors.text,
    fontFamily: font.mono, letterSpacing: -0.1,
  },
  providerFramework: {
    fontSize: 11, fontWeight: '400', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1,
  },
  warnText: {
    fontSize: 11, color: colors.error, marginTop: 6, marginBottom: 2,
  },
  actionLink: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  keyDisplay: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontFamily: font.mono },
  testOk: { fontSize: 11, color: colors.success, marginTop: 6 },
  testFail: { fontSize: 11, color: colors.error, marginTop: 6 },
  kindBadge: {
    fontSize: 9, fontWeight: '700', color: colors.primary,
    fontFamily: font.mono, letterSpacing: 0.5,
  },
  kindBadgeInline: {
    fontSize: 9, fontWeight: '700', color: colors.primary,
    fontFamily: font.mono, letterSpacing: 0.5,
  },

  addBtn: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
    borderRadius: radius.lg, paddingVertical: 12, marginTop: 4, alignItems: 'center',
  },
  addBtnContent: { flexDirection: 'row', alignItems: 'center' },
  addBtnText: { fontSize: 13, color: colors.primary, fontWeight: '600', marginLeft: 6 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, marginBottom: 4 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 11, color: colors.textSecondary, fontFamily: font.mono },
  chipTextActive: { color: colors.textInverse, fontWeight: '600' },

  formRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },

  frameworkHeader: {
    fontSize: 11, color: colors.textMuted, marginBottom: 4, marginTop: 6,
    textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700',
  },
  frameworkSub: {
    fontSize: 10, color: colors.textMuted, fontWeight: '400',
    textTransform: 'none', letterSpacing: 0,
  },
  emptyText: { padding: 10, fontSize: 12, color: colors.textMuted, textAlign: 'center' },
  emptyStateTitle: {
    fontSize: 14, fontWeight: '600', color: colors.text,
    marginBottom: 6, fontFamily: font.display, letterSpacing: -0.1,
  },
  emptyStateBody: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12 },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  rowInfo: { flex: 1 },
  rowTitle: { fontSize: 13, color: colors.text },
  rowSep: { color: colors.textMuted },
  rowModel: { color: colors.text, fontFamily: font.mono, fontWeight: '600' },
  rowMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontFamily: font.mono },
  rowMetaMuted: { color: colors.textMuted, fontStyle: 'italic' },
  rowTierHint: {
    fontSize: 11, color: colors.textSecondary, marginTop: 3,
    fontWeight: '600', letterSpacing: 0.1,
  },
  rowModelId: {
    fontSize: 11, color: colors.textMuted, marginTop: 2,
    fontFamily: font.mono,
  },
  editPanel: {
    paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12,
    backgroundColor: colors.inputBg,
    borderTopWidth: 1, borderTopColor: colors.borderLight,
  },

  toggleBtn: { padding: 6, marginHorizontal: 4 },
  toggleDot: { width: 10, height: 10, borderRadius: 5 },
  toggleOn: { backgroundColor: colors.success },
  toggleOff: { backgroundColor: colors.border },
  classifierBtn: { padding: 6, marginHorizontal: 2 },
  routerTag: {
    fontSize: 10, fontWeight: '700', color: colors.primary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  removeBtn: { padding: 6 },

  pickerItem: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingVertical: 8,
    backgroundColor: colors.inputBg, borderRadius: radius.sm,
  },
  pickerItemText: { fontSize: 12, color: colors.text, fontFamily: font.mono },
  pickerItemMeta: { fontSize: 11, color: colors.textMuted, fontFamily: font.mono },

  overviewMuted: { fontSize: 13, color: colors.textMuted, fontWeight: '400' },

  costSummary: { flexDirection: 'row', marginBottom: 14 },
  costStat: { flex: 1, alignItems: 'center' },
  costStatValue: { fontSize: 18, fontWeight: '600', color: colors.text, fontFamily: font.mono },
  costStatLabel: { fontSize: 10, color: colors.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 1 },

  costTable: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  costHeaderRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  costRow: { flexDirection: 'row', paddingVertical: 5 },
  costCell: { fontSize: 11, color: colors.text, fontFamily: font.mono },
  costHeaderText: { color: colors.textMuted, fontWeight: '600', fontSize: 10, textTransform: 'uppercase' },

  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: colors.textSecondary },
  samplingHint: {
    fontSize: 11, color: colors.textMuted, marginTop: -2, marginBottom: 6, lineHeight: 15,
  },
  samplingGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
  },
  samplingField: { minWidth: 108, flexGrow: 1, flexBasis: '30%' },
  samplingLabel: {
    fontSize: 10, color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3,
  },
  samplingInput: { marginBottom: 0 },
  providerHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  },
  frameworkHeaderOff: { opacity: 0.5 },
  providerOffTag: { color: colors.textMuted, fontWeight: '400' },
  providerEmpty: {
    fontSize: 12, color: colors.textMuted,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  manualInput: { flex: 1, marginBottom: 0 },
});
