import { useEffect, useLayoutEffect } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import UIViewSurface from '../../../components/ui/UIViewSurface';
import { useHeaderInset } from '../../../components/screenHeader';
import { useUIViews } from '../../../stores/uiViews';

export default function ViewDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[]; revision?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const revisionRaw = Array.isArray(params.revision) ? params.revision[0] : params.revision;
  const revision = revisionRaw && Number.isSafeInteger(Number(revisionRaw)) && Number(revisionRaw) > 0
    ? Number(revisionRaw) : undefined;
  const cacheKey = id && revision ? `${id}@${revision}` : id;
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const title = useUIViews((state) => cacheKey
    ? state.views[cacheKey]?.title ?? state.items.find((item) => item.id === id)?.title
    : undefined);

  useEffect(() => { if (id) void useUIViews.getState().loadView(id, revision ? { revision } : undefined); }, [id, revision]);
  useLayoutEffect(() => { navigation.setOptions({ title: title || 'View' }); }, [navigation, title]);
  if (!id) return <View />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: headerInset + 20 }]}>
      <UIViewSurface viewId={id} revision={revision} mode="page" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { width: '100%', maxWidth: 1100, alignSelf: 'center', paddingHorizontal: 24, paddingBottom: 48 },
});
