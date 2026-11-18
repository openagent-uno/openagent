/** Provider-first management: independent connections/accounts, with typed models inside. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { BudgetUsage, DailyUsageEntry, ModelEntry, ModelKind, ProviderAccounts, ProviderConfig } from '../../../common/types';
import { colors, font } from '../../theme';
import { deleteDbModel, deleteProvider, disableDbModel, enableDbModel, getDailyUsage, getProviders, getProviderConnectionContract, listBudgetUsage,
  listDbModels, listServingAccounts, refreshProviderCapabilities, setClassifierModel, testProvider,
  updateProvider, updateSubscriptionAccount } from '../../services/api';
import { useConnection } from '../../stores/connection';
import Button from '../Button';
import Notice from '../Notice';
import EmptyState from '../EmptyState';
import ThemedSwitch from '../ThemedSwitch';
import BudgetsPanel from '../BudgetsPanel';
import { Grid, columnsForWidth } from '../TileGrid';
import { useConfirm } from '../ConfirmDialog';
import ProviderTile from './ProviderTile';
import ProviderMark from './ProviderMark';
import ConnectProviderDialog from './ConnectProviderDialog';
import ProviderModelCatalog from './ProviderModelCatalog';
import ModelSettingsDialog from './ModelSettingsDialog';
import ModelEditDialog from './ModelEditDialog';
import AddModelWizard from './AddModelWizard';
import SubscriptionSignIn from './SubscriptionSignIn';
import BudgetMeter from './BudgetMeter';
import { Chip, Field, ModalShell, ModalityChips } from './ui';
import { ACCESS_LABELS, KIND_LABELS, KIND_ORDER, errorMessage, fallbackPriority, modelModalities } from './modelHelpers';
import { connectionCards, connectionInfo, vendorLabel, type ConnectionCard } from './connectionHelpers';

export default function ProviderGrid({ onNavigate }: { onNavigate?: () => void } = {}) {
  const config = useConnection((s) => s.config);
  const confirm = useConfirm();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [accounts, setAccounts] = useState<ProviderAccounts[] | null>(null);
  const [budgets, setBudgets] = useState<BudgetUsage[] | null>(null);
  const [usage, setUsage] = useState<DailyUsageEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'models' | 'budget' | 'connection'>('models');
  const [kind, setKind] = useState<ModelKind | 'all'>('all');
  const [connecting, setConnecting] = useState(false);
  const [connectionContract, setConnectionContract] = useState<boolean | null>(null);
  const [catalog, setCatalog] = useState<ProviderConfig | null>(null);
  const [editing, setEditing] = useState<ModelEntry | null>(null);
  const [budgetGroup, setBudgetGroup] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  useEffect(() => { if (notice || error) onNavigate?.(); }, [notice, error, onNavigate]);

  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    if (!config) return;
    const generation = ++loadGeneration.current;
    const current = () => generation === loadGeneration.current;
    const catalog = Promise.allSettled([getProviders(), listDbModels()]);
    void getProviderConnectionContract().then((value) => { if (current()) setConnectionContract(value.version === 1); }, () => { if (current()) setConnectionContract(false); });
    // Enrichment must never hold the usable catalog behind a slow quota probe.
    void listServingAccounts().then((value) => { if (current()) setAccounts(value); }, () => { if (current()) setAccounts(null); });
    void listBudgetUsage().then((value) => { if (current()) setBudgets(value); }, () => { if (current()) setBudgets(null); });
    void getDailyUsage(30).then((value) => { if (current()) setUsage(value); }, () => { if (current()) setUsage(null); });
    const [p, m] = await catalog;
    if (!current()) return;
    if (p.status === 'fulfilled') setProviders(p.value);
    if (m.status === 'fulfilled') setModels(m.value.filter((row) => row.id > 0));
    setError(p.status === 'rejected' ? errorMessage(p.reason) : m.status === 'rejected' ? errorMessage(m.reason) : null);
    setLoading(false);
  }, [config]);
  useFocusEffect(useCallback(() => { void load(); const timer = setInterval(() => { void load(); }, 60_000); return () => { loadGeneration.current += 1; clearInterval(timer); }; }, [load]));
  const cards = useMemo(() => connectionCards(providers, models, accounts), [providers, models, accounts]);
  const active = cards.find((c) => c.key === selected) ?? null;
  const groups = useMemo(() => {
    const result = new Map<string, ConnectionCard[]>();
    for (const card of cards) {
      if (!`${card.vendor} ${card.label} ${card.access}`.toLowerCase().includes(search.toLowerCase())) continue;
      result.set(card.vendor, [...(result.get(card.vendor) ?? []), card]);
    }
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [cards, search]);
  const cols = Math.min(3, columnsForWidth(width));
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); await load(); return true; }
    catch (e) { setError(errorMessage(e)); return false; }
    finally { setBusy(false); }
  };
  const open = (card: ConnectionCard) => {
    setSelected(card.key); setTab('models'); setKind('all'); setApiKey(''); setEndpoint(card.provider.base_url || '');
    setNotice(null); setError(null); onNavigate?.();
  };
  const selectTab = (next: typeof tab) => { setTab(next); setNotice(null); setError(null); onNavigate?.(); };
  const toggle = (card: ConnectionCard) => run(async () => {
    if (card.account && connectionInfo(card.provider).access === 'subscription') {
      const enabled = card.provider.enabled && (card.account as { enabled?: boolean }).enabled !== false;
      await updateSubscriptionAccount(card.provider.id, card.account.id, { enabled: !enabled });
      if (!enabled && !card.provider.enabled) await updateProvider(card.provider.id, { enabled: true });
    } else if (card.account) {
      throw new Error('This external subscription pool manages its accounts at the source. Connect the account directly to manage it here.');
    } else await updateProvider(card.provider.id, { enabled: !card.provider.enabled });
  });
  const removeModel = async (model: ModelEntry) => {
    if (!await confirm({ title: 'Remove model', message: `Remove ${model.display_name || model.model}? The connection and other models stay available.`, confirmLabel: 'Remove', confirmVariant: 'danger' })) return false;
    const removed = await run(() => deleteDbModel(model.id));
    if (removed) setEditing(null);
    return removed;
  };
  const removeConnection = async (card: ConnectionCard) => {
    if (!await confirm({ title: 'Remove connection', message: `Remove ${card.label} and its ${card.models.length} models? Other connections stay available. The subscription is not cancelled.`, confirmLabel: 'Remove', confirmVariant: 'danger' })) return;
    await run(async () => { for (const provider of card.providers) await deleteProvider(provider.id); setSelected(null); });
  };
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return <View style={styles.wrap} onLayout={onLayout}>
    {error && <Notice tone="error" onDismiss={() => setError(null)}>{error}</Notice>}
    {notice && <Notice tone="success" onDismiss={() => setNotice(null)}>{notice}</Notice>}
    {active ? <>
      <Button variant="ghost" icon="arrow-left" label="All providers" onPress={() => { setSelected(null); setNotice(null); setError(null); onNavigate?.(); }} />
      <View style={styles.header}>
        <ProviderMark vendor={active.vendor} access={active.access} />
        <View style={{ flex: 1 }}><Text style={styles.title}>{active.label}</Text><Text style={styles.subtitle}>{vendorLabel(active.vendor)} · {ACCESS_LABELS[active.access]}</Text></View>
        <ThemedSwitch value={active.provider.enabled && active.account?.enabled !== false} disabled={busy} onValueChange={() => { void toggle(active); }} accessibilityLabel="Enable connection" />
      </View>
      <View style={styles.row}>
        <Chip label="Models" active={tab === 'models'} onPress={() => selectTab('models')} />
        <Chip label="Usage & budget" active={tab === 'budget'} onPress={() => selectTab('budget')} />
        <Chip label="Connection" active={tab === 'connection'} onPress={() => selectTab('connection')} />
      </View>
      {tab === 'models' && <>
        <View style={styles.header}><Text style={styles.section}>Models</Text><Button icon="plus" label="Add models" disabled={connectionContract === null} onPress={() => connectionContract ? setCatalog(active.provider) : setConnecting(true)} /></View>
        <View style={styles.row}>{(['all', ...KIND_ORDER] as const).map((k) => <Chip key={k} label={k === 'all' ? 'All' : KIND_LABELS[k]} active={kind === k} count={active.models.filter((m) => k === 'all' || m.kind === k).length} onPress={() => setKind(k)} />)}</View>
        <Grid cols={Math.min(cols, 2)}>{active.models.filter((m) => kind === 'all' || m.kind === kind).map((model) => <View key={model.id} style={styles.model} testID={`model-card-${model.id}`}>
          <View style={styles.header}><Text style={styles.modelName}>{model.display_name || model.model}</Text><ThemedSwitch value={model.enabled} disabled={busy} onValueChange={() => { void run(() => model.enabled ? disableDbModel(model.id) : enableDbModel(model.id)); }} accessibilityLabel={`Enable model ${model.model}`} /></View>
          <Text style={styles.subtitle}>{KIND_LABELS[model.kind]}{model.is_classifier ? ' · Default' : ''}{fallbackPriority(model) !== null ? ` · Backup ${fallbackPriority(model)}` : ''}{!active.provider.enabled ? ' · Connection disabled' : ''}</Text>
          {model.kind === 'llm' && <ModalityChips value={modelModalities(model).list} compact />}
          {budgets?.filter((rule) => rule.enabled && rule.scope_kind === 'model' && (rule.scope_value === model.runtime_id || rule.scope_value === model.metadata?.budget_model_group)).map((rule) => <BudgetMeter key={rule.id} rule={rule} />)}
          <View style={styles.row}><Button variant="ghost" label="Settings & budget" disabled={connectionContract === null} onPress={() => setEditing(model)} />
            {model.kind === 'llm' && !model.is_classifier && model.enabled && active.provider.enabled && <Button variant="ghost" label="Make default" onPress={() => { void run(() => setClassifierModel(model.id)); }} />}
            <Button variant="ghost" icon="trash-2" accessibilityLabel={`Remove model ${model.model}`} onPress={() => { void removeModel(model); }} /></View>
        </View>)}</Grid>
        {active.models.length === 0 && <Text style={styles.subtitle}>No models configured. Add text, image, speech or transcription models from this connection.</Text>}
      </>}
      {tab === 'budget' && <>
        <Text style={styles.subtitle}>This connection's budget is shared by its models. Each model can also have its own limit. Subscription quota is reported separately.</Text>
        {active.vendor !== active.provider.name && active.vendor !== active.provider.metadata?.budget_group ? <BudgetsPanel scopeKind="provider" scopeValue={active.vendor} scopeTitle="Shared provider budget" defaultMetric="tokens" /> : null}
        {active.provider.metadata?.budget_group && active.provider.metadata.budget_group !== active.provider.name ? <BudgetsPanel scopeKind="provider" scopeValue={String(active.provider.metadata.budget_group)} scopeTitle="Shared provider budget" defaultMetric="tokens" /> : null}
        <BudgetsPanel key={active.provider.id} scopeKind="provider" scopeValue={active.provider.name} scopeTitle={`${active.label} · Connection budget`} defaultMetric={active.access === 'subscription' ? 'tokens' : 'cost_usd'} />
      </>}
      {tab === 'connection' && <View style={styles.connection}>
        {active.access === 'subscription' ? <>
          <Text style={styles.section}>{active.label}</Text>
          <Text style={styles.subtitle}>{active.account ? 'Account connected. Sign in again to renew access.' : 'Sign in to connect this account.'}</Text>
          <SubscriptionSignIn providerId={active.provider.id} label={active.account ? 'Sign in again' : 'Sign in'} onDone={load} />
          <Text style={styles.subtitle}>To use another account at the same time, add a separate connection.</Text>
        </> : <>
          <Text style={styles.subtitle}>Saved key: {active.provider.api_key_display || 'Not set'}</Text>
          {active.access === 'api' && <Field label="Replace API key" value={apiKey} onChangeText={setApiKey} secureTextEntry placeholder="Leave empty to keep the saved key" />}
          <Field label="Endpoint" value={endpoint} onChangeText={setEndpoint} autoCapitalize="none" placeholder={active.access === 'local' ? 'http://localhost:11434/v1' : 'Provider default'} />
          <Button label="Save connection" disabled={busy} onPress={() => { void run(() => updateProvider(active.provider.id, { base_url: endpoint.trim(), ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) })); }} />
        </>}
        <View style={styles.row}><Button variant="secondary" label="Refresh capabilities" disabled={busy} onPress={() => { void run(async () => { const result = await refreshProviderCapabilities(active.provider.id); setNotice(result.reachable ? 'Model capabilities refreshed.' : 'Provider did not report a catalog. Saved capabilities were kept.'); }); }} />
          <Button variant="secondary" label="Test connection" disabled={busy} onPress={() => { void run(async () => { const result = await testProvider(active.provider.id); if (result.ok) setNotice('Connection works.'); else throw new Error('Connection test failed.'); }); }} />
          <Button variant="danger" label="Remove connection" disabled={busy} onPress={() => { void removeConnection(active); }} /></View>
      </View>}
    </> : <>
      <View style={styles.header}><View style={{ flex: 1 }}><Text style={styles.title}>Models & providers</Text><Text style={styles.subtitle}>Accounts and API connections work side by side. Open one to manage its models.</Text></View><Button label="Connect provider" icon="plus" disabled={connectionContract === null} onPress={() => setConnecting(true)} /></View>
      <Field label="Search connections" placeholder="Provider, account or connection" value={search} onChangeText={setSearch} />
      {loading && <Text style={styles.subtitle}>Loading connections…</Text>}
      <Grid cols={cols}>{groups.flatMap(([vendor, group]) => group.map((card) => <ProviderTile key={card.key} card={card} budgets={budgets} usage={usage} busy={busy} onOpen={() => open(card)} onProviderBudget={() => setBudgetGroup(vendor)} onToggle={() => { void toggle(card); }} />))}</Grid>
      {!loading && !providers.length && <EmptyState icon="cpu" title="Connect your first provider" message="Add an API key, a subscription account or a local server, then choose its models." />}
      {!loading && providers.length > 0 && !groups.length && <Text style={styles.subtitle}>No connections match your search.</Text>}
      <Text style={styles.subtitle}>Each card represents one connection or subscription account. Disabling it keeps its settings.</Text>
    </>}
    {budgetGroup && <ModalShell visible title={`${vendorLabel(budgetGroup)} · Shared budget`} width={760} onClose={() => setBudgetGroup(null)}>
      <Text style={styles.subtitle}>Applies to every connection in this provider group. Each account and model can also have its own limit.</Text>
      <BudgetsPanel scopeKind="provider" scopeValue={budgetGroup} scopeTitle={`${vendorLabel(budgetGroup)} · All connections`} defaultMetric="tokens" />
    </ModalShell>}
    {connecting && connectionContract === false && <AddModelWizard visible providers={providers} models={models} accounts={accounts} onClose={() => setConnecting(false)} onChanged={load} reloadAccounts={load} />}
    {connecting && connectionContract === true && <ConnectProviderDialog onClose={() => { setConnecting(false); void load(); }} onCreated={(provider) => { setConnecting(false); setCatalog(provider); void load(); }} />}
    {catalog && <ProviderModelCatalog provider={catalog} models={models} onClose={() => setCatalog(null)} onChanged={load} />}
    {editing && active && connectionContract === false && <ModelEditDialog model={editing} provider={providers.find((p) => p.id === editing.provider_id) ?? null} accounts={active.accounts} access={active.access} providerModelCount={active.models.length} onClose={() => setEditing(null)} onChanged={load} onDeleteModel={removeModel} />}
    {editing && active && connectionContract === true && <ModelSettingsDialog key={editing.id} model={editing} provider={active.provider} onClose={() => setEditing(null)} onChanged={load} />}
  </View>;
}
const styles = StyleSheet.create({
  wrap: { gap: 22 }, header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 28, fontFamily: font.display, fontWeight: '600', letterSpacing: -0.5 },
  subtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 }, section: { color: colors.text, fontSize: 21, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  model: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 20, gap: 14, minHeight: 210 },
  modelName: { color: colors.text, fontSize: 18, fontWeight: '600', flex: 1 }, connection: { gap: 20 },
});
