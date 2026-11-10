import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ManagementSummary } from '../services/api';
import { colors, radius } from '../theme';
import EmptyState from './EmptyState';
import { useHeaderInset } from './screenHeader';
import { TileGridScreen } from './TileGrid';

export function ManagementSummaryTile({ item }: { item: ManagementSummary }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.name}>{item.name}</Text>
      <Text style={styles.hint}>{item.enabled ? 'Enabled' : 'Disabled'}</Text>
    </View>
  );
}

export default function ManagementOverview({ items, title, icon }: {
  items: ManagementSummary[];
  title: string;
  icon: ComponentProps<typeof Feather>['name'];
}) {
  const headerInset = useHeaderInset();
  const message = 'Only the agent owner can make changes.';
  if (!items.length) return <EmptyState title={title} icon={icon} message={message} />;
  return (
    <TileGridScreen headerInset={headerInset} header={<Text style={styles.hint}>{message}</Text>}>
      {items.map(item => <ManagementSummaryTile key={item.id} item={item} />)}
    </TileGridScreen>
  );
}

const styles = StyleSheet.create({
  tile: { padding: 16, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface },
  name: { fontSize: 15, fontWeight: '600', color: colors.text },
  hint: { fontSize: 13, color: colors.textSecondary },
});
