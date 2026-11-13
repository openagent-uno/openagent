/**
 * Frontmatter of a vault note shown as a compact properties panel above the
 * rendered body: one row per key, list values as chips, wiki links shown by
 * their target/alias. Unparseable YAML falls back to the raw block.
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, radius } from '../../theme';
import { wikiLinkText, type FrontmatterEntry } from './frontmatter';

export default function NoteProperties({ entries, raw }: {
  entries: FrontmatterEntry[] | null;
  raw: string | null;
}) {
  if (raw) {
    return (
      <View style={styles.panel} testID="oa-note-properties">
        <Text style={styles.raw}>{raw}</Text>
      </View>
    );
  }
  if (!entries || entries.length === 0) return null;
  return (
    <View style={styles.panel} testID="oa-note-properties">
      {entries.map(({ key, value }) => (
        <View key={key} style={styles.row}>
          <Text style={styles.key} numberOfLines={1}>{key}</Text>
          {Array.isArray(value) ? (
            <View style={styles.chips}>
              {value.length === 0 ? <Text style={styles.empty}>—</Text> : null}
              {value.map((v, i) => (
                <Text key={`${i}-${v}`} style={styles.chip}>{wikiLinkText(v)}</Text>
              ))}
            </View>
          ) : (
            <Text style={styles.value} selectable>{value === '' ? '—' : wikiLinkText(value)}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 18,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  key: {
    width: 84,
    flexShrink: 0,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 20,
    fontFamily: font.mono,
  },
  value: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 20, fontFamily: font.sans },
  chips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 1 },
  chip: {
    color: colors.accent,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: 'hidden',
  },
  empty: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  raw: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, fontFamily: font.mono },
});
