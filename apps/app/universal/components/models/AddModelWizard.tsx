/**
 * AddModelWizard — three steps from "I have access to something" to models
 * in the grid.
 *
 *   1. How do you access it (subscription, API key, local server) and what
 *      type of model it is.
 *   2. Where: pick or create the provider row. An existing row with the same
 *      name is reused (a typed key or URL updates it) instead of duplicated.
 *   3. Which models: the provider's catalogue, with the detected inputs for
 *      language models (editable; an edit makes them manual), an optional
 *      name, and a role (normal, default, backup).
 *
 * Every step validates before it lets you on, with the reason inline.
 */

import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { colors, font, radius } from '../../theme';
import type {
  AvailableModel, InputModality, ModelEntry, ModelKind, ProviderAccounts, ProviderConfig,
} from '../../../common/types';
import Button from '../Button';
import {
  addProvider, createDbModel, listAvailableModels, refreshProviderCapabilities,
  testProvider, updateProvider,
} from '../../services/api';
import {
  ALL_VENDORS, KIND_LABELS, KIND_ORDER, VENDORS, accountsFor, errorMessage, isHttpUrl,
  isLocalUrl, isSubscription, nextFallbackPriority, normalizeModalities, providerKindFor,
  sameModalities, type Access,
} from './modelHelpers';
import { Chip, Field, InlineError, ModalShell, ModalityChips, SectionLabel, formStyles } from './ui';

type Role = 'normal' | 'default' | 'backup';

interface Candidate {
  entry: AvailableModel;
  selected: boolean;
  name: string;
  role: Role;
  inputs: InputModality[];
  detected: InputModality[] | null;
}

interface Props {
  visible: boolean;
  providers: ProviderConfig[];
  models: ModelEntry[];
  accounts: ProviderAccounts[] | null;
  onClose: () => void;
  /** Reload providers and models (after a provider or model is created). */
  onChanged: () => Promise<void> | void;
  reloadAccounts: () => Promise<void> | void;
}

const ACCESS_OPTIONS: { id: Access; title: string; body: string; icon: keyof typeof Feather.glyphMap }[] = [
  { id: 'subscription', title: 'Subscription', body: 'A plan you sign in to, served through a subscription service.', icon: 'users' },
  { id: 'api', title: 'API key', body: 'A vendor account billed per use.', icon: 'key' },
  { id: 'local', title: 'Local server', body: 'A model running on this machine or your network.', icon: 'server' },
];

const ACCOUNT_STATUS: Record<string, { label: string; color: string }> = {
  ok: { label: 'Signed in', color: colors.success },
  auth_expired: { label: 'Sign-in expired', color: colors.error },
  rate_limited: { label: 'Rate limited', color: colors.warning },
};

