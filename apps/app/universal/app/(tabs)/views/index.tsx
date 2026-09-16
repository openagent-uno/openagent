import { useCallback, useMemo, useState } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { UIViewSummary } from '../../../../common/ui-views';
import EmptyState from '../../../components/EmptyState';
import Input from '../../../components/Input';
import { useHeaderInset } from '../../../components/screenHeader';
import { useUIViews } from '../../../stores/uiViews';
import { colors, font, radius } from '../../../theme';

export default function ViewsIndexScreen() {
  const router = useRouter();
  const headerInset = useHeaderInset();
  const [query, setQuery] = useState('');
  const items = useUIViews((state) => state.items);
  const support = useUIViews((state) => state.support);
  const loading = useUIViews((state) => state.loadingList);
  const error = useUIViews((state) => state.listError);

  useFocusEffect(useCallback(() => { void useUIViews.getState().loadList(); }, []));

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return items;
    return items.filter((item) => `${item.title}\n${item.description ?? ''}`.toLocaleLowerCase().includes(term));
  }, [items, query]);

  if (support === 'unavailable') {
    return <EmptyState icon="layout" title="Views need a newer agent" message="Update this OpenAgent server to create and display custom dashboards." />;
  }

  return (
    <View style={[styles.root, { paddingTop: headerInset }]}>
      <View style={styles.toolbar}>
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Search views…"
          accessibilityLabel="Search views"
          containerStyle={styles.search}
          rightAdornment={query ? (
            <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear view search"><Feather name="x" size={14} color={colors.textMuted} /></Pressable>
          ) : undefined}
        />
        {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      </View>
      {error ? <View style={styles.error}><Feather name="alert-circle" size={13} color={colors.error} /><Text style={styles.errorText}>{error}</Text></View> : null}
      {!loading && items.length === 0 ? (
        <EmptyState icon="layout" title="No custom views yet" message="Ask OpenAgent to create a dashboard or an interactive view. Persistent views will appear here and in the sidebar." />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <ViewRow item={item} onPress={() => router.push(`/views/${encodeURIComponent(item.id)}` as any)} />}
          ListEmptyComponent={<Text style={styles.emptySearch}>No views match “{query.trim()}”.</Text>}
        />
      )}
    </View>
  );
}

function ViewRow({ item, onPress }: { item: UIViewSummary; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.title}`}
      {...(Platform.OS === 'web' ? { className: 'oa-card-hover oa-fade-in' } as any : {})}
    >
      <View style={styles.icon}><Feather name={safeIcon(item.icon)} size={16} color={colors.accent} /></View>
      <View style={styles.rowBody}>
        <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
        {item.description ? <Text style={styles.description} numberOfLines={2}>{item.description}</Text> : null}
      </View>
      <View style={[styles.status, item.status !== 'active' && styles.statusStale]}><Text style={styles.statusText}>{item.status}</Text></View>
      <Feather name="chevron-right" size={15} color={colors.textMuted} />
    </Pressable>
  );
}

function safeIcon(value?: string): keyof typeof Feather.glyphMap {
  return value && Object.prototype.hasOwnProperty.call(Feather.glyphMap, value) ? value as keyof typeof Feather.glyphMap : 'layout';
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: { width: '100%', maxWidth: 920, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 18, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  search: { flex: 1 },
  error: { width: '100%', maxWidth: 872, alignSelf: 'center', flexDirection: 'row', gap: 8, padding: 10, borderRadius: radius.md, backgroundColor: colors.errorSoft, borderWidth: 1, borderColor: colors.errorBorder },
  errorText: { flex: 1, fontFamily: font.sans, fontSize: 11, color: colors.error },
  list: { width: '100%', maxWidth: 920, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10, gap: 9 },
  row: { width: '100%', minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.primaryLight },
  rowBody: { flex: 1, minWidth: 0 },
  title: { fontFamily: font.sans, fontSize: 13, fontWeight: '600', color: colors.text },
  description: { fontFamily: font.sans, fontSize: 11, lineHeight: 16, color: colors.textMuted, marginTop: 3 },
  status: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.successSoft },
  statusStale: { backgroundColor: colors.mutedSoft },
  statusText: { fontFamily: font.sans, fontSize: 9, textTransform: 'uppercase', color: colors.textSecondary },
  emptySearch: { textAlign: 'center', marginTop: 40, fontFamily: font.sans, fontSize: 12, color: colors.textMuted },
});
