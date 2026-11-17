import { StyleSheet, Text, View } from 'react-native';
import type { BudgetUsage } from '../../../common/types';
import { colors } from '../../theme';

export default function BudgetMeter({ rule }: { rule: BudgetUsage }) {
  const amount = (v: number) => rule.metric === 'cost_usd' ? `$${v.toFixed(2)}` : `${new Intl.NumberFormat('en', { notation: 'compact' }).format(v)} tokens`;
  const known = rule.spend != null && !rule.error;
  return <View style={styles.wrap}>
    <View style={styles.row}>
      <Text style={styles.label}>{rule.metric === 'cost_usd' ? 'Estimated spend' : 'OpenAgent usage'} · {rule.window}</Text>
      <Text style={styles.value}>{known ? `${amount(rule.spend!)} / ${amount(rule.amount)}` : 'Usage unavailable'}</Text>
    </View>
    {known && <View style={styles.track}><View style={[styles.fill, { width: `${Math.min(100, Math.max(0, (rule.ratio ?? 0) * 100))}%`, backgroundColor: rule.over ? colors.warning : colors.primary }]} /></View>}
    {rule.over && <Text style={styles.warning}>Budget reached{rule.enforced ? '' : ' · alert only'}</Text>}
    {rule.cost_metric_ineffective && <Text style={styles.warning}>Cost unavailable: use a token budget.</Text>}
  </View>;
}
const styles = StyleSheet.create({
  wrap: { gap: 8 }, row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6 },
  label: { color: colors.textSecondary, fontSize: 13 }, value: { color: colors.text, fontSize: 13, fontWeight: '600' },
  track: { height: 6, backgroundColor: colors.border, borderRadius: 4, overflow: 'hidden' }, fill: { height: 6, borderRadius: 4 },
  warning: { color: colors.warning, fontSize: 12 },
});
