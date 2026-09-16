import React, { useEffect, useMemo } from 'react';
import { View, StyleSheet, Text, Platform } from 'react-native';
import Svg, { Circle, G, Line, Path, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { colors, font } from '../../theme';
import OrbParticles from './OrbParticles';

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type OrbState = 'idle' | 'wake' | 'active';

interface Props {
  /** Outer rendered size (px). The orb art fills this box. */
  size?: number;
  /** Wordmark inside the orb. Default "JARVIS". */
  label?: string;
  /** v1: cosmetic only — every state currently runs the idle loop.
   *  Reserved for future signal wiring (voice / streaming). */
  state?: OrbState;
  /** Disable the drifting particles for low-end devices / a11y. */
  reducedMotion?: boolean;
  /** Hide the wordmark — useful when stacking with a clock below. */
  hideLabel?: boolean;
}

/**
 * The JARVIS orb. SVG-driven, Reanimated-driven, runs on UI thread on
 * native and CSS-equivalent on web. Layers, outside-in:
 *   - Outer arc (~125 % radius), counter-clockwise
 *   - Tick marks ring (~115 % radius), each twinkling on a phase offset
 *   - Inner arc (~110 % radius), clockwise
 *   - Halo glow (concentric circles, breathing opacity)
 *   - Bright cyan ring at the orb edge
 *   - Solid dark disc with the wordmark
 *   - Drifting particles (separate component)
 */
export default function JarvisOrb({
  size = 220,
  label = 'JARVIS',
  state: _state = 'idle',
  reducedMotion = false,
  hideLabel = false,
}: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const orbR = size * 0.32;       // solid disc radius
  const ringR = size * 0.355;     // bright cyan ring
  const innerArcR = size * 0.42;  // inner C-arc radius
  const outerArcR = size * 0.475; // outer C-arc radius
  const tickR = size * 0.40;      // tick mark ring radius
  const haloR = size * 0.395;     // glow halo radius

  // Continuous rotations.
  const innerRot = useSharedValue(0);
  const outerRot = useSharedValue(0);
  const haloPhase = useSharedValue(0);
  const tickPhase = useSharedValue(0);
  // One-shot mount opacity — quick power-on fade.
  const mountOpacity = useSharedValue(0);

  useEffect(() => {
    innerRot.value = 0;
    outerRot.value = 0;
    innerRot.value = withRepeat(
      withTiming(360, { duration: 6000, easing: Easing.linear }),
      -1,
      false,
    );
    outerRot.value = withRepeat(
      withTiming(-360, { duration: 9000, easing: Easing.linear }),
      -1,
      false,
    );
    haloPhase.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    tickPhase.value = withRepeat(
      withTiming(Math.PI * 2, { duration: 3000, easing: Easing.linear }),
      -1,
      false,
    );
    // Power-on: fade from 0 to 1 over 700 ms.
    mountOpacity.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
  }, []);

  const mountStyle = useAnimatedStyle(() => ({
    opacity: mountOpacity.value,
  }));

  const innerArcProps = useAnimatedProps(() => ({
    transform: `rotate(${innerRot.value} ${cx} ${cy})` as any,
  }));
  const outerArcProps = useAnimatedProps(() => ({
    transform: `rotate(${outerRot.value} ${cx} ${cy})` as any,
  }));
  const haloProps = useAnimatedProps(() => {
    const o = interpolate(haloPhase.value, [0, 1], [0.55, 1.0]);
    const r = interpolate(haloPhase.value, [0, 1], [haloR, haloR * 1.04]);
    return { opacity: o, r } as any;
  });

  // Tick marks — 24 evenly spaced. Each opacity is computed from the
  // shared phase + its index for a slow radar-sweep twinkle.
  const TICKS = 24;
  const ticks = useMemo(() => {
    const out: { x1: number; y1: number; x2: number; y2: number; idx: number }[] = [];
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const r1 = tickR;
      const r2 = tickR + size * 0.018;
      out.push({
        x1: cx + Math.cos(a) * r1,
        y1: cy + Math.sin(a) * r1,
        x2: cx + Math.cos(a) * r2,
        y2: cy + Math.sin(a) * r2,
        idx: i,
      });
    }
    return out;
  }, [cx, cy, tickR, size]);

  return (
    <Animated.View style={[styles.root, { width: size, height: size }, mountStyle]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <RadialGradient id="orbCore" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={colors.orbCore} stopOpacity="1" />
            <Stop offset="80%" stopColor={colors.orbCore} stopOpacity="0.95" />
            <Stop offset="100%" stopColor={colors.orbCore} stopOpacity="0.7" />
          </RadialGradient>
          <RadialGradient id="orbHalo" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={colors.accent} stopOpacity="0" />
            <Stop offset="70%" stopColor={colors.accent} stopOpacity="0" />
            <Stop offset="92%" stopColor={colors.accent} stopOpacity="0.45" />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* Outer halo glow — a fat radial gradient circle. */}
        <AnimatedCircle
          cx={cx}
          cy={cy}
          fill="url(#orbHalo)"
          animatedProps={haloProps}
        />

        {/* Outer C-arc, counter-clockwise. */}
        <AnimatedG animatedProps={outerArcProps}>
          <Path
            d={arcPath(cx, cy, outerArcR, -120, 60)}
            stroke={colors.accentDim}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
          />
          <Path
            d={arcPath(cx, cy, outerArcR, 110, 30)}
            stroke={colors.accent}
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
            opacity={0.9}
          />
        </AnimatedG>

        {/* Tick marks — twinkling. */}
        {ticks.map((t) => (
          <TwinkleTick key={t.idx} {...t} phase={tickPhase} count={TICKS} />
        ))}

        {/* Inner C-arc, clockwise. */}
        <AnimatedG animatedProps={innerArcProps}>
          <Path
            d={arcPath(cx, cy, innerArcR, 200, 90)}
            stroke={colors.accent}
            strokeWidth={1.8}
            fill="none"
            strokeLinecap="round"
          />
          <Path
            d={arcPath(cx, cy, innerArcR, 60, 40)}
            stroke={colors.accentDim}
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
          />
        </AnimatedG>

        {/* Bright cyan ring. */}
        <Circle
          cx={cx}
          cy={cy}
          r={ringR}
          stroke={colors.accent}
          strokeWidth={2}
          fill="none"
          opacity={0.95}
        />

        {/* Solid dark core. */}
        <Circle cx={cx} cy={cy} r={orbR} fill="url(#orbCore)" />
        <Circle
          cx={cx}
          cy={cy}
          r={orbR}
          stroke={colors.accent}
          strokeWidth={0.6}
          fill="none"
          opacity={0.4}
        />

        {/* Drifting particles. */}
        <OrbParticles cx={cx} cy={cy} radius={size * 0.55} reducedMotion={reducedMotion} />
      </Svg>

      {!hideLabel && (
        <View style={[styles.labelWrap, { width: size, height: size }]} pointerEvents="none">
          <Text style={styles.label}>{label}</Text>
        </View>
      )}

      {Platform.OS === 'web' && (
        <WebGlow size={size} />
      )}
    </Animated.View>
  );
}