export default function AddModelWizard({
  visible, providers, models, accounts, onClose, onChanged, reloadAccounts,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [access, setAccess] = useState<Access | null>(null);
  const [type, setType] = useState<ModelKind>('llm');
  const [stepError, setStepError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 2 — API key
  const [vendor, setVendor] = useState<string | null>(null); // provider/vendor name, or '' for custom
  const [customName, setCustomName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // Step 2 — local server
  const [localName, setLocalName] = useState('');
  const [localUrl, setLocalUrl] = useState('');
  const [localKey, setLocalKey] = useState('');
  // Step 2 — subscription
  const [subProviderId, setSubProviderId] = useState<number | null>(null);
  const [subName, setSubName] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const [refreshing, setRefreshing] = useState<number | null>(null);
  // Resolved provider row, keyed by the inputs it was resolved from so a
  // Back-and-edit resolves again instead of reusing a stale row.
  const [resolved, setResolved] = useState<{ key: string; id: number } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // Step 3
  const [picks, setPicks] = useState<Candidate[]>([]);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const [availableNote, setAvailableNote] = useState<string | null>(null);
  const [manualId, setManualId] = useState('');

  useEffect(() => {
    if (!visible) return;
    setStep(1); setAccess(null); setType('llm'); setStepError(null); setBusy(false);
    setVendor(null); setCustomName(''); setBaseUrl(''); setApiKey('');
    setLocalName(''); setLocalUrl(''); setLocalKey('');
    setSubProviderId(null); setSubName(''); setSubUrl('');
    setResolved(null); setTestResult(null);
    setPicks([]); setAvailableNote(null); setManualId('');
  }, [visible]);

  const providerKind = providerKindFor(type);
  const subscriptionEntries = (accounts ?? []).filter((a) => isSubscription(a));
  const providerForEntry = (e: ProviderAccounts) =>
    providers.find((p) => p.id === e.provider_id) ?? providers.find((p) => p.name === e.provider) ?? null;

  // API-key providers already configured for this type (not local, not a subscription).
  const apiProviders = useMemo(() => providers.filter((p) => {
    if (p.kind !== providerKind) return false;
    if (isLocalUrl(p.base_url)) return false;
    return !isSubscription(accountsFor(p, accounts));
  }), [providers, providerKind, accounts]);
  const vendorChoices = VENDORS[type].filter((v) => !apiProviders.some((p) => p.name === v));

  const apiName = vendor === '' ? customName.trim() : (vendor ?? '');
  const existingApi = providers.find((p) => p.name === apiName) ?? null;
  const existingLocal = providers.find((p) => p.name === localName.trim()) ?? null;

  // ── Step 2 validation + provider resolution ──

  const validateStep2 = (): string | null => {
    if (access === 'api') {
      if (vendor === null) return 'Choose a provider.';
      if (!apiName) return 'Enter a name for the provider.';
      const url = baseUrl.trim();
      const known = ALL_VENDORS.has(apiName) || !!existingApi;
      if (!known && !url) return 'A custom provider needs a base URL.';
      if (url && !isHttpUrl(url)) return 'The base URL must start with http:// or https://.';
      if (!existingApi && !apiKey.trim()) return 'Enter the API key.';
      return null;
    }
    if (access === 'local') {
      if (!localName.trim()) return 'Enter a name for the server.';
      if (!localUrl.trim()) return 'Enter the server URL.';
      if (!isHttpUrl(localUrl)) return 'The server URL must start with http:// or https://.';
      return null;
    }
    if (access === 'subscription') {
      return subProviderId == null ? 'Choose a subscription.' : null;
    }
    return 'Choose how you access the model.';
  };

  const resolveKey = () => access === 'api'
    ? `api|${apiName}|${baseUrl.trim()}|${apiKey.trim()}`
    : access === 'local'
      ? `local|${localName.trim()}|${localUrl.trim()}|${localKey.trim()}`
      : `sub|${subProviderId}`;

  /** Find or create the provider row for step 2's inputs. */
  const ensureProvider = async (): Promise<number> => {
    const key = resolveKey();
    if (resolved && resolved.key === key) return resolved.id;
    let id: number;
    if (access === 'subscription') {
      id = subProviderId as number;
    } else {
      const name = access === 'api' ? apiName : localName.trim();
      const url = (access === 'api' ? baseUrl : localUrl).trim();
      const secret = (access === 'api' ? apiKey : localKey).trim();
      const existing = access === 'api' ? existingApi : existingLocal;
      if (existing) {
        const patch: { api_key?: string; base_url?: string } = {};
        if (secret) patch.api_key = secret;
        if (url && url !== (existing.base_url ?? '')) patch.base_url = url;
        if (Object.keys(patch).length) await updateProvider(existing.id, patch);
        id = existing.id;
      } else {
        const r = await addProvider({
          name,
          framework: 'api-based',
          kind: providerKind,
          ...(secret ? { api_key: secret } : {}),
          ...(url ? { base_url: url } : {}),
        });
        id = r.provider.id;
      }
      await onChanged();
    }
    setResolved({ key, id });
    return id;
  };

  const runTest = async () => {
    const bad = validateStep2();
    if (bad) { setStepError(bad); return; }
    setStepError(null);
    setBusy(true);
    setTestResult(null);
    try {
      const id = await ensureProvider();
      setTestResult(await testProvider(id));
    } catch (e) {
      setStepError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const loadAvailable = async (providerId: number) => {
    setLoadingAvailable(true);
    setAvailableNote(null);
    try {
      const entries = (await listAvailableModels(providerId)).filter((e) => (e.kind ?? 'llm') === type);
      setPicks(entries.map((entry) => {
        const detected = entry.detected_input_modalities
          ? normalizeModalities(entry.detected_input_modalities) : null;
        return { entry, selected: false, name: '', role: 'normal', inputs: detected ?? ['text'], detected };
      }));
      if (entries.length === 0) {
        setAvailableNote(`This provider did not list any ${KIND_LABELS[type].toLowerCase()} models. Enter a model id below.`);
      }
    } catch (e) {
      setPicks([]);
      setAvailableNote(`Could not load the provider's models: ${errorMessage(e)}. Enter a model id below.`);
    } finally {
      setLoadingAvailable(false);
    }
  };

  // ── Step navigation ──

  const next = async () => {
    setStepError(null);
    if (step === 1) {
      if (!access) { setStepError('Choose how you access the model.'); return; }
      setStep(2);
      return;
    }
    if (step === 2) {
      const bad = validateStep2();
      if (bad) { setStepError(bad); return; }
      setBusy(true);
      try {
        const id = await ensureProvider();
        setStep(3);
        void loadAvailable(id);
      } catch (e) {
        setStepError(errorMessage(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    await create();
  };

  const back = () => {
    setStepError(null);
    if (step === 1) { onClose(); return; }
    setTestResult(null);
    setStep(step === 3 ? 2 : 1);
  };

  const create = async () => {
    const chosen = picks.filter((p) => p.selected && !p.entry.added);
    if (chosen.length === 0) { setStepError('Choose at least one model.'); return; }
    if (!resolved) { setStepError('Choose a provider first.'); return; }
    setBusy(true);
    let backup = nextFallbackPriority(models);
    const failed: string[] = [];
    const done = new Set<string>();
    for (const p of chosen) {
      const isLlm = type === 'llm';
      const role: Role = isLlm ? p.role : 'normal';
      const edited = isLlm && !sameModalities(p.inputs, p.detected ?? ['text']);
      try {
        await createDbModel({
          provider_id: resolved.id,
          model: p.entry.id,
          kind: type,
          ...(p.name.trim() || p.entry.display_name
            ? { display_name: p.name.trim() || p.entry.display_name } : {}),
          ...(role === 'default' ? { is_classifier: true } : {}),
          ...(role === 'backup' ? { metadata: { fallback_priority: backup++ } } : {}),
          // Unchanged inputs: let the server record what it detects, which
          // keeps them refreshable. Changed: a list without a source is manual.
          ...(edited ? { input_modalities: p.inputs } : {}),
        });
        done.add(p.entry.id);
      } catch (e) {
        failed.push(`${p.entry.id}: ${errorMessage(e)}`);
      }
    }
    await onChanged();
    setBusy(false);
    if (failed.length === 0) { onClose(); return; }
    setPicks((prev) => prev.map((p) => done.has(p.entry.id) ? { ...p, selected: false, entry: { ...p.entry, added: true } } : p));
    setStepError(`Could not add ${failed.length === 1 ? 'this model' : 'these models'}. ${failed.join(' · ')}`);
  };

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    if (picks.some((p) => p.entry.id === id)) {
      setPicks((prev) => prev.map((p) => p.entry.id === id && !p.entry.added ? { ...p, selected: true } : p));
    } else {
      setPicks((prev) => [...prev, {
        entry: { id, display_name: '', kind: type },
        selected: true, name: '', role: 'normal', inputs: ['text'], detected: null,
      }]);
    }
    setManualId('');
  };

  const updatePick = (id: string, patch: Partial<Candidate>) =>
    setPicks((prev) => prev.map((p) => (p.entry.id === id ? { ...p, ...patch } : p)));

  const refreshSubscription = async (providerId: number) => {
    setRefreshing(providerId);
    try {
      await refreshProviderCapabilities(providerId);
    } catch (e) {
      setStepError(errorMessage(e));
    }
    await reloadAccounts();
    setRefreshing(null);
  };

  const addSubscriptionService = async () => {
    const name = subName.trim();
    const url = subUrl.trim();
    if (!name) { setStepError('Enter a name for the subscription service.'); return; }
    if (!isHttpUrl(url)) { setStepError('The base URL must start with http:// or https://.'); return; }
    setStepError(null);
    setBusy(true);
    try {
      const existing = providers.find((p) => p.name === name);
      let id = existing?.id;
      if (existing) {
        if (url !== (existing.base_url ?? '')) await updateProvider(existing.id, { base_url: url });
      } else {
        id = (await addProvider({ name, framework: 'api-based', kind: providerKind, base_url: url })).provider.id;
      }
      await onChanged();
      await reloadAccounts();
      setSubProviderId(id ?? null);
    } catch (e) {
      setStepError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Renders ──

  const renderStep1 = () => (
    <>
      <SectionLabel>How do you access it?</SectionLabel>
      <View style={styles.optionRow}>
        {ACCESS_OPTIONS.map((o) => {
          const on = access === o.id;
          return (
            <Pressable
              key={o.id}
              onPress={() => { setAccess(o.id); setStepError(null); setResolved(null); }}
              style={[styles.option, on && styles.optionOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.title}
              {...(Platform.OS === 'web' ? ({ className: 'oa-press' } as any) : {})}
            >
              <Feather name={o.icon} size={16} color={on ? colors.primary : colors.textSecondary} />
              <Text style={[styles.optionTitle, on && { color: colors.primary }]}>{o.title}</Text>
              <Text style={styles.optionBody}>{o.body}</Text>
            </Pressable>
          );
        })}
      </View>
      <SectionLabel>Type</SectionLabel>
      <View style={formStyles.row}>
        {KIND_ORDER.map((k) => (
          <Chip key={k} label={KIND_LABELS[k]} active={type === k} onPress={() => { setType(k); setResolved(null); setVendor(null); }} />
        ))}
      </View>
    </>
  );

  const renderApiStep = () => (
    <>
      <SectionLabel>Provider</SectionLabel>
      <View style={formStyles.row}>
        {apiProviders.map((p) => (
          <Chip key={`p-${p.id}`} label={p.name} icon="check-circle" active={vendor === p.name}
            onPress={() => { setVendor(p.name); setStepError(null); }} />
        ))}
        {vendorChoices.map((v) => (
          <Chip key={`v-${v}`} label={v} active={vendor === v}
            onPress={() => { setVendor(v); setStepError(null); }} />
        ))}
        <Chip label="Custom" icon="plus" active={vendor === ''}
          onPress={() => { setVendor(''); setStepError(null); }} />
      </View>
      {apiProviders.length > 0 ? (
        <Text style={formStyles.muted}>Ticked providers are already set up and are reused.</Text>
      ) : null}
      {vendor === '' ? (
        <Field label="Name" value={customName} onChangeText={setCustomName}
          placeholder="my-gateway" autoCapitalize="none" mono />
      ) : null}
      {vendor !== null ? (
        <>
          <Field
            label={vendor === '' && !existingApi ? 'Base URL' : 'Base URL (optional)'}
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder={existingApi?.base_url || 'https://api.example.com/v1'}
            autoCapitalize="none"
            keyboardType="url"
            mono
          />
          <Field
            label={existingApi ? 'API key (optional)' : 'API key'}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={existingApi ? `Saved key ${existingApi.api_key_display}` : 'sk-…'}
            hint={existingApi ? 'Leave empty to keep the saved key.' : undefined}
            secureTextEntry
            autoCapitalize="none"
            mono
          />
          {providerKind === 'llm' ? renderTest() : null}
        </>
      ) : null}
    </>
  );

  const renderLocalStep = () => (
    <>
      <Field label="Name" value={localName} onChangeText={setLocalName}
        placeholder="ollama" autoCapitalize="none" mono
        hint={existingLocal ? 'A provider with this name exists and is reused.' : undefined} />
      <Field label="Server URL" value={localUrl} onChangeText={setLocalUrl}
        placeholder="http://127.0.0.1:11434/v1" autoCapitalize="none" keyboardType="url" mono />
      <Field label="API key (optional)" value={localKey} onChangeText={setLocalKey}
        placeholder="Only if the server asks for one" secureTextEntry autoCapitalize="none" mono />
      {providerKind === 'llm' ? renderTest() : null}
    </>
  );

  const renderTest = () => (
    <View style={styles.testRow}>
      <Button variant="secondary" size="sm" icon="activity"
        label={busy ? 'Testing…' : 'Test connection'} onPress={runTest} disabled={busy} />
      {testResult ? (
        <Text style={testResult.ok ? formStyles.success : styles.fail} numberOfLines={3}>
          {testResult.ok ? 'Connection works.' : `Connection failed: ${testResult.error ?? 'no details'}`}
        </Text>
      ) : null}
    </View>
  );

  const renderSubscriptionStep = () => {
    if (accounts === null) {
      return <Text style={formStyles.muted}>This agent does not report subscription accounts.</Text>;
    }
    if (subscriptionEntries.length === 0) {
      return (
        <>
          <Text style={formStyles.body}>
            Connect a subscription service first. Add its base URL here and it appears once it reports accounts.
          </Text>
          <Field label="Name" value={subName} onChangeText={setSubName}
            placeholder="claude-proxy" autoCapitalize="none" mono />
          <Field label="Base URL" value={subUrl} onChangeText={setSubUrl}
            placeholder="http://127.0.0.1:8787/v1" autoCapitalize="none" keyboardType="url" mono />
          <View style={formStyles.row}>
            <Button variant="secondary" size="sm" icon="plus" label="Add provider"
              onPress={addSubscriptionService} disabled={busy} />
            {subProviderId != null ? (
              <Text style={formStyles.success}>Added. Continue to choose its models.</Text>
            ) : null}
          </View>
        </>
      );
    }
    return (
      <>
        <SectionLabel>Subscription</SectionLabel>
        {subscriptionEntries.map((e) => {
          const p = providerForEntry(e);
          if (!p) return null;
          const on = subProviderId === p.id;
          const expired = e.accounts.some((a) => a.status === 'auth_expired');
          return (
            <Pressable
              key={p.id}
              onPress={() => { setSubProviderId(p.id); setStepError(null); }}
              style={[styles.subCard, on && styles.optionOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Use ${p.name}`}
            >
              <View style={formStyles.between}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.optionTitle, on && { color: colors.primary }]}>{p.name}</Text>
                  {p.base_url ? <Text style={styles.subUrl} numberOfLines={1}>{p.base_url}</Text> : null}
                </View>
                {expired ? (
                  <Button variant="ghost" size="xs" icon="refresh-cw"
                    label={refreshing === p.id ? 'Refreshing…' : 'Refresh'}
                    onPress={() => { void refreshSubscription(p.id); }}
                    disabled={refreshing === p.id} />
                ) : null}
              </View>
              {e.accounts.map((a) => {
                const s = ACCOUNT_STATUS[a.status ?? (a.dead ? 'auth_expired' : a.limited ? 'rate_limited' : 'ok')]
                  ?? ACCOUNT_STATUS.ok;
                return (
                  <View key={a.id} style={styles.accountRow}>
                    <Text style={styles.accountName} numberOfLines={1}>{a.name || a.id}</Text>
                    <View style={[styles.statusDot, { backgroundColor: s.color }]} />
                    <Text style={[styles.accountStatus, { color: s.color }]}>{s.label}</Text>
                  </View>
                );
              })}
            </Pressable>
          );
        })}
      </>
    );
  };

  const renderStep3 = () => {
    const visiblePicks = picks;
    return (
      <>
        <SectionLabel>Choose models</SectionLabel>
        {loadingAvailable ? <Text style={formStyles.muted}>Loading models…</Text> : null}
        {availableNote ? <Text style={formStyles.muted}>{availableNote}</Text> : null}
        <View style={styles.pickList}>
          {visiblePicks.map((p) => {
            const added = !!p.entry.added;
            const isLlm = type === 'llm';
            const edited = isLlm && !sameModalities(p.inputs, p.detected ?? ['text']);
            return (
              <View key={p.entry.id} style={[styles.pick, p.selected && styles.pickOn]}>
                <Pressable
                  onPress={() => !added && updatePick(p.entry.id, { selected: !p.selected })}
                  disabled={added}
                  style={styles.pickHead}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: p.selected, disabled: added }}
                  accessibilityLabel={p.entry.display_name || p.entry.id}
                >
                  <Feather
                    name={added ? 'check' : p.selected ? 'check-square' : 'square'}
                    size={15}
                    color={p.selected ? colors.primary : colors.textMuted}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.pickId, added && { color: colors.textMuted }]} numberOfLines={1}>
                      {p.entry.id}
                    </Text>
                    {p.entry.display_name && p.entry.display_name !== p.entry.id ? (
                      <Text style={styles.pickName} numberOfLines={1}>{p.entry.display_name}</Text>
                    ) : null}
                  </View>
                  {added ? <Text style={styles.addedTag}>Added</Text> : null}
                </Pressable>
                {isLlm && !p.selected && !added ? (
                  <View style={styles.pickBody}>
                    <ModalityChips value={p.inputs} compact mode={p.detected ? 'auto' : undefined} />
                  </View>
                ) : null}
                {p.selected ? (
                  <View style={styles.pickBody}>
                    {isLlm ? (
                      <>
                        <Text style={styles.smallLabel}>Supported inputs{edited ? ' · manual' : ''}</Text>
                        <ModalityChips value={p.inputs} onChange={(inputs) => updatePick(p.entry.id, { inputs })} />
                      </>
                    ) : null}
                    <Field label="Display name (optional)" value={p.name}
                      onChangeText={(name) => updatePick(p.entry.id, { name })}
                      placeholder={p.entry.display_name || p.entry.id} />
                    {isLlm ? (
                      <>
                        <Text style={styles.smallLabel}>Role</Text>
                        <View style={formStyles.row}>
                          <Chip label="Normal" active={p.role === 'normal'} onPress={() => updatePick(p.entry.id, { role: 'normal' })} />
                          <Chip label="Default" active={p.role === 'default'} onPress={() => updatePick(p.entry.id, { role: 'default' })} />
                          <Chip label="Backup" active={p.role === 'backup'} onPress={() => updatePick(p.entry.id, { role: 'backup' })} />
                        </View>
                      </>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
        <View style={styles.manualRow}>
          <View style={{ flex: 1 }}>
            <Field label="Or enter a model id" value={manualId} onChangeText={setManualId}
              placeholder="gpt-5.6-sol" autoCapitalize="none" mono onSubmitEditing={addManual} />
          </View>
          <Button variant="secondary" size="md" label="Add" onPress={addManual} disabled={!manualId.trim()} />
        </View>
      </>
    );
  };

  const selectedCount = picks.filter((p) => p.selected && !p.entry.added).length;
  const nextLabel = step < 3
    ? (busy ? 'Working…' : 'Next')
    : busy ? 'Adding…' : selectedCount > 1 ? `Add ${selectedCount} models` : 'Add model';

  return (
    <ModalShell
      visible={visible}
      title="Add model"
      subtitle={`Step ${step} of 3`}
      onClose={() => { if (!busy) onClose(); }}
      width={600}
      footer={(
        <>
          <Button variant="secondary" size="md" label={step === 1 ? 'Cancel' : 'Back'} onPress={back} disabled={busy} />
          <Button variant="primary" size="md" label={nextLabel} onPress={() => { void next(); }} disabled={busy} />
        </>
      )}
    >
      {step === 1 ? renderStep1() : null}
      {step === 2 && access === 'api' ? renderApiStep() : null}
      {step === 2 && access === 'local' ? renderLocalStep() : null}
      {step === 2 && access === 'subscription' ? renderSubscriptionStep() : null}
      {step === 3 ? renderStep3() : null}
      <InlineError>{stepError}</InlineError>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    flexGrow: 1, flexBasis: 160, minWidth: 150,
    padding: 12, gap: 6,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg,
  },
  optionOn: { borderColor: colors.borderStrong, backgroundColor: colors.primarySoft },
  optionTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  optionBody: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16 },

  testRow: { gap: 6, alignItems: 'flex-start' },
  fail: { fontSize: 12, color: colors.error, lineHeight: 17 },

  subCard: {
    padding: 12, gap: 8,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg,
  },
  subUrl: { fontSize: 11, color: colors.textMuted, fontFamily: font.mono, marginTop: 2 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  accountName: { flex: 1, fontSize: 12, color: colors.textSecondary },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  accountStatus: { fontSize: 11.5 },

  pickList: { gap: 6 },
  pick: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight,
    backgroundColor: colors.inputBg, overflow: 'hidden',
  },
  pickOn: { borderColor: colors.borderStrong },
  pickHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  pickId: { fontSize: 12.5, color: colors.text, fontFamily: font.mono },
  pickName: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  addedTag: { fontSize: 11, color: colors.textMuted },
  pickBody: { paddingHorizontal: 10, paddingBottom: 10, paddingLeft: 35, gap: 8 },
  smallLabel: { fontSize: 11.5, color: colors.textSecondary, fontWeight: '500' },
  manualRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
});
