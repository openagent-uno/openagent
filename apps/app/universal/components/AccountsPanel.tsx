/**
 * AccountsPanel — whose subscription is paying for this agent's traffic.
 *
 * A model row says which model answers. This says which ACCOUNT it runs on,
 * whether that account is rate-limited right now, and how much of its window
 * is left. Until this existed the answer lived in `kubectl exec … curl
 * localhost:8787/health`.
 *
 * The panel is careful about one thing above all: **it never invents a
 * headroom number.** A Codex proxy reports a real used-percentage against a
 * real window, so that draws a meter. A Claude proxy reports only
 * limited/not-limited, because Anthropic tells it nothing more — an account
 * is discovered to be spent by receiving a 429. Those accounts say "quota
 * not reported", not 0%. On this screen a made-up number is the one an
 * operator would plan around, which makes it worse than no number.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, font, radius } from '../theme';
import Card from './Card';
import Button from './Button';
import Notice from './Notice';
import EmptyState from './EmptyState';
import { Skeleton } from './Skeleton';
import { listServingAccounts, isUnsupportedByAgent } from '../services/api';
import type { ProviderAccounts, ServingAccount } from '../../common/types';
import {
  accountState, formatDuration, headroomColor, limitedRemainingS, quotaWindows, quotaWindowText,
} from './accountQuota';

// Re-exported: other screens import the formatter from here.
export { formatDuration };

export function AccountRow({ account }: { account: ServingAccount }) {
  const state = accountState(account);
  const windows = quotaWindows(account);
  const remaining = limitedRemainingS(account);
  const q = account.quota;

  return (
    <View style={styles.account}>
      <View style={styles.accountHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.accountName}>{account.name || account.id}</Text>
          <Text style={styles.accountMeta}>
            {[
              account.plan || q?.plan,
              account.priority !== undefined ? `priority ${account.priority}` : null,
              account.request_count !== undefined ? `${account.request_count} requests` : null,
              typeof q?.credits_balance === 'number' ? `${q.credits_balance} credits` : null,
            ].filter(Boolean).join(' · ') || '—'}
          </Text>
        </View>
        {state === 'auth_expired' ? (
          <Badge tone="error" icon="x-octagon" label="Sign-in expired" />
        ) : state === 'rate_limited' ? (
          <Badge
            tone="warning"
            icon="clock"
            label={remaining !== null ? `Limited · ${formatDuration(remaining)}` : 'Limited'}
          />
        ) : (
          <Badge tone="success" icon="check" label="Available" />
        )}
      </View>

      {windows.length > 0 ? (
        windows.map((w) => (
          <View key={w.label} style={{ gap: 4 }}>
            <View style={styles.meterTrack}>
              <View
                style={[
                  styles.meterFill,
                  { width: `${Math.min(100, Math.max(0, w.usedPercent))}%`, backgroundColor: headroomColor(w.usedPercent) },
                ]}
              />
            </View>
            <View style={styles.meterLabels}>
              <Text style={[styles.meterLeft, { color: headroomColor(w.usedPercent) }]}>
                {Math.max(0, 100 - Math.round(w.usedPercent))}% left
              </Text>
              <Text style={styles.meterHint}>{quotaWindowText(w)}</Text>
            </View>
          </View>
        ))
      ) : (
        <Text style={styles.noQuota}>
          Quota not reported by this provider — it only learns an account is
          spent when a request is refused.
        </Text>
      )}
    </View>
  );
}

function Badge({ tone, icon, label }: {
  tone: 'success' | 'warning' | 'error';
  icon: keyof typeof Feather.glyphMap;
  label: string;
}) {
  const tint = tone === 'error' ? colors.error : tone === 'warning' ? colors.warning : colors.success;
  return (
    <View style={styles.badge}>
      <Feather name={icon} size={10} color={tint} />
      <Text style={[styles.badgeText, { color: tint }]}>{label}</Text>
    </View>
  );
}

export default function AccountsPanel() {
  const [providers, setProviders] = useState<ProviderAccounts[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setProviders(await listServingAccounts());
      setError(null);
      setFailed(false);
    } catch (e) {
      setError(isUnsupportedByAgent(e)
        ? 'This agent runs an older OpenAgent that does not expose serving accounts yet. Update the agent and it will appear here.'
        : e instanceof Error ? e.message : String(e));
      setProviders(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A rate limit lifts on a timer and a quota window ticks down, so a panel
  // left open goes stale. 60s: the numbers move on the scale of hours.
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const withAccounts = providers?.filter((p) => p.accounts.length > 0) ?? [];
  const without = providers?.filter((p) => p.accounts.length === 0) ?? [];

  return (
    <View style={styles.content}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Accounts</Text>
          <Text style={styles.subtitle}>
            Which subscription serves each provider, and how much of its
            window is left.
          </Text>
        </View>
        <Button label="Refresh" icon="refresh-cw" size="xs" variant="ghost" onPress={() => { void load(); }} />
      </View>

      {error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}

      {failed ? null : providers === null ? (
        <Card><Skeleton height={90} /></Card>
      ) : withAccounts.length === 0 ? (
        <EmptyState
          icon="users"
          title="No subscription accounts"
          message="No enabled provider points at a proxy that reports accounts. A provider using a plain API key has one credential and nothing to rotate."
        />
      ) : (
        withAccounts.map((p) => (
          <Card key={p.provider} style={styles.card}>
            <View style={styles.providerHead}>
              <Text style={styles.providerName}>{p.provider}</Text>
              {p.metrics ? (
                <Text style={styles.providerMetrics}>
                  {[
                    p.metrics.active !== undefined ? `${p.metrics.active} active` : null,
                    p.metrics.queued ? `${p.metrics.queued} queued` : null,
                    p.metrics.account_switches
                      ? `${p.metrics.account_switches} switches`
                      : null,
                  ].filter(Boolean).join(' · ')}
                </Text>
              ) : null}
            </View>
            {p.accounts.map((a) => (
              <AccountRow key={`${p.provider}-${a.id}`} account={a} />
            ))}
          </Card>
        ))
      )}

      {without.length > 0 && (
        <Card style={styles.card}>
          <Text style={styles.cardTitle}>No accounts reported</Text>
          {without.map((p) => (
            <View key={p.provider} style={styles.quietRow}>
              <Text style={styles.quietName}>{p.provider}</Text>
              <Text style={styles.quietWhy} numberOfLines={1}>
                {p.error || (p.reachable ? 'reachable, no accounts' : 'unreachable')}
              </Text>
            </View>
          ))}
        </Card>
      )}
      <View style={{ height: 40 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title: {
    fontSize: 16, fontWeight: '600', color: colors.text,
    fontFamily: font.display, letterSpacing: -0.3,
  },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 3, lineHeight: 17 },

  card: { gap: 12 },
  cardTitle: {
    fontSize: 11, color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  providerHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  providerName: {
    fontSize: 13, fontWeight: '600', color: colors.text, fontFamily: font.mono,
  },
  providerMetrics: { flex: 1, fontSize: 11, color: colors.textMuted, textAlign: 'right' },

  account: { gap: 6 },
  accountHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  accountName: { fontSize: 13, color: colors.text },
  accountMeta: { fontSize: 11, color: colors.textMuted, marginTop: 1 },

  meterTrack: {
    height: 6, borderRadius: 3,
    backgroundColor: colors.inputBg, overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: 3 },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  meterLeft: { fontSize: 12, fontWeight: '600' },
  meterHint: { fontSize: 11, color: colors.textMuted },
  noQuota: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },

  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.mutedSoft,
  },
  badgeText: { fontSize: 10 },

  quietRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  quietName: { fontSize: 12, color: colors.textSecondary, fontFamily: font.mono },
  quietWhy: { flex: 1, fontSize: 11, color: colors.textMuted, textAlign: 'right' },
});
