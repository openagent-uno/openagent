import React, { useEffect, useMemo } from 'react';
import { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withRepeat,
  withTiming,
    Easing,
} from 'react-native-reanimated';
import { colors } from '../../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface Props {
  /** Center x of the orb — particles drift around this point. */
  cx: number;
  /** Center y of the orb. */
  cy: number;
  /** Approximate radius they drift within (~2× orb radius). */
  radius: number;
  /** How many particles. Default 18. */
  count?: number;
  /** Reduce motion / particle count for low-end devices. */
  reducedMotion?: boolean;
}

/**
 * Drifting cyan dust-mote particles around the orb. Each particle owns
 * a single shared value driving its (cx, cy) along an elliptical loop;
 * starting phase, axes, and speed are seeded deterministically so the
 * cloud feels organic without per-frame randomness.
 */
export default function OrbParticles({
  cx,
  cy,
  radius,
  count = 18,
  reducedMotion = false,
}: Props) {
  const n = reducedMotion ? Math.min(8, Math.floor(count / 2)) : count;
  const seeds = useMemo(() => {
    const out: { phase: number; rx: number; ry: number; tilt: number; speed: number; r: number; opacity: number }[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n);
      out.push({
        phase: t * Math.PI * 2,
        rx: radius * (0.55 + 0.45 * pseudoRand(i, 1)),
        ry: radius * (0.40 + 0.45 * pseudoRand(i, 2)),
        tilt: pseudoRand(i, 3) * Math.PI,
        speed: 0.6 + pseudoRand(i, 4) * 0.7, // 0.6 - 1.3
        r: 0.8 + pseudoRand(i, 5) * 1.6,
        opacity: 0.35 + pseudoRand(i, 6) * 0.5,
      });
    }
    return out;
  }, [n, radius]);

  return (
    <>
      {seeds.map((s, i) => (
        <Particle key={i} cx={cx} cy={cy} seed={s} reducedMotion={reducedMotion} />
      ))}
    </>
  );
}

function Particle({
  cx,
  cy,
  seed,
  reducedMotion,
}: {
  cx: number;
  cy: number;
  seed: { phase: number; rx: number; ry: number; tilt: number; speed: number; r: number; opacity: number };
  reducedMotion: boolean;
}) {
  const t = useSharedValue(seed.phase);

  useEffect(() => {
    const dur = (reducedMotion ? 16000 : 9000) / seed.speed;
    t.value = seed.phase;
    t.value = withRepeat(
      withTiming(seed.phase + Math.PI * 2, { duration: dur, easing: Easing.linear }),
      -1,
      false,
    );
  }, [seed.speed, seed.phase, reducedMotion]);

  const animatedProps = useAnimatedProps(() => {
    const x = seed.rx * Math.cos(t.value);
    const y = seed.ry * Math.sin(t.value);
    const cos = Math.cos(seed.tilt);
    const sin = Math.sin(seed.tilt);
    return {
      cx: cx + x * cos - y * sin,
      cy: cy + x * sin + y * cos,
    };
  });

  return (
    <AnimatedCircle
      animatedProps={animatedProps}
      r={seed.r}
      fill={colors.accent}
      opacity={seed.opacity}
    />
  );
}

function pseudoRand(i: number, salt: number): number {
  // Deterministic 0..1 from two ints — cheap hash, good enough for dot seeds.
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
