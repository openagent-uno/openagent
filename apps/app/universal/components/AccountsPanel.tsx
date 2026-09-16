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
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, font, radius } from '../theme';
import Card from './Card';
import Button from './Button';
import Notice from './Notice';
import EmptyState from './EmptyState';
import { Skeleton } from './Skeleton';
import { listServingAccounts, isUnsupportedByAgent } from '../services/api';
import type { ProviderAccounts, ServingAccount } from '../../common/types';

/** "6.4 days", "3h 12m", "45s" — whichever unit keeps it readable. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)} days`;
}

function windowLabel(minutes?: number): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = minutes / 60;
  if (h < 48) return `${Math.round(h)}h window`;
  return `${Math.round(h / 24)}-day window`;
}

/** Colour by how much is LEFT, not by how much is used. */
function headroomColor(usedPercent: number): string {
  if (usedPercent >= 90) return colors.error;
  if (usedPercent >= 70) return colors.warning;
  return colors.accent;
}

export function AccountRow({ account }: { account: ServingAccount }) {
  const q = account.quota;
  const used = q?.primary_used_percent;
  const hasQuota = typeof used === 'number';
  const left = hasQuota ? Math.max(0, 100 - used) : null;
  const limited = !!account.limited;
  const dead = !!account.dead;

  return (
    <View style={styles.account}>
      <View style={styles.accountHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.accountName}>{account.name || account.id}</Text>
          <Text style={styles.accountMeta}>
            {[
              account.plan,
              account.priority !== undefined ? `priority ${account.priority}` : null,
              account.request_count !== undefined ? `${account.request_count} requests` : null,
            ].filter(Boolean).join(' · ') || '—'}
          </Text>
        </View>
        {dead ? (
          <Badge tone="error" icon="x-octagon" label="Auth failed" />
        ) : limited ? (
          <Badge
            tone="warning"
            icon="clock"
            label={
              account.cooldown_remaining_s
                ? `Limited · ${formatDuration(account.cooldown_remaining_s)}`
                : account.limited_until_ms
                  ? `Limited · ${formatDuration((account.limited_until_ms - Date.now()) / 1000)}`
                  : 'Limited'
            }
          />
        ) : (
          <Badge tone="success" icon="check" label="Available" />
        )}
      </View>

      {hasQuota ? (
        <>
          <View style={styles.meterTrack}>
            <View
              style={[
                styles.meterFill,
                { width: `${Math.min(100, used)}%`, backgroundColor: headroomColor(used) },
              ]}
            />
          </View>
          <View style={styles.meterLabels}>
            <Text style={[styles.meterLeft, { color: headroomColor(used) }]}>
              {left}% left
            </Text>
            <Text style={styles.meterHint}>
              {[
                windowLabel(q?.primary_window_minutes),
                q?.primary_reset_after_s
                  ? `resets in ${formatDuration(q.primary_reset_after_s)}`
                  : null,
              ].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </>
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
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
