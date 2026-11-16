/**
 * ModelGrid — every configured model, of every type, in one grid.
 *
 * Replaces the old Providers / Accounts / Models sections. A provider is no
 * longer something you manage on its own: it is how a model is reached, so
 * it shows on the tile (Subscription / Local / API) and is managed from the
 * model's edit dialog. New models come in through the Add model wizard.
 *
 * /api/accounts is polled every 60 s, as the Accounts panel did, so a
 * rate limit or an expired sign-in shows on the tiles while the screen is
 * open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { colors, font } from '../../theme';
import type { ModelEntry, ModelKind, ProviderAccounts, ProviderConfig } from '../../../common/types';
import { useConnection } from '../../stores/connection';
import {
  deleteDbModel, disableDbModel, enableDbModel, getProviders, isUnsupportedByAgent,
  listDbModels, listServingAccounts, refreshProviderCapabilities, setBaseUrl,
  setClassifierModel, unsetClassifierModel,
} from '../../services/api';
import Button from '../Button';
import EmptyState from '../EmptyState';
import Notice from '../Notice';
import { useConfirm } from '../ConfirmDialog';
import type { PopupMenuItem } from '../PopupMenu';
import { Grid, columnsForWidth } from '../TileGrid';
import ModelTile, { AddModelTile } from './ModelTile';
import ModelEditDialog from './ModelEditDialog';
import AddModelWizard from './AddModelWizard';
import UnusedProviders, { type UnusedProvider } from './UnusedProviders';
import {
  KIND_LABELS, KIND_ORDER, accessFor, accountsFor, errorMessage, isSubscription, modelStatus,
} from './modelHelpers';
import { Chip } from './ui';

type Filter = 'all' | ModelKind;

export default function ModelGrid() {
  const connConfig = useConnection((s) => s.config);
  const confirm = useConfirm();
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  // null = this agent does not report accounts (older server or a failure).
  const [accounts, setAccounts] = useState<ProviderAccounts[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [width, setWidth] = useState(0);
  // Providers that reported accounts at some point this session. A proxy
  // that goes down reports none, and should read "Not reachable", not "API".
  const knownSubscriptions = useRef(new Set<number>());

  const load = useCallback(async () => {
    if (!connConfig) return;
    const [m, p] = await Promise.allSettled([listDbModels(), getProviders()]);
    if (m.status === 'fulfilled') { setModels(m.value); setError(null); }
    else setError(errorMessage(m.reason));
    if (p.status === 'fulfilled') setProviders(p.value);
  }, [connConfig]);

  const loadAccounts = useCallback(async () => {
    if (!connConfig) return;
    try {
      const list = await listServingAccounts();
      for (const e of list) {
        if (isSubscription(e) && e.provider_id != null) knownSubscriptions.current.add(e.provider_id);
      }
      setAccounts(list);
    } catch (e) {
      // Statuses are an extra; the grid works without them.
      if (!isUnsupportedByAgent(e)) console.warn('accounts', e);
      setAccounts(null);
    }
  }, [connConfig]);

  useEffect(() => {
    if (!connConfig) return;
    if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
    void load();
    void loadAccounts();
  }, [connConfig, load, loadAccounts]);

  // A rate limit lifts on a timer and a sign-in can lapse while the screen
  // is open; 60 s matches the scale those move on.
  useEffect(() => {
    const t = setInterval(() => { void loadAccounts(); }, 60_000);
    return () => clearInterval(t);
  }, [loadAccounts]);

  const reloadAll = useCallback(async () => {
    await Promise.all([load(), loadAccounts()]);
  }, [load, loadAccounts]);

  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);

  const describe = useCallback((m: ModelEntry) => {
    const provider = providerById.get(m.provider_id) ?? null;
    const entry = accountsFor(provider ?? { id: m.provider_id, name: m.provider_name }, accounts);
    const access = accessFor(provider, entry, knownSubscriptions.current.has(m.provider_id));
    return { provider, entry, access, status: modelStatus(m, provider, entry, access) };
  }, [providerById, accounts]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, llm: 0, tts: 0, stt: 0, image: 0 };
    for (const m of models ?? []) { c.all += 1; c[m.kind ?? 'llm'] += 1; }
    return c;
  }, [models]);

  const unused = useMemo<UnusedProvider[]>(() => {
    if (!models) return [];
    const used = new Set(models.map((m) => m.provider_id));
    return providers.filter((p) => !used.has(p.id)).map((p) => {
      const entry = accountsFor(p, accounts);
      return { provider: p, entry, access: accessFor(p, entry, knownSubscriptions.current.has(p.id)) };
    });
  }, [models, providers, accounts]);

  const shown = (models ?? []).filter((m) => filter === 'all' || (m.kind ?? 'llm') === filter);

  // ── Actions ──

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
    await load();
  };

  const deleteModel = async (m: ModelEntry): Promise<boolean> => {
    const ok = await confirm({
      title: 'Delete model',
      message: `Delete "${m.display_name || m.model}"? Its settings are removed. The provider stays.`,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
    });
    if (!ok) return false;
    let done = false;
    await run(async () => { await deleteDbModel(m.id); done = true; });
    return done;
  };

  const refreshFromProvider = async (m: ModelEntry) => {
    setNotice(null);
    await run(async () => {
      const r = await refreshProviderCapabilities(m.provider_id);
      if (!r.reachable) setNotice(`${m.provider_name} did not answer. Nothing changed.`);
      else if (r.updated.length === 0) setNotice(`${m.provider_name} is up to date.`);
      else setNotice(`Updated ${r.updated.length === 1 ? '1 model' : `${r.updated.length} models`} from ${m.provider_name}.`);
    });
    await loadAccounts();
  };

  const menuFor = (m: ModelEntry): PopupMenuItem[] => {
    const items: PopupMenuItem[] = [
      { label: 'Edit', icon: 'edit-2', onPress: () => setEditingId(m.id) },
      {
        label: m.enabled ? 'Turn off' : 'Turn on',
        icon: 'power',
        onPress: () => { void run(() => (m.enabled ? disableDbModel(m.id) : enableDbModel(m.id))); },
      },
    ];
    if ((m.kind ?? 'llm') === 'llm') {
      if (m.is_classifier) {
        items.push({
          label: 'Remove as default', icon: 'star',
          onPress: () => { void run(() => unsetClassifierModel(m.id)); },
        });
      } else if (m.enabled) {
        items.push({
          label: 'Set as default', icon: 'star',
          onPress: () => { void run(() => setClassifierModel(m.id)); },
        });
      }
    }
    items.push(
      { label: 'Refresh from provider', icon: 'refresh-cw', onPress: () => { void refreshFromProvider(m); } },
      { label: 'Delete', icon: 'trash-2', destructive: true, onPress: () => { void deleteModel(m); } },
    );
    return items;
  };

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (Math.abs(w - width) > 1) setWidth(w);
  };
  const cols = columnsForWidth(width);

  const editing = editingId != null ? (models ?? []).find((m) => m.id === editingId) ?? null : null;
  const editingInfo = editing ? describe(editing) : null;

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 200 }}>
          <Text style={styles.title}>Models</Text>
          <Text style={styles.subtitle}>
            Every model this agent can use. Open one to change it or the provider behind it.
          </Text>
        </View>
        <Button variant="primary" size="sm" icon="plus" label="Add model" onPress={() => setAdding(true)} />
      </View>

      <View style={styles.filters}>
        <Chip label="All" count={counts.all} active={filter === 'all'} onPress={() => setFilter('all')} />
        {KIND_ORDER.map((k) => (
          <Chip key={k} label={KIND_LABELS[k]} count={counts[k]} active={filter === k} onPress={() => setFilter(k)} />
        ))}
      </View>

      {error ? <Notice onDismiss={() => setError(null)}>{error}</Notice> : null}
      {notice ? <Notice tone="info" onDismiss={() => setNotice(null)}>{notice}</Notice> : null}

      {models === null ? (
        error ? null : <Text style={styles.muted}>Loading models…</Text>
      ) : models.length === 0 ? (
        <EmptyState
          icon="cpu"
          title="No models yet"
          message="Add a model from a subscription, an API key or a server you run."
          action={{ label: 'Add model', icon: 'plus', onPress: () => setAdding(true) }}
        />
      ) : (
        <Grid cols={cols}>
          {[
            ...shown.map((m) => {
              const info = describe(m);
              const active = m.enabled && m.provider_enabled !== false && info.provider?.enabled !== false;
              return (
                <ModelTile
                  key={m.id}
                  model={m}
                  access={info.access}
                  accounts={info.entry}
                  status={info.status}
                  active={active}
                  menu={menuFor(m)}
                  onPress={() => setEditingId(m.id)}
                />
              );
            }),
            <AddModelTile key="add" onPress={() => setAdding(true)} />,
          ]}
        </Grid>
      )}

      <UnusedProviders
        rows={unused}
        onChanged={reloadAll}
        onAddModel={() => setAdding(true)}
        onMessage={(text, tone) => (tone === 'error' ? setError(text) : setNotice(text))}
      />

      <ModelEditDialog
        model={editing}
        provider={editingInfo?.provider ?? null}
        accounts={editingInfo?.entry ?? null}
        access={editingInfo?.access ?? 'api'}
        providerModelCount={editing ? (models ?? []).filter((m) => m.provider_id === editing.provider_id).length : 0}
        onClose={() => setEditingId(null)}
        onChanged={reloadAll}
        onDeleteModel={deleteModel}
      />
      <AddModelWizard
        visible={adding}
        providers={providers}
        models={models ?? []}
        accounts={accounts}
        onClose={() => setAdding(false)}
        onChanged={load}
        reloadAccounts={loadAccounts}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  header: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 },
  title: {
    fontSize: 18, fontWeight: '500', color: colors.text,
    fontFamily: font.display, letterSpacing: -0.3,
  },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 3, lineHeight: 17 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  muted: { fontSize: 12, color: colors.textMuted, paddingVertical: 24, textAlign: 'center' },
});
