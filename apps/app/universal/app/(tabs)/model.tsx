import { colors, font } from '../../theme';
/**
 * Model screen, embedded under Settings as two of its sections:
 *   - ``manage`` — every configured model in one grid (ModelGrid), with the
 *                  add wizard, the per-model edit dialog (which also carries
 *                  the provider and its accounts) and the spend budgets.
 *   - ``costs``  — the daily-spend breakdown and the budgets.
 *
 * Vocabulary: a **provider row** is a (vendor, framework) pair in the
 * ``providers`` table; a **model** is a bare vendor id under one provider
 * row; the **runtime_id** ``<provider>:<model>`` is what logs and session
 * pins use.
 */

import { useCallback, useEffect, useState } from 'react';
import BudgetsPanel from '../../components/BudgetsPanel';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useConnection } from '../../stores/connection';
import { setBaseUrl, getDailyUsage } from '../../services/api';
import Card from '../../components/Card';
import TabStrip from '../../components/TabStrip';
import ModelGrid from '../../components/models/ModelGrid';
import { CONTENT_MAX_WIDTH } from '../../components/TileGrid';
import { useHeaderInset } from '../../components/screenHeader';
import type { DailyUsageEntry } from '../../../common/types';

type ModelView = 'manage' | 'costs';

export default function ModelScreen({ view = 'manage', embedded = false }: { view?: ModelView; embedded?: boolean } = {}) {
  const connConfig = useConnection((s) => s.config);
  // Standalone (Model tab) draws behind the transparent header and offsets
  // its own content; when embedded in Settings the parent already insets.
  const headerInset = useHeaderInset();

  const [dailyUsage, setDailyUsage] = useState<DailyUsageEntry[]>([]);
  const [costDays, setCostDays] = useState(7);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!connConfig || view !== 'costs') return;
    try {
      setDailyUsage(await getDailyUsage(costDays));
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [connConfig, costDays, view]);

  useEffect(() => {
    if (connConfig) {
      if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
      reload();
    }
  }, [connConfig, reload]);

  const renderCosts = () => (
    <>
      <Text style={styles.sectionTitle}>Costs</Text>
      <Card>
        <TabStrip
          tabs={[{ id: '7', label: '7d' }, { id: '30', label: '30d' }]}
          active={String(costDays)}
          onChange={(v) => setCostDays(parseInt(v, 10))}
          size="sm"
          style={{ marginBottom: 12 }}
        />
        {dailyUsage.length > 0 ? (
          <>
            <View style={styles.costSummary}>
              <View style={styles.costStat}>
                <Text style={styles.costStatValue}>${dailyUsage.reduce((s, e) => s + e.cost, 0).toFixed(3)}</Text>
                <Text style={styles.costStatLabel}>Total</Text>
              </View>
              <View style={styles.costStat}>
                <Text style={styles.costStatValue}>{dailyUsage.reduce((s, e) => s + e.request_count, 0)}</Text>
                <Text style={styles.costStatLabel}>Requests</Text>
              </View>
              <View style={styles.costStat}>
                <Text style={styles.costStatValue}>
                  {(dailyUsage.reduce((s, e) => s + e.input_tokens + e.output_tokens, 0) / 1000).toFixed(0)}K
                </Text>
                <Text style={styles.costStatLabel}>Tokens</Text>
              </View>
            </View>
            <View style={styles.costTable}>
              <View style={styles.costHeaderRow}>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 1.2 }]}>Date</Text>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 2 }]}>Model</Text>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 0.6 }]}>Req</Text>
                <Text style={[styles.costCell, styles.costHeaderText, { flex: 1 }]}>Cost</Text>
              </View>
              {dailyUsage.slice(0, 20).map((e, i) => (
                <View key={i} style={styles.costRow}>
                  <Text style={[styles.costCell, { flex: 1.2 }]}>{e.date.slice(5)}</Text>
                  <Text style={[styles.costCell, { flex: 2 }]} numberOfLines={1}>{e.model}</Text>
                  <Text style={[styles.costCell, { flex: 0.6 }]}>{e.request_count}</Text>
                  <Text style={[styles.costCell, { flex: 1 }]}>${e.cost.toFixed(4)}</Text>
                </View>
              ))}
            </View>
          </>
        ) : (
          <Text style={styles.emptyText}>No usage data yet.</Text>
        )}
      </Card>
    </>
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        view === 'manage' && styles.contentWide,
        !embedded && { paddingTop: headerInset + 24 },
      ]}
    >
      {error && <Text style={styles.error}>{error}</Text>}
      {view === 'costs' ? (
        <>
          {renderCosts()}
          <View style={{ height: 28 }} />
          <BudgetsPanel />
        </>
      ) : (
        <>
          <ModelGrid />
          <View style={{ height: 28 }} />
          <BudgetsPanel />
        </>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, maxWidth: 640, width: '100%', alignSelf: 'center' },
  contentWide: { maxWidth: CONTENT_MAX_WIDTH },

  sectionTitle: {
    fontSize: 18, fontWeight: '500', color: colors.text, marginBottom: 4,
    fontFamily: font.display, letterSpacing: -0.3,
  },
  error: { color: colors.error, fontSize: 12, marginBottom: 10 },
  emptyText: { padding: 10, fontSize: 12, color: colors.textMuted, textAlign: 'center' },

  costSummary: { flexDirection: 'row', marginBottom: 14 },
  costStat: { flex: 1, alignItems: 'center' },
  costStatValue: { fontSize: 18, fontWeight: '600', color: colors.text, fontFamily: font.mono },
  costStatLabel: { fontSize: 10, color: colors.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 1 },

  costTable: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  costHeaderRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  costRow: { flexDirection: 'row', paddingVertical: 5 },
  costCell: { fontSize: 11, color: colors.text, fontFamily: font.mono },
  costHeaderText: { color: colors.textMuted, fontWeight: '600', fontSize: 10, textTransform: 'uppercase' },
});
