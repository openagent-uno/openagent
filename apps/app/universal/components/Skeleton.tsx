/**
 * Skeleton — animated loading placeholders.
 *
 * Used to render a screen *immediately* on navigation and show shimmering
 * bars where content will land, rather than flashing an empty-state
 * message while the first fetch is in flight.
 *
 * Web rides the shared ``oa-skeleton`` shimmer (a moving gradient, see
 * theme.ts). Native has no CSS animations, so it runs a soft opacity
 * pulse via the RN ``Animated`` API instead — same intent, cheaper.
 */

import { useEffect, useRef } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type DimensionValue,
  type ViewStyle,
} from 'react-native';
import { colors, radius } from '../theme';

const isWeb = Platform.OS === 'web';

interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  /** Corner radius. Defaults to ``radius.sm``. */
  rounded?: number;
  style?: ViewStyle | ViewStyle[];
}

/** A single shimmering placeholder bar. */
export function Skeleton({ width = '100%', height = 12, rounded = radius.sm, style }: SkeletonProps) {
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    // Web animates via the CSS gradient shimmer; only drive the native
    // opacity loop off-web.
    if (isWeb) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const base = { width, height, borderRadius: rounded, backgroundColor: colors.surface };

  if (isWeb) {
    return (
      <View
        style={[base, style]}
        // @ts-ignore — web-only shimmer class (theme.ts)
        className="oa-skeleton"
      />
    );
  }
  return <Animated.View style={[base, { opacity: pulse }, style]} />;
}

/** A stack of N placeholder bars, the last one shortened — reads as a
 *  block of text loading in. */
export function SkeletonLines({
  lines = 3,
  height = 11,
  gap = 8,
  lastWidth = '60%',
  style,
}: {
  lines?: number;
  height?: number;
  gap?: number;
  lastWidth?: DimensionValue;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ gap }, style]}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={height}
          width={i === lines - 1 ? lastWidth : '100%'}
        />
      ))}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  rowBody: { flex: 1, gap: 8 },
});

/** A list-row placeholder used by the Workflows / Scheduled screens: an
 *  icon dot, two stacked text bars, and a trailing control stub. */
export function SkeletonRow({ first = false }: { first?: boolean }) {
  return (
    <View style={[cardStyles.row, !first && cardStyles.rowBorder]}>
      <Skeleton width={28} height={28} rounded={radius.md} />
      <View style={cardStyles.rowBody}>
        <Skeleton width="45%" height={13} />
        <Skeleton width="80%" height={10} />
      </View>
      <Skeleton width={34} height={18} rounded={radius.lg} />
    </View>
  );
}
