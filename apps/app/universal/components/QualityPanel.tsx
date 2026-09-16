/**
 * QualityPanel — the correctness meter beside the spend meter.
 *
 * `/api/budgets/usage` answers "how much did we spend". This answers "were
 * the answers any good", from the same event log: the LLM-judge verdicts
 * (`quality.score`), the turns and spend behind them (`router.cost_recorded`)
 * and how often semantic recall actually found something (`recall.metric`).
 *
 * Two things it refuses to fake. When the monitor is off the server still
 * returns a zeroed report, so the panel says "not running" instead of
 * drawing a 0% score that looks like catastrophic quality. And a window
 * with no judged turns shows "—", not 0 — no data is not a bad result.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { colors, font, radius } from '../theme';
import Card from './Card';
import Button from './Button';
import { Skeleton } from './Skeleton';
import Notice from './Notice';
import { getQualityReport, isUnsupportedByAgent } from '../services/api';
import type { QualityReport } from '../../common/types';

const WINDOWS: { label: string; seconds: number }[] = [
  { label: '1h', seconds: 3_600 },
  { label: '24h', seconds: 86_400 },
  { label: '7d', seconds: 604_800 },
  { label: '30d', seconds: 2_592_000 },
];

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function num(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);
}

/** Verdict counts as a single proportional bar — the shape of the mix is
 *  the point, not the individual numbers. */
function VerdictBar({ good, warn, bad }: { good: number; warn: number; bad: number }) {
  const total = good + warn + bad;
  if (total === 0) return <View style={styles.barTrack} />;
  return (
    <View style={styles.barTrack}>
      <View style={{ flex: good, backgroundColor: colors.success }} />
      <View style={{ flex: warn, backgroundColor: colors.warning }} />
      <View style={{ flex: bad, backgroundColor: colors.error }} />
    </View>
  );
}

function Stat({ label, value, tint, hint }: {
  label: string; value: string; tint?: string; hint?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tint ? { color: tint } : null]}>{value}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

export default function QualityPanel() {
  const [report, setReport] = useState<QualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState(86_400);

  const load = useCallback(async () => {
    try {
      setReport(await getQualityReport(window));
      setError(null);
    } catch (e) {
      setError(isUnsupportedByAgent(e)
        ? 'This agent runs an older OpenAgent that does not expose the quality report yet. Update the agent and it will appear here.'
        : e instanceof Error ? e.message : String(e));
    }
  }, [window]);

  useEffect(() => { void load(); }, [load]);

  const q = report?.quality;
  const u = report?.usage;
  const r = report?.recall;
  const monitorOff = report ? report.enabled === false : false;
  // Cost per turn is the number that makes spend comparable across
  // windows; the raw total already lives on the Costs screen.
  const costPerTurn = u && u.turns > 0 ? u.cost_usd / u.turns : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Quality</Text>
          <Text style={styles.subtitle}>
            Judge verdicts, spend and recall over the same window — read from
            the event log, nothing stored separately.
          </Text>
        </View>
        <Button label="Refresh" icon="refresh-cw" size="xs" variant="ghost" onPress={() => { void load(); }} />
      </View>

      <View style={styles.chipRow}>
        {WINDOWS.map((w) => (
          <Pressable
            key={w.label}
            onPress={() => setWindow(w.seconds)}
            style={[styles.chip, window === w.seconds && styles.chipActive]}
          >
            <Text style={[styles.chipText, window === w.seconds && styles.chipTextActive]}>
              {w.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {error && <Notice>{error}</Notice>}

      {monitorOff && (
        <Notice tone="warning">
          The quality monitor is not running, so no turn is being judged.
          The numbers below reflect only what was recorded while it was on.
        </Notice>
      )}

      {!report ? (
        <Card><Skeleton height={110} /></Card>
      ) : (
        <>
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Answers</Text>
            <View style={styles.statRow}>
              <Stat
                label="Avg score"
                value={q?.avg_score === null || q?.avg_score === undefined ? '—' : q.avg_score.toFixed(2)}
                tint={q?.avg_score != null ? (q.avg_score >= 0.8 ? colors.success : q.avg_score >= 0.5 ? colors.warning : colors.error) : undefined}
                hint={q?.judged ? `${q.judged} judged` : 'nothing judged'}
              />
              <Stat
                label="Fabrication"
                value={q ? String(q.fabrication_flagged) : '—'}
                tint={q && q.fabrication_flagged > 0 ? colors.error : undefined}
                hint="turns flagged"
              />
            </View>
            {q && (
              <>
                <VerdictBar good={q.verdicts.good} warn={q.verdicts.warn} bad={q.verdicts.bad} />
                <View style={styles.legendRow}>
                  <Legend color={colors.success} label={`good ${q.verdicts.good}`} />
                  <Legend color={colors.warning} label={`warn ${q.verdicts.warn}`} />
                  <Legend color={colors.error} label={`bad ${q.verdicts.bad}`} />
                </View>
              </>
            )}
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Cost of those answers</Text>
            <View style={styles.statRow}>
              <Stat label="Turns" value={u ? num(u.turns) : '—'} />
              <Stat label="Spend" value={u ? `$${u.cost_usd.toFixed(2)}` : '—'} />
              <Stat
                label="Per turn"
                value={costPerTurn === null ? '—' : `$${costPerTurn.toFixed(4)}`}
              />
            </View>
            <View style={styles.statRow}>
              <Stat label="Input" value={u ? `${num(u.input_tokens)} tok` : '—'} />
              <Stat label="Output" value={u ? `${num(u.output_tokens)} tok` : '—'} />
            </View>
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Memory recall</Text>
            <View style={styles.statRow}>
              <Stat
                label="Hit rate"
                value={pct(r?.hit_rate ?? null)}
                hint={r?.turns ? `${r.turns} turns` : 'no recall turns'}
              />
              <Stat label="Used" value={pct(r?.used_rate ?? null)} hint="recall reached the prompt" />
              <Stat
                label="Top score"
                value={r?.avg_top_score === null || r?.avg_top_score === undefined ? '—' : r.avg_top_score.toFixed(2)}
              />
            </View>
            <Text style={styles.footnote}>
              A high hit rate with a low top score means recall is finding
              notes but weak ones — usually a vault problem, not a model one.
            </Text>
          </Card>
        </>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legend}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
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

  chipRow: { flexDirection: 'row', gap: 6 },
  chip: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 11, color: colors.textSecondary },
  chipTextActive: { color: colors.accent, fontWeight: '600' },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorText: { flex: 1, fontSize: 12, color: colors.error },
  noticeBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.mutedSoft,
  },
  noticeText: { flex: 1, fontSize: 11, color: colors.textSecondary, lineHeight: 16 },

  card: { gap: 10 },
  cardTitle: {
    fontSize: 11, color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  stat: { minWidth: 78 },
  statLabel: { fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: {
    fontSize: 19, fontWeight: '600', color: colors.text,
    fontFamily: font.display, marginTop: 2,
  },
  statHint: { fontSize: 10, color: colors.textMuted, marginTop: 1 },

  barTrack: {
    flexDirection: 'row', height: 6, borderRadius: 3,
    backgroundColor: colors.inputBg, overflow: 'hidden',
  },
  legendRow: { flexDirection: 'row', gap: 14 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendText: { fontSize: 11, color: colors.textMuted },

  footnote: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
});
