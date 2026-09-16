/**
 * BudgetsPanel — spend caps and their live meters.
 *
 * The server can already cap spend per scope and window; until now nothing
 * in the app could see or set one. This panel is that surface: every rule
 * from `/api/budgets/usage` with its current spend against the limit, plus
 * create / edit / enable / delete.
 *
 * It is deliberately blunt about what a rule actually DOES. Only
 * global/provider/model scopes over an hour/day/month window can exclude a
 * model from routing; a `task` scope or a `per_run` window alerts and
 * nothing more. The server reports that per rule as `enforced`, and a cap
 * the user believes is hard when it is advisory is worse than no cap at
 * all — so an alert-only rule says so on its face.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, font, radius } from '../theme';
import Card from './Card';
import Button from './Button';
import Input from './Input';
import ThemedSwitch from './ThemedSwitch';
import EmptyState from './EmptyState';
import Notice from './Notice';
import { Skeleton } from './Skeleton';
import { useConfirm } from './ConfirmDialog';
import {
  listBudgetUsage, createBudget, updateBudget, deleteBudget, isUnsupportedByAgent,
} from '../services/api';
import type {
  BudgetUsage, BudgetScopeKind, BudgetWindow, BudgetMetric, CreateBudgetInput,
} from '../../common/types';

const SCOPE_KINDS: { id: BudgetScopeKind; label: string; hint: string }[] = [
  { id: 'global', label: 'Everything', hint: 'Every model, every provider' },
  { id: 'provider', label: 'Provider', hint: 'e.g. openai, anthropic' },
  { id: 'model', label: 'Model', hint: 'A runtime id' },
  { id: 'task', label: 'Task', hint: 'A scheduled task — alert only' },
];

const WINDOWS: { id: BudgetWindow; label: string }[] = [
  { id: 'hour', label: 'Per hour' },
  { id: 'day', label: 'Per day' },
  { id: 'month', label: 'Per month' },
  { id: 'per_run', label: 'Per run' },
];

const METRICS: { id: BudgetMetric; label: string }[] = [
  { id: 'cost_usd', label: 'Cost (USD)' },
  { id: 'tokens', label: 'Tokens' },
];

/** Mirrors the server's rule: only these shapes can stop a turn. */
function isEnforceableShape(kind: BudgetScopeKind, window: BudgetWindow): boolean {
  return (
    (kind === 'global' || kind === 'provider' || kind === 'model') &&
    (window === 'hour' || window === 'day' || window === 'month')
  );
}

