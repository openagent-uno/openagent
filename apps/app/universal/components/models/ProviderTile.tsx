import { StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { BudgetUsage, DailyUsageEntry } from '../../../common/types';
import { colors } from '../../theme';
import Button from '../Button';
import ThemedSwitch from '../ThemedSwitch';
import { accountState, formatDuration, quotaWindows } from '../accountQuota';
import type { ConnectionCard } from './connectionHelpers';
import { vendorLabel } from './connectionHelpers';
import { ACCESS_LABELS } from './modelHelpers';
import BudgetMeter from './BudgetMeter';
import ProviderMark from './ProviderMark';

export default function ProviderTile({ card, budgets, usage, busy, onOpen, onToggle, onProviderBudget }: {
  card: ConnectionCard; budgets: BudgetUsage[] | null; usage: DailyUsageEntry[] | null; busy: boolean; onOpen: () => void; onToggle: () => void; onProviderBudget: () => void;
}) {
  const { provider, account, access } = card;
  const enabled = provider.enabled && (account as { enabled?: boolean } | null)?.enabled !== false;
  const state = account ? accountState(account) : null;
  // API vendors do not implement the subscription-account probe. Its negative
  // result says nothing about their inference endpoint.
  const reachable = access === 'api' ? undefined : card.accounts?.reachable;
  const status = !enabled ? 'Disabled' : access === 'subscription' && !card.accounts ? 'Account status unavailable' : state === 'auth_expired' ? 'Sign-in expired'
    : state === 'rate_limited' ? 'Rate limited' : reachable === false ? 'Not reachable'
      : account ? 'Connected' : access === 'subscription' ? 'Sign in to connect' : 'Configured';
  const warning = state === 'auth_expired' || state === 'rate_limited' || reachable === false;
  const statusColor = !enabled ? colors.textMuted : warning ? colors.warning : account ? colors.success : colors.textSecondary;
  const rules = budgets?.filter((b) => b.enabled && b.scope_kind === 'provider' && (card.providers.some((p) => b.scope_value === p.name || b.scope_value === p.metadata?.budget_group) || b.scope_value === provider.metadata?.budget_group || b.scope_value === card.vendor)) ?? [];
  const windows = account ? quotaWindows(account) : [];
  const refs = new Set(card.models.map((m) => m.runtime_id));
  const reported = usage?.filter((row) => refs.has(row.model)) ?? [];
  const tokens = reported.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0);
  const spend = reported.reduce((sum, row) => sum + row.cost, 0);
  return <View style={[styles.tile, !enabled && styles.disabled]} testID={`provider-card-${card.key}`}>
    <View style={styles.head}>
      <ProviderMark vendor={card.vendor} access={access} />
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={2}>{card.label}</Text>
        <Text style={styles.meta}>{access === 'subscription' ? card.vendor === 'openai' ? 'Codex' : card.vendor === 'anthropic' ? 'Claude' : vendorLabel(card.vendor) : vendorLabel(card.vendor)} · {ACCESS_LABELS[access]}</Text>
      </View>
      <ThemedSwitch value={enabled} disabled={busy} onValueChange={onToggle} accessibilityLabel={`Enable ${card.label} ${card.vendor}`} />
    </View>
    <View style={styles.status}>
      <Feather name={!enabled ? 'pause-circle' : warning ? 'alert-triangle' : account ? 'check-circle' : 'circle'} size={16} color={statusColor} />
      <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
    </View>
    <Text style={styles.meta}>{card.models.filter((m) => m.enabled).length} of {card.models.length} models enabled</Text>
    <View style={styles.usage}>
      {usage === null ? <Text style={styles.meta}>Usage unavailable</Text> : reported.length ? <>
        <Text style={styles.meta}>Tracked text · 30 days · {new Intl.NumberFormat('en', { notation: 'compact' }).format(tokens)} tokens</Text>
        {access === 'api' && <Text style={styles.meta}>Recorded text cost · ${spend.toFixed(2)}{spend === 0 ? ' · pricing may be unavailable' : ' · estimated'}</Text>}
      </> : <Text style={styles.meta}>{card.models.some((model) => model.kind === 'llm') ? 'No text usage reported' : 'Image/audio usage is not metered here'}</Text>}
      {access === 'subscription' ? windows.length ? windows.map((w) => <View key={w.label} style={styles.window}>
        <View style={styles.between}><Text style={styles.meta}>{w.label}</Text><Text style={styles.amount}>{w.usedPercent}% used</Text></View>
        <View style={styles.track}><View style={[styles.fill, { width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }]} /></View>
        {w.resetAfterS != null && w.resetAfterS > 0 && <Text style={styles.meta}>Resets in {formatDuration(w.resetAfterS)}</Text>}
      </View>) : <Text style={styles.meta}>Quota not reported</Text> : null}
      {rules.slice(0, 1).map((rule) => <BudgetMeter key={rule.id} rule={rule} />)}
      {budgets === null ? <Text style={styles.meta}>Budget data unavailable</Text> : rules.length === 0 ? <Text style={styles.meta}>No connection budget</Text> : null}
    </View>
    <View style={styles.footer}><Button variant="ghost" label="Models & settings" icon="arrow-right" iconPosition="right" onPress={onOpen} /><Button variant="ghost" label="Provider budget" onPress={onProviderBudget} /></View>
  </View>;
}
const styles = StyleSheet.create({
  tile: { flex: 1, minHeight: 282, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 20, gap: 12 },
  disabled: { opacity: 0.7 }, head: { flexDirection: 'row', alignItems: 'center', gap: 10 }, identity: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 19, fontWeight: '600', marginBottom: 4 }, meta: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7 }, statusText: { fontSize: 14, fontWeight: '500' },
  usage: { flex: 1, gap: 12, paddingTop: 8 }, footer: { borderTopWidth: 1, borderTopColor: colors.borderLight, paddingTop: 8, marginTop: 6, gap: 8, alignItems: 'flex-start' },
  window: { gap: 7 }, between: { flexDirection: 'row', justifyContent: 'space-between' }, amount: { color: colors.text, fontSize: 13, fontWeight: '600' },
  track: { height: 6, backgroundColor: colors.border, borderRadius: 4, overflow: 'hidden' }, fill: { height: 6, backgroundColor: colors.primary, borderRadius: 4 },
});
