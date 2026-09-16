/**
 * Card — JARVIS-themed bordered surface with an optional cyan top rail.
 *
 * `padded` adds default interior padding (16); omit for list-style cards
 * where inner rows handle their own padding. `rail` opts into the cyan
 * accent line only when it communicates a real selected/progress state.
 */

import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { View, StyleSheet, Platform } from 'react-native';
import { colors, radius } from '../theme';
import BlurView from './BlurView';

interface CardProps {
  children: ReactNode;
  padded?: boolean;
  tight?: boolean;
  rail?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function Card({
  children,
  padded = true,
  tight = false,
  rail = false,
  style,
}: CardProps) {
  // NOTE: no web backdrop-filter here. `colors.surface` is already ~72%
  // opaque, so the blur was nearly invisible while forcing Chromium to
  // snapshot + gaussian-blur the backdrop of every card on every frame
  // (a major scroll-jank source on card-dense screens). Solid fill only.
  const cardStyle: any[] = [
    styles.card,
    padded && (tight ? styles.tight : styles.padded),
    style,
  ].filter(Boolean);

  const inner = (
    <>
      {/* Solid 1.5px cyan rail — no box-shadow glow (the blurred shadow
          layer repainted per frame for a barely-visible effect). */}
      {rail && <View style={styles.rail} />}
      {children}
    </>
  );

  if (Platform.OS !== 'web') {
    return <BlurView intensity={2} style={cardStyle as any}>{inner}</BlurView>;
  }

  return <View style={cardStyle}>{inner}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    position: 'relative',
    overflow: 'hidden',
  },
  padded: { padding: 16 },
  tight: { padding: 12 },
  rail: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
    backgroundColor: colors.panelRail,
  },
});

/** Thin divider row used inside Cards to separate stacked items. */
export function CardDivider() {
  return <View style={{ height: 1, backgroundColor: colors.borderLight }} />;
}
