/**
 * Memory — per-note git history. Pushed as ``history/[...path]`` onto
 * the Memory Stack. The path is a catch-all so folder segments
 * (``docs/ideas.md``) arrive intact.
 *
 * Reuses the shared ``HistoryList`` body from ``memory/history`` scoped
 * to a single note via ``getVaultHistory(path)``. The header (back +
 * title) is the react-navigation header from memory/_layout.tsx; the
 * title is set here to the note name.
 */

import { useLayoutEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { HistoryList } from '../history';
import { colors } from '../../../../theme';
export default function NoteHistoryScreen() {
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const notePath = Array.isArray(params.path)
    ? params.path.join('/')
    : typeof params.path === 'string'
      ? params.path
      : '';

  const titleFallback = notePath.split('/').pop()?.replace('.md', '') ?? '';

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Memory file history' });
  }, [navigation, titleFallback]);

  return (
    <View style={styles.screen}>
      <HistoryList path={notePath} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
});
