import React, { useEffect } from 'react';
import { StyleSheet, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { colors } from '../../theme';

interface Props {
  /** Sweep duration in ms. Default 6000. */
  duration?: number;
  /** Pause between sweeps in ms. Default 4000. */
  delay?: number;
  /** Vertical (top→bottom) instead of horizontal. */
  vertical?: boolean;
  /** Line thickness. Default 2. */
  thickness?: number;
}

/**
 * Decorative cyan scan line that sweeps across (or down) a container.
 * Wrap any element in a relative-positioned container and place this
 * inside; it'll absolutely fill the parent and sweep periodically.
 */
export default function ScanLine({
  duration = 6000,
  delay = 4000,
  vertical = false,
  thickness = 2,
}: Props) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withRepeat(
      withSequence(
        withTiming(1, { duration, easing: Easing.linear }),
        withTiming(1, { duration: delay, easing: Easing.linear }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
  }, [duration, delay]);

  const animatedStyle = useAnimatedStyle(() => {
    if (vertical) {
      const visible = t.value <= 1 - delay / (duration + delay) ? 1 : 0;
      return {
        transform: [{ translateY: `${(t.value % 1) * 100}%` as any }] as any,
        opacity: visible,
      };
    }
    const visible = t.value <= 1 - delay / (duration + delay) ? 1 : 0;
    return {
      transform: [{ translateX: `${(t.value % 1) * 100}%` as any }] as any,
      opacity: visible,
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.line,
        vertical
          ? { left: 0, right: 0, height: thickness, top: 0 }
          : { top: 0, bottom: 0, width: thickness, left: 0 },
        Platform.OS === 'web' && webGlow(),
        animatedStyle,
      ]}
    />
  );
}

function webGlow(): any {
  return { boxShadow: `0 0 8px ${colors.scanLine}` };
}

const styles = StyleSheet.create({
  line: {
    position: 'absolute',
    backgroundColor: colors.scanLine,
  },
});
