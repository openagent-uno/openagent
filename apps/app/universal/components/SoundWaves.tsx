/**
 * SoundWaves — animated vertical equalizer bars for the Voice screen.
 *
 * Cross-platform (RN ``Animated`` height tweens, no SVG/Lottie/Skia).
 * Drives 7 bars from a single ``level`` (0..1, smoothed RMS) supplied by
 * the caller via ``VoiceLoop.onEnergy``. Each bar gets a static phase
 * offset so they ripple instead of moving in lockstep.
 *
 * State semantics:
 *   - ``idle``       — all bars settle to a baseline (0.1) regardless of level
 *   - ``listening``  — bars track ``level``, primary color
 *   - ``processing`` — internal sine sweep loop (level ignored), muted color
 *   - ``speaking``   — internal sine sweep loop with brighter accent
 */

import { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import { colors } from '../theme';

export type SoundWavesState = 'idle' | 'listening' | 'processing' | 'speaking';

export interface SoundWavesProps {
  level: number;          // 0..1
  state: SoundWavesState;
  bars?: number;          // default 7
  color?: string;         // default colors.primary
  maxHeight?: number;     // default 96 (px)
}

// Pseudo-random phase offsets so bars don't move in lockstep.
const PHASE_OFFSETS = [0.0, 0.42, 0.91, 0.18, 0.73, 0.33, 0.61, 0.05, 0.49];
const BASELINE = 0.12;
const MIN_HEIGHT = 4;

export default function SoundWaves({
  level,
  state,
  bars = 7,
  color,
  maxHeight = 96,
}: SoundWavesProps) {
  const accent = color ?? colors.primary;
  // One Animated.Value per bar — each holds the current normalized height (0..1).
  const valuesRef = useRef<Animated.Value[]>([]);
  if (valuesRef.current.length !== bars) {
    valuesRef.current = Array.from({ length: bars }, () => new Animated.Value(BASELINE));
  }

  // Drive bars from the externally-supplied ``level`` (idle/listening).
  useEffect(() => {
    if (state === 'processing' || state === 'speaking') return;
    const targets = valuesRef.current.map((_, i) => {
      if (state === 'idle') return BASELINE;
      // Listening: each bar spreads around the centre + small per-bar
      // variation, scaled by mic level. Clamp to [BASELINE..1].
      const phase = PHASE_OFFSETS[i % PHASE_OFFSETS.length];
      const scaled = level * (0.6 + 0.4 * phase);
      return Math.max(BASELINE, Math.min(1, scaled));
    });
    valuesRef.current.forEach((v, i) => {
      Animated.spring(v, {
        toValue: targets[i],
        speed: 24, bounciness: 6,
        useNativeDriver: false,
      }).start();
    });
  }, [level, state, bars]);

  // Self-driving sine sweep for processing/speaking (mic muted → level=0).
  useEffect(() => {
    if (state !== 'processing' && state !== 'speaking') return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const t = (Date.now() - startedAt) / 220;
      valuesRef.current.forEach((v, i) => {
        const phase = PHASE_OFFSETS[i % PHASE_OFFSETS.length] * 6;
        // Sine-driven, amplitude depends on state:
        // - processing: gentler (0.15..0.55)
        // - speaking:   livelier (0.25..0.85)
        const lo = state === 'speaking' ? 0.25 : 0.15;
        const hi = state === 'speaking' ? 0.85 : 0.55;
        const amp = (Math.sin(t + phase) + 1) / 2;     // 0..1
        const target = lo + amp * (hi - lo);
        Animated.spring(v, {
          toValue: target,
          speed: 20, bounciness: 5,
          useNativeDriver: false,
        }).start();
      });
    }, 80);
    return () => clearInterval(id);
  }, [state]);

  const opacity = state === 'idle' ? 0.45
                : state === 'processing' ? 0.7
                : state === 'speaking' ? 1.0
                : 0.92;
  const tint = state === 'processing' ? colors.textSecondary : accent;

  return (
    <View style={[styles.row, { height: maxHeight }]}>
      {valuesRef.current.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              backgroundColor: tint,
              opacity,
              height: v.interpolate({
                inputRange: [0, 1],
                outputRange: [MIN_HEIGHT, maxHeight],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bar: {
    width: 9,
    borderRadius: 5,
  },
});
