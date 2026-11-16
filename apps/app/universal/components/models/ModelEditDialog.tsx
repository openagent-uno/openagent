/**
 * ModelEditDialog — everything about one model, and the provider behind it.
 *
 * Model: display name, tier hint and sampling (language models), supported
 * inputs with an "Automatic (from provider)" switch, voice (speech models).
 * Provider: endpoint, masked key, accounts for a subscription, and the
 * provider-wide actions that used to live in their own section — test,
 * turn off, remove.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font } from '../../theme';
import type { InputModality, ModelEntry, ProviderAccounts, ProviderConfig } from '../../../common/types';
import Button from '../Button';
import ThemedSwitch from '../ThemedSwitch';
import { AccountRow } from '../AccountsPanel';
import { useConfirm } from '../ConfirmDialog';
import {
  deleteProvider, refreshProviderCapabilities, testProvider, updateDbModel, updateProvider,
} from '../../services/api';
import {
  ACCESS_LABELS, KIND_LABELS, SAMPLING_FIELDS, applySampling, errorMessage,
  modelModalities, samplingDraft, sameModalities, voiceOf, type Access,
} from './modelHelpers';
import { Field, InlineError, ModalShell, ModalityChips, SectionLabel, formStyles } from './ui';

interface Props {
  model: ModelEntry | null;
  provider: ProviderConfig | null;
  accounts: ProviderAccounts | null;
  access: Access;
  /** Models registered under this provider, for the remove warning. */
  providerModelCount: number;
  onClose: () => void;
  /** Reload the grid after any change. */
  onChanged: () => Promise<void> | void;
  onDeleteModel: (m: ModelEntry) => Promise<boolean>;
}

