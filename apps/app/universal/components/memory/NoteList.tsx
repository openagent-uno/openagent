/**
 * Memory note list — the native stand-in for the canvas graph.
 *
 * ``GraphView`` draws with Canvas 2D, which only exists on the web, so on
 * iOS/Android the Memory root lists the vault notes instead (most recently
 * modified first). Tapping a row opens the same editor route a graph node
 * opens.
 */
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { VaultNote } from '../../../common/types';
import { colors, font, radius } from '../../theme';
import { sortNotesByModified } from './noteSort';

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

export default function NoteList({ notes, loading, topInset, onSelect }: {
  notes: VaultNote[];
  loading: boolean;
  topInset: number;
  onSelect: (path: string) => void;
}) {
  const { bottom } = useSafeAreaInsets();
  const sorted = useMemo(() => sortNotesByModified(notes), [notes]);

  return (
    <FlatList
      data={sorted}
      keyExtractor={(n) => n.path}
      contentContainerStyle={{ paddingTop: topInset + 8, paddingBottom: bottom + 16, paddingHorizontal: 16 }}
      ListEmptyComponent={
        <Text style={styles.empty}>{loading ? 'Loading notes…' : 'No notes yet'}</Text>
      }
      renderItem={({ item }) => {
        const folder = folderOf(item.path);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.title || item.path}
            onPress={() => onSelect(item.path)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Text style={styles.title} numberOfLines={1}>{item.title || item.path}</Text>
            {folder ? <Text style={styles.path} numberOfLines={1}>{folder}</Text> : null}
            {Array.isArray(item.tags) && item.tags.length > 0 ? (
              <View style={styles.tags}>
                {item.tags.slice(0, 4).map((t) => (
                  <Text key={t} style={styles.tag} numberOfLines={1}>#{t}</Text>
                ))}
              </View>
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
    marginBottom: 8,
    gap: 3,
  },
  rowPressed: { opacity: 0.7 },
  title: { color: colors.text, fontSize: 14, fontWeight: '600', fontFamily: font.sans },
  path: { color: colors.textMuted, fontSize: 11, fontFamily: font.mono },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { color: colors.accent, fontSize: 11 },
  empty: { color: colors.textMuted, fontSize: 12, textAlign: 'center', padding: 24 },
});
