/** Only model-owned settings. Credentials and accounts live in the connection view. */
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { InputModality, ModelEntry, ProviderConfig } from '../../../common/types';
import { colors } from '../../theme';
import { updateDbModel } from '../../services/api';
import Button from '../Button';
import BudgetsPanel from '../BudgetsPanel';
import ThemedSwitch from '../ThemedSwitch';
import { Chip, Field, InlineError, ModalShell, ModalityChips } from './ui';
import { errorMessage, fallbackPriority, KIND_LABELS, modelModalities } from './modelHelpers';

export default function ModelSettingsDialog({ model, provider, onClose, onChanged }: {
  model: ModelEntry; provider: ProviderConfig; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const declaration = modelModalities(model);
  const [name, setName] = useState(model.display_name || '');
  const [hint, setHint] = useState(model.tier_hint || '');
  const [auto, setAuto] = useState(declaration.mode === 'auto');
  const [inputs, setInputs] = useState<InputModality[]>(declaration.list);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries((model.settings_schema ?? []).map((field) => [field.key, String(model.metadata?.[field.key] ?? '')])));
  const [backup, setBackup] = useState(fallbackPriority(model) !== null);
  const [backupOrder, setBackupOrder] = useState(String(fallbackPriority(model) ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    const metadata = { ...model.metadata };
    if (model.kind === 'llm') {
      if (backup) {
        const priority = Number(backupOrder);
        if (!backupOrder.trim() || !Number.isSafeInteger(priority) || priority < 0) { setError('Enter a non-negative backup priority.'); return; }
        metadata.fallback_priority = priority;
      } else delete metadata.fallback_priority;
    }
    for (const field of model.settings_schema ?? []) {
      const value = values[field.key]?.trim() ?? '';
      if (!value) { delete metadata[field.key]; continue; }
      if (field.type === 'number' || field.type === 'integer') {
        const number = Number(value);
        if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)) || (field.min != null && number < field.min) || (field.max != null && number > field.max)) {
          setError(`Enter a valid value for ${field.label}.`); return;
        }
        metadata[field.key] = number;
      } else metadata[field.key] = value;
    }
    setBusy(true);
    try {
      await updateDbModel(model.id, { display_name: name.trim() || null, metadata,
        ...(model.kind === 'llm' ? { tier_hint: hint.trim() || null,
          ...(auto ? { input_modalities_source: 'auto' as const } : { input_modalities: inputs }) } : {}),
      });
      await onChanged(); onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <ModalShell visible width={760} title={model.display_name || model.model}
    subtitle={`${provider.label || provider.metadata?.label || provider.name} · ${KIND_LABELS[model.kind]}`} onClose={busy ? () => {} : onClose}
    footer={<><Button variant="ghost" label="Cancel" disabled={busy} onPress={onClose} /><View style={{ flex: 1 }} /><Button label={busy ? 'Saving…' : 'Save settings'} disabled={busy} onPress={() => { void save(); }} /></>}>
    <Field label="Display name" value={name} onChangeText={setName} />
    {model.kind === 'llm' && <>
      <Field label="When to use this model" value={hint} onChangeText={setHint} hint="Helps the default model choose when to delegate." />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Detect supported inputs automatically</Text>
        <ThemedSwitch value={auto} onValueChange={setAuto} accessibilityLabel="Automatic supported inputs" />
      </View>
      <ModalityChips value={inputs} onChange={auto ? undefined : setInputs} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Use as a backup model</Text>
        <ThemedSwitch value={backup} onValueChange={setBackup} accessibilityLabel="Use as backup" />
      </View>
      {backup && <Field label="Backup priority" value={backupOrder} onChangeText={setBackupOrder} keyboardType="numeric" hint="Lower numbers are tried first when the primary model fails or is rate limited." />}
    </>}
    {(model.settings_schema ?? []).length === 0 && <Text style={{ color: colors.textSecondary, fontSize: 14 }}>This provider has not declared configurable parameters for this model.</Text>}
    {(model.settings_schema ?? []).map((field) => field.type === 'enum' ? <View key={field.key} style={{ gap: 8 }}>
      <Text style={{ color: colors.text, fontSize: 14 }}>{field.label}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {['', ...(field.options ?? [])].map((value) => <Chip key={value} label={value || 'Provider default'} active={values[field.key] === value} onPress={() => setValues((old) => ({ ...old, [field.key]: value }))} />)}
      </View>
    </View> : <Field key={field.key} label={field.label} value={values[field.key]} placeholder="Provider default" keyboardType={field.type === 'number' || field.type === 'integer' ? 'numeric' : 'default'} onChangeText={(value) => setValues((old) => ({ ...old, [field.key]: value }))} />)}
    <Text style={{ color: colors.textSecondary, fontSize: 13 }}>Blank values inherit the provider default. Zero is an explicit value.</Text>
    <InlineError>{error}</InlineError>
    {model.metadata?.budget_model_group ? <BudgetsPanel routingSupported={model.kind === 'llm'} scopeKind="model" scopeValue={String(model.metadata.budget_model_group)} scopeTitle="Inherited model budget" defaultMetric={provider.access === 'subscription' ? 'tokens' : 'cost_usd'} /> : null}
    <BudgetsPanel routingSupported={model.kind === 'llm'} scopeKind="model" scopeValue={model.runtime_id} scopeTitle={`${name || model.model} · Model budget`} defaultMetric={provider.access === 'subscription' ? 'tokens' : 'cost_usd'} />
  </ModalShell>;
}
