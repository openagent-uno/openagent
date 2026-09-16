/**
 * BrandLogo — the OpenAgent origami-bird mark.
 *
 * Replaces the animated JARVIS orb as the app's logo: a calm, static
 * brand glyph. Pass `wordmark` to set the "OPENAGENT" lockup beside it.
 */

import { Image, View, Text, StyleSheet } from 'react-native';
import { colors, font, spacing } from '../theme';

const BIRD = require('../assets/openagent-icon.png');

export default function BrandLogo({
  size = 26,
  wordmark = false,
}: {
  size?: number;
  wordmark?: boolean;
}) {
  const bird = (
    <Image
      source={BIRD}
      style={{ width: size, height: size, resizeMode: 'contain' }}
      accessibilityLabel="OpenAgent"
    />
  );
  if (!wordmark) return bird;
  return (
    <View style={styles.row}>
      {bird}
      <Text style={[styles.word, { fontSize: size * 0.52 }]}>OPENAGENT</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  word: {
    fontFamily: font.display,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.2,
  },
});
