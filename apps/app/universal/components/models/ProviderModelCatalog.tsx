/** The same catalog, discriminator and create contract for text, image, TTS and STT. */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AvailableModel, ModelEntry, ModelKind, ProviderConfig } from '../../../common/types';
import { colors } from '../../theme';
import { createDbModel, listAvailableModels } from '../../services/api';
import Button from '../Button';
import { Chip, Field, InlineError, ModalShell } from './ui';
import { errorMessage, KIND_LABELS, KIND_ORDER, nextFallbackPriority } from './modelHelpers';

export default function ProviderModelCatalog({ provider, models, onClose, onChanged }: {
  provider: ProviderConfig; models: ModelEntry[]; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<AvailableModel[] | null>(null);
  const [kind, setKind] = useState<ModelKind>('llm');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState('');
  const [roles, setRoles] = useState<Record<string, 'normal' | 'default' | 'backup'>>({});
  const roleChips = (id: string) => <View style={styles.row}>{(['normal', 'default', 'backup'] as const).map((role) => <Chip key={role} label={role === 'default' ? 'Default' : role === 'backup' ? 'Backup' : 'Normal'} active={(roles[id] ?? 'normal') === role} onPress={() => setRoles((old) => ({ ...Object.fromEntries(Object.entries(old).map(([key, value]) => [key, role === 'default' && value === 'default' ? 'normal' : value])), [id]: role }))} />)}</View>;
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void listAvailableModels(provider.id).then((list) => { if (live) setEntries(list); },
    (e) => { if (live) { setEntries([]); setError(errorMessage(e)); } }); return () => { live = false; }; }, [provider.id]);
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const ids = [...selected];
      if (manual.trim() && !ids.includes(manual.trim())) ids.push(manual.trim());
      let backup = nextFallbackPriority(models);
      for (const id of ids) {
        const entry = entries?.find((e) => e.id === id);
        const modelKind = entry?.kind ?? kind;
        const role = modelKind === 'llm' ? roles[id] : 'normal';
        await createDbModel({ provider_id: provider.id, model: id, kind: modelKind,
          ...(role === 'default' ? { is_classifier: true } : {}),
          ...(role === 'backup' ? { metadata: { fallback_priority: backup++ } } : {}),
          ...(entry?.detected_input_modalities ? { input_modalities: entry.detected_input_modalities,
            input_modalities_source: entry.detected_input_modalities_source } : {}),
        });
        // A partial failure keeps already committed registrations out of the retry set.
        setSelected((old) => { const next = new Set(old); next.delete(id); return next; });
        setEntries((old) => old?.map((e) => e.id === id ? { ...e, added: true } : e) ?? old);
        if (id === manual.trim()) setManual('');
      }
      await onChanged(); onClose();
    } catch (e) { setError(errorMessage(e)); await onChanged(); }
    finally { setBusy(false); }
  };
  const shown = entries?.filter((e) => (e.kind ?? 'llm') === kind && `${e.id} ${e.display_name ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return <ModalShell visible title="Add models" subtitle={`${provider.label || provider.metadata?.label || provider.name}`} onClose={busy ? () => {} : onClose} width={760}
    footer={<><Button variant="ghost" label="Cancel" disabled={busy} onPress={onClose} /><View style={{ flex: 1 }} /><Button label={busy ? 'Adding…' : `Add ${selected.size + (manual.trim() && !selected.has(manual.trim()) ? 1 : 0)} models`} disabled={busy || (!selected.size && !manual.trim())} onPress={() => { void add(); }} /></>}>
    <View style={styles.row}>{KIND_ORDER.map((k) => <Chip key={k} label={KIND_LABELS[k]} active={kind === k} onPress={() => setKind(k)} />)}</View>
    <Field label="Search catalog" value={query} onChangeText={setQuery} />
    {entries === null ? <Text style={styles.hint}>Reading provider catalog…</Text> : shown?.length === 0 ? <Text style={styles.hint}>No models of this type reported. Add an ID below if your provider supports it.</Text> : shown?.map((e) => <View key={e.id} style={styles.entry}>
      <View style={{ flex: 1 }}><Text style={styles.name}>{e.display_name || e.id}</Text><Text style={styles.hint}>{e.id}</Text>{selected.has(e.id) && (e.kind ?? 'llm') === 'llm' && roleChips(e.id)}</View>
      <Chip label={e.added ? 'Added' : selected.has(e.id) ? 'Selected' : 'Select'} active={selected.has(e.id)} disabled={e.added || busy} onPress={() => setSelected((old) => { const next = new Set(old); if (next.has(e.id)) next.delete(e.id); else next.add(e.id); return next; })} />
    </View>)}
    <Field label={`Manual model ID · ${KIND_LABELS[kind]}`} value={manual} onChangeText={setManual} autoCapitalize="none" hint="The type applies to this model, not to the connection." />
    {kind === 'llm' && manual.trim() ? roleChips(manual.trim()) : null}
    <InlineError>{error}</InlineError>
  </ModalShell>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, entry: { flexDirection: 'row', alignItems: 'center', gap: 16, borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: 14 },
  name: { color: colors.text, fontSize: 15 }, hint: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 } });
