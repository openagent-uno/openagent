/**
 * UnusedProviders — provider rows that have no models yet.
 *
 * In the grid a provider shows through its models, so one without models
 * would vanish, and with it the only way to test, turn off or remove its
 * credential. These rows keep it in sight, with its accounts when it is a
 * subscription.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, radius } from '../../theme';
import type { ProviderAccounts, ProviderConfig } from '../../../common/types';
import PopupMenu, { type PopupMenuItem } from '../PopupMenu';
import { useConfirm } from '../ConfirmDialog';
import {
  deleteProvider, refreshProviderCapabilities, testProvider, updateProvider,
} from '../../services/api';
import { ACCESS_LABELS, connectionStatus, errorMessage, type Access, type ModelStatus } from './modelHelpers';
import { ProviderAccountsDetail } from './ModelEditDialog';
import { Badge, SectionLabel } from './ui';

export interface UnusedProvider {
  provider: ProviderConfig;
  entry: ProviderAccounts | null;
  access: Access;
}

export default function UnusedProviders({
  rows, onChanged, onAddModel, onMessage,
}: {
  rows: UnusedProvider[];
  onChanged: () => Promise<void> | void;
  onAddModel: () => void;
  onMessage: (text: string, tone: 'info' | 'error') => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);
  if (rows.length === 0) return null;

  const act = async (id: number, action: () => Promise<void>) => {
    setBusy(id);
    try {
      await action();
    } catch (e) {
      onMessage(errorMessage(e), 'error');
    }
    setBusy(null);
    await onChanged();
  };

  const menuFor = ({ provider: p }: UnusedProvider): PopupMenuItem[] => {
    const items: PopupMenuItem[] = [
      { label: 'Add model', icon: 'plus', onPress: onAddModel },
    ];
    if (p.kind === 'llm') {
      items.push({
        label: 'Test connection', icon: 'activity',
        onPress: () => {
          void act(p.id, async () => {
            const r = await testProvider(p.id);
            onMessage(r.ok ? `${p.name}: connection works.` : `${p.name}: connection failed. ${r.error ?? ''}`.trim(),
              r.ok ? 'info' : 'error');
          });
        },
      });
      items.push({
        label: 'Refresh from provider', icon: 'refresh-cw',
        onPress: () => { void act(p.id, async () => { await refreshProviderCapabilities(p.id); }); },
      });
    }
    items.push(
      {
        label: p.enabled ? 'Turn provider off' : 'Turn provider on', icon: 'power',
        onPress: () => { void act(p.id, async () => { await updateProvider(p.id, { enabled: !p.enabled }); }); },
      },
      {
        label: 'Remove provider', icon: 'trash-2', destructive: true,
        onPress: () => {
          void (async () => {
            const ok = await confirm({
              title: 'Remove provider',
              message: `Remove "${p.name}"? This cannot be undone.`,
              confirmLabel: 'Remove',
              confirmVariant: 'danger',
            });
            if (ok) await act(p.id, () => deleteProvider(p.id));
          })();
        },
      },
    );
    return items;
  };

  return (
    <View style={styles.wrap}>
      <SectionLabel>Providers with no models</SectionLabel>
      {rows.map((row) => {
        const { provider: p, entry, access } = row;
        const status: ModelStatus | null = connectionStatus(entry, access)
          ?? (p.enabled ? null : { label: 'Off', tone: 'muted' });
        return (
          <View key={p.id} style={[styles.row, busy === p.id && { opacity: 0.6 }]}>
            <View style={styles.head}>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                  <Badge label={ACCESS_LABELS[access]} tone={access === 'subscription' ? 'primary' : 'neutral'} />
                  {status ? (
                    <Text style={[
                      styles.status,
                      status.tone === 'danger' && { color: colors.error },
                      status.tone === 'warning' && { color: colors.warning },
                    ]}>{status.label}</Text>
                  ) : null}
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {[p.base_url || 'Vendor default URL', `Key ${p.api_key_display || '—'}`].join('  ·  ')}
                </Text>
              </View>
              <PopupMenu items={menuFor(row)} accessibilityLabel={`Options for provider ${p.name}`} triggerSize={16} />
            </View>
            {entry && entry.accounts.length > 0 ? <ProviderAccountsDetail entry={entry} /> : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 6 },
  row: {
    gap: 10, padding: 12,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { fontSize: 13, fontWeight: '600', color: colors.text, fontFamily: font.mono },
  status: { fontSize: 11.5, color: colors.textMuted },
  meta: { fontSize: 11, color: colors.textMuted, fontFamily: font.mono },
});
