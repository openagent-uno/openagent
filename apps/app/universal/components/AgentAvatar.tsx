import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors, font } from '../theme';

export function AgentAvatar({ name, thumbnail, size = 40, selected = false }: {
  name: string;
  thumbnail?: string | null;
  size?: number;
  selected?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [thumbnail]);
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
  const validThumbnail = thumbnail?.startsWith('data:image/jpeg;base64,') && thumbnail.length <= 512 * 1024;
  const frame = { width: size, height: size, borderRadius: selected ? 12 : size / 2 };
  return (
    <View style={[styles.frame, frame, selected && styles.selected]}>
      {thumbnail && validThumbnail && !failed ? (
        <Image source={{ uri: thumbnail }} onError={() => setFailed(true)} style={frame} />
      ) : <Text style={styles.initial}>{initial}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
    backgroundColor: colors.surface, borderColor: colors.borderStrong, borderWidth: 1,
  },
  selected: { backgroundColor: colors.inputBg, borderColor: colors.accent },
  initial: { color: colors.accent, fontFamily: font.display, fontSize: 18, fontWeight: '700' },
});