function formatAmount(value: number | null | undefined, metric: BudgetMetric): string {
  if (value === null || value === undefined) return '—';
  if (metric === 'tokens') {
    return value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(2)}M`
      : value >= 1_000
        ? `${(value / 1_000).toFixed(1)}k`
        : String(Math.round(value));
  }
  return `$${value.toFixed(2)}`;
}

function scopeLabel(rule: BudgetUsage): string {
  if (rule.scope_kind === 'global') return 'Everything';
  return `${rule.scope_kind}: ${rule.scope_value || rule.scope}`;
}

/** Colour follows how close the meter is to the cap, not the rule's shape. */
function meterColor(ratio: number | null, over: boolean): string {
  if (over) return colors.error;
  if (ratio !== null && ratio >= 0.9) return colors.warning;
  return colors.accent;
}

interface DraftState {
  id: string | null;
  scope_kind: BudgetScopeKind;
  scope_value: string;
  metric: BudgetMetric;
  window: BudgetWindow;
  amount: string;
  webhook_url: string;
}

const BLANK_DRAFT: DraftState = {
  id: null,
  scope_kind: 'global',
  scope_value: '',
  metric: 'cost_usd',
  window: 'day',
  amount: '',
  webhook_url: '',
};

export default function BudgetsPanel() {
  const confirm = useConfirm();
  const [rules, setRules] = useState<BudgetUsage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRules(await listBudgetUsage());
      setError(null);
      setFailed(false);
    } catch (e) {
      // An empty array would draw "No spend caps" — i.e. "nothing limits
      // this agent" — on top of a failure to READ the caps. On this
      // screen that false reassurance is the worst possible answer.
      setError(isUnsupportedByAgent(e)
        ? 'This agent runs an older OpenAgent that does not expose budgets yet. Update the agent and it will appear here.'
        : e instanceof Error ? e.message : String(e));
      setRules(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // The meter moves as turns are billed, so a panel left open would go
  // stale and quietly misreport headroom. 30s matches the guard's own
  // refresh TTL — polling faster would just re-run the same aggregation.
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const save = useCallback(async () => {
    if (!draft) return;
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Amount must be a number greater than zero.');
      return;
    }
    const body: CreateBudgetInput = {
      scope_kind: draft.scope_kind,
      scope_value: draft.scope_kind === 'global' ? '' : draft.scope_value.trim(),
      metric: draft.metric,
      window: draft.window,
      amount,
      webhook_url: draft.webhook_url.trim() || null,
    };
    setSaving(true);
    try {
      if (draft.id) await updateBudget(draft.id, body);
      else await createBudget(body);
      setDraft(null);
      setError(null);
      await refresh();
    } catch (e) {
      // The server's message is the useful one here: it names the
      // duplicate scope (409) or the out-of-vocabulary field (400).
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, refresh]);

  const toggle = useCallback(async (rule: BudgetUsage) => {
    try {
      await updateBudget(rule.id, { enabled: !rule.enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const remove = useCallback(async (rule: BudgetUsage) => {
    const ok = await confirm({
      title: 'Delete budget',
      message: `Remove the ${formatAmount(rule.amount, rule.metric)} ${rule.window} cap on ${scopeLabel(rule)}? Spend stops being capped immediately.`,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await deleteBudget(rule.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [confirm, refresh]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Budgets</Text>
          <Text style={styles.subtitle}>
            Spend caps the agent enforces while it routes. Read live against
            the same usage log the cost breakdown uses.
          </Text>
        </View>
        {!draft && (
          <Button
            label="New cap"
            icon="plus"
            size="sm"
            onPress={() => setDraft({ ...BLANK_DRAFT })}
          />
        )}
      </View>

      {error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}

      {draft && (
        <Card style={styles.formCard}>
          <Text style={styles.formTitle}>{draft.id ? 'Edit cap' : 'New cap'}</Text>

          <Text style={styles.label}>Applies to</Text>
          <View style={styles.chipRow}>
            {SCOPE_KINDS.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => setDraft({ ...draft, scope_kind: s.id })}
                style={[styles.chip, draft.scope_kind === s.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, draft.scope_kind === s.id && styles.chipTextActive]}>
                  {s.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            {SCOPE_KINDS.find((s) => s.id === draft.scope_kind)?.hint}
          </Text>

          {draft.scope_kind !== 'global' && (
            <Input
              label="Scope"
              placeholder={draft.scope_kind === 'model' ? 'anthropic:claude-opus-4-8' : 'openai'}
              value={draft.scope_value}
              onChangeText={(v: string) => setDraft({ ...draft, scope_value: v })}
              mono
            />
          )}

          <Text style={styles.label}>Window</Text>
          <View style={styles.chipRow}>
            {WINDOWS.map((w) => (
              <Pressable
                key={w.id}
                onPress={() => setDraft({ ...draft, window: w.id })}
                style={[styles.chip, draft.window === w.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, draft.window === w.id && styles.chipTextActive]}>
                  {w.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Measured in</Text>
          <View style={styles.chipRow}>
            {METRICS.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => setDraft({ ...draft, metric: m.id })}
                style={[styles.chip, draft.metric === m.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, draft.metric === m.id && styles.chipTextActive]}>
                  {m.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Input
            label={draft.metric === 'tokens' ? 'Limit (tokens)' : 'Limit (USD)'}
            placeholder={draft.metric === 'tokens' ? '1000000' : '10.00'}
            value={draft.amount}
            onChangeText={(v: string) => setDraft({ ...draft, amount: v })}
            keyboardType="numeric"
          />

          <Input
            label="Alert webhook (optional)"
            hint="POSTed when the rule crosses an alert threshold."
            placeholder="https://…"
            value={draft.webhook_url}
            onChangeText={(v: string) => setDraft({ ...draft, webhook_url: v })}
            mono
          />

          {!isEnforceableShape(draft.scope_kind, draft.window) && (
            <Notice tone="warning">
              This shape alerts but cannot stop a turn. Only Everything /
              Provider / Model caps over an hour, day or month window can
              take a model out of routing.
            </Notice>
          )}

          <View style={styles.formActions}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={() => setDraft(null)} />
            <Button
              label={saving ? 'Saving…' : draft.id ? 'Save' : 'Create'}
              size="sm"
              disabled={saving}
              onPress={() => { void save(); }}
            />
          </View>
        </Card>
      )}

      {failed ? null : rules === null ? (
        <Card><Skeleton height={64} /></Card>
      ) : rules.length === 0 ? (
        <EmptyState
          icon="shield"
          title="No spend caps"
          message="Nothing limits what the agent can spend. Add a cap to put a ceiling on a provider, a model, or everything at once."
        />
      ) : (
        rules.map((rule) => {
          const pct = rule.ratio === null ? null : Math.min(1, Math.max(0, rule.ratio));
          const tint = meterColor(rule.ratio, rule.over);
          return (
            <Card key={rule.id} style={styles.ruleCard}>
              <View style={styles.ruleHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ruleScope}>{scopeLabel(rule)}</Text>
                  <Text style={styles.ruleMeta}>
                    {formatAmount(rule.amount, rule.metric)}
                    {' · '}
                    {WINDOWS.find((w) => w.id === rule.window)?.label.toLowerCase() ?? rule.window}
                    {rule.source && rule.source !== 'user' ? ` · from ${rule.source}` : ''}
                  </Text>
                </View>
                <ThemedSwitch value={!!rule.enabled} onValueChange={() => { void toggle(rule); }} />
              </View>

              <View style={styles.meterTrack}>
                <View
                  style={[
                    styles.meterFill,
                    { width: `${(pct ?? 0) * 100}%`, backgroundColor: tint },
                  ]}
                />
              </View>
              <View style={styles.meterLabels}>
                <Text style={[styles.meterSpend, { color: tint }]}>
                  {rule.spend === null
                    ? 'No window to measure'
                    : `${formatAmount(rule.spend, rule.metric)} of ${formatAmount(rule.amount, rule.metric)}`}
                </Text>
                {rule.remaining !== null && (
                  <Text style={styles.meterRemaining}>
                    {formatAmount(rule.remaining, rule.metric)} left
                  </Text>
                )}
              </View>

              <View style={styles.badgeRow}>
                {!rule.enforced && (
                  <View style={styles.badge}>
                    <Feather name="bell" size={10} color={colors.textMuted} />
                    <Text style={styles.badgeText}>Alert only</Text>
                  </View>
                )}
                {rule.over && (
                  <View style={[styles.badge, styles.badgeDanger]}>
                    <Feather name="alert-octagon" size={10} color={colors.error} />
                    <Text style={[styles.badgeText, { color: colors.error }]}>Over cap</Text>
                  </View>
                )}
                {rule.webhook_url && (
                  <View style={styles.badge}>
                    <Feather name="send" size={10} color={colors.textMuted} />
                    <Text style={styles.badgeText}>Webhook</Text>
                  </View>
                )}
              </View>

              {(rule.warning || rule.error) && (
                <Notice tone="warning">{rule.warning ?? rule.error}</Notice>
              )}

              <View style={styles.ruleActions}>
                <Button
                  label="Edit"
                  variant="ghost"
                  size="xs"
                  onPress={() => setDraft({
                    id: rule.id,
                    scope_kind: rule.scope_kind,
                    scope_value: rule.scope_value,
                    metric: rule.metric,
                    window: rule.window,
                    amount: String(rule.amount),
                    webhook_url: rule.webhook_url ?? '',
                  })}
                />
                <Button
                  label="Delete"
                  variant="danger"
                  size="xs"
                  onPress={() => { void remove(rule); }}
                />
              </View>
            </Card>
          );
        })
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

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorText: { flex: 1, fontSize: 12, color: colors.error },

  formCard: { gap: 8 },
  formTitle: {
    fontSize: 13, fontWeight: '600', color: colors.text,
    fontFamily: font.display, marginBottom: 2,
  },
  label: {
    fontSize: 11, color: colors.textSecondary, marginTop: 8, marginBottom: 5,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 11, color: colors.textSecondary },
  chipTextActive: { color: colors.accent, fontWeight: '600' },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },

  ruleCard: { gap: 8 },
  ruleHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ruleScope: { fontSize: 13, fontWeight: '600', color: colors.text },
  ruleMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  meterTrack: {
    height: 6, borderRadius: 3,
    backgroundColor: colors.inputBg,
    overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: 3 },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  meterSpend: { fontSize: 12, fontWeight: '600' },
  meterRemaining: { fontSize: 11, color: colors.textMuted },

  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.mutedSoft,
  },
  badgeDanger: { backgroundColor: colors.errorSoft },
  badgeText: { fontSize: 10, color: colors.textMuted },

  noticeBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.mutedSoft,
  },
  noticeText: { flex: 1, fontSize: 11, color: colors.textSecondary, lineHeight: 16 },

  ruleActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
