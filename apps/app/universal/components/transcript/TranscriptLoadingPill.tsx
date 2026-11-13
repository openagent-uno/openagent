/**
 * A quiet, out-of-flow indicator shown while the transcript fetches a page of
 * history. It floats over the scroll view instead of taking a row, so its
 * appearance never shifts what the reader is looking at.
 */
import { memo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius } from '../../theme';
import { useTranscriptObserved, type TranscriptController } from './TranscriptController';

function TranscriptLoadingPill({ controller }: { controller: TranscriptController }) {
  const loading = useTranscriptObserved(controller, 'loading');
  if (!loading) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.pill, loading === 'after' ? styles.bottom : styles.top]}
      accessibilityLiveRegion="polite"
      testID="oa-transcript-loading"
    >
      <ActivityIndicator size="small" color={colors.textMuted} />
      <Text style={styles.label}>
        {loading === 'before' ? 'Loading earlier messages' : loading === 'after' ? 'Loading later messages' : 'Loading message'}
      </Text>
    </View>
  );
}

export default memo(TranscriptLoadingPill);

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.panelBgSolid,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    zIndex: 6,
  },
  top: { top: 10 },
  bottom: { bottom: 10 },
  label: { color: colors.textMuted, fontSize: 11, fontFamily: font.sans },
});