export default function ModelEditDialog({
  model, provider, accounts, access, providerModelCount, onClose, onChanged, onDeleteModel,
}: Props) {
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [tierHint, setTierHint] = useState('');
  const [voice, setVoice] = useState('');
  const [sampling, setSampling] = useState<Record<string, string>>({});
  const [autoInputs, setAutoInputs] = useState(true);
  const [inputs, setInputs] = useState<InputModality[]>(['text']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);

  const modelId = model?.id ?? null;
  useEffect(() => {
    if (!model) return;
    const mods = modelModalities(model);
    setName(model.display_name ?? '');
    setTierHint(model.tier_hint ?? '');
    setVoice(voiceOf(model) ?? '');
    setSampling(samplingDraft(model.metadata));
    setAutoInputs(mods.mode === 'auto');
    setInputs(mods.list);
    setError(null);
    setTestResult(null);
    // Seed once per opened model; later reloads must not wipe the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const close = useCallback(() => {
    if (saving) return;
    onClose();
  }, [saving, onClose]);

  if (!model) return <ModalShell visible={false} title="" onClose={onClose}>{null}</ModalShell>;

  const kind = model.kind ?? 'llm';
  const isLlm = kind === 'llm';
  const current = modelModalities(model);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const metadata: Record<string, unknown> = { ...((model.metadata ?? {}) as Record<string, unknown>) };
      if (isLlm) {
        const bad = applySampling(metadata, sampling);
        if (bad) { setError(bad); return; }
      }
      if (kind === 'tts') {
        const v = voice.trim();
        if (v) metadata.voice_id = v; else delete metadata.voice_id;
      }
      const trimmedName = name.trim();
      const body: Parameters<typeof updateDbModel>[1] = {
        display_name: trimmedName ? trimmedName : null,
        metadata,
      };
      if (isLlm) {
        const tier = tierHint.trim();
        body.tier_hint = tier ? tier : null;
      }
      let handBack = false;
      if (isLlm) {
        if (autoInputs && current.mode === 'manual') {
          body.input_modalities_source = 'auto';
          handBack = true;
        } else if (!autoInputs && (current.mode === 'auto' || !sameModalities(inputs, current.list))) {
          body.input_modalities = inputs;
        }
      }
      await updateDbModel(model.id, body);
      if (handBack) {
        // Re-detect now rather than at the next refresh. Best effort: the
        // provider may be offline, and the save itself already landed.
        try { await refreshProviderCapabilities(model.provider_id); } catch { /* next refresh */ }
      }
      await onChanged();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!provider) return;
    setTesting(true);
    setTestResult(null);
    const r = await testProvider(provider.id, isLlm ? model.model : undefined);
    setTestResult(r);
    setTesting(false);
  };

  const toggleProvider = async () => {
    if (!provider) return;
    setProviderBusy(true);
    setError(null);
    try {
      await updateProvider(provider.id, { enabled: !provider.enabled });
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProviderBusy(false);
    }
  };

  const removeProvider = async () => {
    if (!provider) return;
    const others = providerModelCount === 1 ? 'its 1 model' : `its ${providerModelCount} models`;
    const ok = await confirm({
      title: 'Remove provider',
      message: `Remove "${provider.name}"? This also removes ${others}. This cannot be undone.`,
      confirmLabel: 'Remove',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    setProviderBusy(true);
    try {
      await deleteProvider(provider.id);
      onClose();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProviderBusy(false);
    }
  };

  const deleteModel = async () => {
    if (await onDeleteModel(model)) onClose();
  };

  return (
    <ModalShell
      visible
      title={model.display_name || model.model}
      subtitle={`${KIND_LABELS[kind]} · ${model.runtime_id}`}
      onClose={close}
      footer={(
        <>
          <Button variant="danger" size="md" label="Delete" icon="trash-2" onPress={deleteModel} disabled={saving} />
          <View style={{ flex: 1 }} />
          <Button variant="secondary" size="md" label="Cancel" onPress={close} disabled={saving} />
          <Button variant="primary" size="md" label={saving ? 'Saving…' : 'Save'} onPress={save} disabled={saving} />
        </>
      )}
    >
      <Field
        label="Display name"
        value={name}
        onChangeText={setName}
        placeholder={model.model}
      />
      {isLlm ? (
        <Field
          label="Tier hint"
          value={tierHint}
          onChangeText={setTierHint}
          placeholder="best for coding, complex reasoning"
          hint="Helps the default model decide when to hand a task to this one."
        />
      ) : null}
      {kind === 'tts' ? (
        <Field
          label="Voice"
          value={voice}
          onChangeText={setVoice}
          placeholder="Provider default"
          mono
          autoCapitalize="none"
        />
      ) : null}

      {isLlm ? (
        <View style={styles.section}>
          <View style={formStyles.between}>
            <SectionLabel>Supported inputs</SectionLabel>
            <View style={formStyles.row}>
              <Text style={formStyles.muted}>Automatic (from provider)</Text>
              <ThemedSwitch
                value={autoInputs}
                onValueChange={setAutoInputs}
                accessibilityLabel="Automatic supported inputs"
              />
            </View>
          </View>
          <ModalityChips value={inputs} onChange={autoInputs ? undefined : setInputs} />
          <Text style={formStyles.muted}>
            {autoInputs
              ? 'The provider decides, and the list updates when it is refreshed.'
              : 'Your choice. Refreshing the provider leaves it as it is.'}
          </Text>
        </View>
      ) : null}

      {isLlm ? (
        <View style={styles.section}>
          <SectionLabel>Sampling</SectionLabel>
          <Text style={formStyles.muted}>Leave a field empty to use the provider default.</Text>
          <View style={styles.samplingGrid}>
            {SAMPLING_FIELDS.map((f) => (
              <View key={f.key} style={styles.samplingField}>
                <Field
                  label={f.label}
                  value={sampling[f.key] ?? ''}
                  onChangeText={(v) => setSampling((prev) => ({ ...prev, [f.key]: v }))}
                  placeholder={f.placeholder}
                  keyboardType="numeric"
                  autoCapitalize="none"
                  mono
                />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <InlineError>{error}</InlineError>

      {provider ? (
        <View style={[styles.section, styles.providerSection]}>
          <View style={formStyles.between}>
            <SectionLabel>Provider</SectionLabel>
            <Text style={formStyles.muted}>{ACCESS_LABELS[access]}{provider.enabled ? '' : ' · Off'}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Name</Text>
            <Text style={styles.v} numberOfLines={1}>{provider.name}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Base URL</Text>
            <Text style={styles.v} numberOfLines={1}>{provider.base_url || 'Vendor default'}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Key</Text>
            <Text style={styles.v} numberOfLines={1}>{provider.api_key_display || '—'}</Text>
          </View>
          <ProviderAccountsDetail entry={accounts} />
          {testResult ? (
            <Text style={testResult.ok ? formStyles.success : styles.fail}>
              {testResult.ok ? 'Connection works.' : `Connection failed: ${testResult.error ?? 'no details'}`}
            </Text>
          ) : null}
          <View style={formStyles.row}>
            {provider.kind === 'llm' ? (
              <Button
                variant="secondary" size="sm" icon="activity"
                label={testing ? 'Testing…' : 'Test connection'}
                onPress={runTest} disabled={testing || providerBusy}
              />
            ) : null}
            <Button
              variant="ghost" size="sm" icon="power"
              label={provider.enabled ? 'Turn provider off' : 'Turn provider on'}
              onPress={toggleProvider} disabled={providerBusy}
            />
            <Button
              variant="danger" size="sm" icon="trash-2"
              label="Remove provider"
              onPress={removeProvider} disabled={providerBusy}
            />
          </View>
        </View>
      ) : null}
    </ModalShell>
  );
}

/** What the Accounts panel showed for a provider: each account with plan,
 *  state and quota, the proxy's metrics, or why there are no accounts. */
export function ProviderAccountsDetail({ entry }: { entry: ProviderAccounts | null }) {
  if (!entry) return null;
  if (entry.accounts.length === 0) {
    return (
      <View style={styles.kv}>
        <Text style={styles.k}>Accounts</Text>
        <Text style={styles.v} numberOfLines={2}>
          {entry.error || (entry.reachable ? 'Reachable, no accounts reported' : 'Not reachable')}
        </Text>
      </View>
    );
  }
  const m = entry.metrics;
  const metrics = m ? [
    m.active !== undefined ? `${m.active} active` : null,
    m.queued ? `${m.queued} queued` : null,
    m.account_switches ? `${m.account_switches} switches` : null,
  ].filter(Boolean).join(' · ') : '';
  return (
    <View style={styles.accounts}>
      <View style={formStyles.between}>
        <Text style={styles.k}>{entry.accounts.length === 1 ? '1 account' : `${entry.accounts.length} accounts`}</Text>
        {metrics ? <Text style={formStyles.muted}>{metrics}</Text> : null}
      </View>
      {entry.accounts.map((a) => <AccountRow key={a.id} account={a} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  providerSection: { borderTopWidth: 1, borderTopColor: colors.borderLight, paddingTop: 14 },
  samplingGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  samplingField: { minWidth: 140, flexGrow: 1, flexBasis: '30%' },
  kv: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  k: { minWidth: 72, fontSize: 12, color: colors.textMuted },
  v: { flex: 1, fontSize: 12, color: colors.textSecondary, fontFamily: font.mono },
  accounts: { gap: 12, paddingVertical: 4 },
  fail: { fontSize: 12, color: colors.error },
});
