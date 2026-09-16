/**
 * ReasoningIndicator — animated "the agent is thinking" cue.
 *
 * Replaces the static "Thinking…" status text with a premium, on-brand
 * signal (Claude-desktop-style) shown while a session's ``isReasoning``
 * flag is set — driven by the transient ``reasoning`` wire frame (see
 * [[common/types.ts]] ServerMessage + [[stores/chat.ts]]).
 *
 * Animation is driven by ``requestAnimationFrame`` + state, NOT CSS and
 * NOT the Animated API. Two things ruled those out in this app's
 * react-native-web build (both verified live in-browser): the
 * ``className`` prop is never forwarded to the DOM (so CSS keyframes can't
 * attach — the legacy ``.oa-pulse`` dot is dead too), and the JS-driver
 * ``Animated`` value stays pinned at its initial value (never ticks). rAF
 * exists on web and native, re-renders are cheap for a ~9-glyph inline
 * cue, and it animates identically everywhere.
 *
 * Effect: a bright crest sweeps across the "Reasoning" wordmark
 * glyph-by-glyph (a shimmer wave) while three trailing dots ride the same
 * crest — brightening, rising and scaling as it passes. Cyan + monospace.
 */

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font } from '../theme';

const PERIOD_MS = 1150;   // one full left→right sweep
const WINDOW = 0.32;      // how wide the bright crest is (fraction of the row)
const DOTS = 3;

interface ReasoningIndicatorProps {
  /** Override the label text (defaults to "Reasoning"). */
  label?: string;
}

/** Triangular bump in [0,1]: 1 at the crest, 0 once |Δ| ≥ WINDOW.
 *  ``pos`` and ``phase`` are both in [0,1]; the distance wraps so the
 *  crest re-enters from the left seamlessly. */
function intensity(pos: number, phase: number): number {
  let d = Math.abs(pos - phase);
  if (d > 0.5) d = 1 - d; // wrap-around distance
  return d >= WINDOW ? 0 : 1 - d / WINDOW;
}

export default function ReasoningIndicator({ label = 'Reasoning' }: ReasoningIndicatorProps) {
  const letters = label.split('');
  const slots = letters.length + DOTS; // letters + dots share one travelling crest
  const [phase, setPhase] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start == null) start = ts;
      setPhase((((ts - start) % PERIOD_MS) / PERIOD_MS));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <View style={styles.row} accessibilityRole="text" accessibilityLabel="Reasoning">
      <View style={styles.word}>
        {letters.map((ch, i) => {
          const k = intensity(i / (slots - 1), phase);
          return (
            <Text key={i} style={[styles.letter, { opacity: 0.4 + 0.6 * k }]}>
              {ch}
            </Text>
          );
        })}
      </View>
      <View style={styles.dots}>
        {Array.from({ length: DOTS }).map((_, d) => {
          const k = intensity((letters.length + d) / (slots - 1), phase);
          return (
            <View
              key={d}
              style={[
                styles.dot,
                {
                  opacity: 0.3 + 0.7 * k,
                  transform: [{ translateY: -4 * k }, { scale: 0.8 + 0.45 * k }],
                },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  word: { flexDirection: 'row', alignItems: 'baseline' },
  letter: {
    fontSize: 13,
    fontFamily: font.mono,
    letterSpacing: 0.6,
    color: colors.primary,
  },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 1 },
  dot: {
    width: 5, height: 5, borderRadius: 2.5,
    backgroundColor: colors.primary,
  },
});