/** SVG arc path — a portion of a circle from (startDeg, startDeg+sweepDeg). */
function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, startDeg + sweepDeg);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function TwinkleTick({
  x1,
  y1,
  x2,
  y2,
  idx,
  phase,
  count,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  idx: number;
  phase: Animated.SharedValue<number>;
  count: number;
}) {
  const animatedProps = useAnimatedProps(() => {
    const offset = (idx / count) * Math.PI * 2;
    const v = (Math.sin(phase.value + offset) + 1) / 2; // 0..1
    return { opacity: 0.35 + v * 0.6 } as any;
  });
  return (
    <Animated.View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg style={StyleSheet.absoluteFill}>
        <AnimatedLine
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={colors.tickActive}
          strokeWidth={1}
          animatedProps={animatedProps}
        />
      </Svg>
    </Animated.View>
  );
}
const AnimatedLine = Animated.createAnimatedComponent(Line);

/** Web-only soft glow under the orb — uses CSS box-shadow (cheaper than SVG filter). */
function WebGlow({ size }: { size: number }) {
  const phase = useSharedValue(0);
  useEffect(() => {
    phase.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, []);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(phase.value, [0, 1], [0.45, 0.85]),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.webGlow,
        { width: size, height: size },
        // @ts-ignore — boxShadow string is web-only
        { boxShadow: `0 0 ${size * 0.25}px ${colors.accentGlow}, 0 0 ${size * 0.5}px ${colors.accentGlow}` },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  root: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  labelWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: colors.text,
    fontFamily: font.display,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 4,
    textAlign: 'center',
  },
  webGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    borderRadius: 9999,
    pointerEvents: 'none',
  },
});
