import React from 'react';
import { View, StyleSheet, Platform, ViewStyle } from 'react-native';
import { colors, getRawColors } from '../../theme';

const raw = getRawColors();

interface Props {
  children: React.ReactNode;
  /** Show the corner HUD brackets. Default true. */
  showBrackets?: boolean;
  /** Show edge ruler ticks. Default true. */
  showEdgeTicks?: boolean;
  /** Paint the dotted blueprint grid. Default true. */
  showGrid?: boolean;
  style?: ViewStyle;
}

/**
 * Full-screen JARVIS canvas — paints the dotted blueprint grid, the
 * faint edge ruler ticks, and (optionally) the corner HUD brackets.
 * Wraps every screen so the entire app shares the same engineering
 * canvas backdrop.
 *
 * On web the grid is drawn with a CSS background-image (cheap, sharp,
 * no extra DOM nodes). On native we fall back to a single solid bg
 * for v1 — the orb and panels carry the JARVIS look on their own.
 */
export default function JarvisCanvas({
  children,
  showBrackets = true,
  showEdgeTicks = true,
  showGrid = true,
  style,
}: Props) {
  const webBg = Platform.OS === 'web'
    ? (showGrid ? webBgStyle() : { backgroundColor: raw.bg })
    : null;
  const bgStyle = Platform.OS === 'web'
    ? [styles.bg, webBg]
    : [styles.bg, styles.nativeBg];
  return (
    <View style={[styles.root, style]}>
      <View style={bgStyle as any} />
      {showEdgeTicks && Platform.OS === 'web' && <EdgeTicks />}
      {showBrackets && Platform.OS === 'web' && <CornerBrackets />}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

function webBgStyle(): any {
  return {
    backgroundColor: raw.bg,
    backgroundImage: [
      `linear-gradient(${raw.gridLine} 1px, transparent 1px)`,
      `linear-gradient(90deg, ${raw.gridLine} 1px, transparent 1px)`,
      `radial-gradient(circle at 16px 16px, ${raw.gridDot} 1px, transparent 1px)`,
    ].join(', '),
    backgroundSize: '64px 64px, 64px 64px, 64px 64px',
    backgroundPosition: '0 0, 0 0, 0 0',
  };
}

function EdgeTicks() {
  // 4 strips of small dashes hugging each edge. Web-only for v1.
  const tickColor = colors.tickDim;
  const dash = `${tickColor} 0 6px, transparent 6px 24px`;
  const baseStyle: any = { position: 'absolute', pointerEvents: 'none' };
  return (
    <>
      <View style={[
        baseStyle,
        { top: 6, left: 32, right: 32, height: 1,
          backgroundImage: `repeating-linear-gradient(90deg, ${dash})` },
      ]} />
      <View style={[
        baseStyle,
        { bottom: 6, left: 32, right: 32, height: 1,
          backgroundImage: `repeating-linear-gradient(90deg, ${dash})` },
      ]} />
      <View style={[
        baseStyle,
        { left: 6, top: 32, bottom: 32, width: 1,
          backgroundImage: `repeating-linear-gradient(0deg, ${dash})` },
      ]} />
      <View style={[
        baseStyle,
        { right: 6, top: 32, bottom: 32, width: 1,
          backgroundImage: `repeating-linear-gradient(0deg, ${dash})` },
      ]} />
    </>
  );
}

function CornerBrackets() {
  // Four short "L" brackets at each corner. Web-only.
  const c = colors.accentDim;
  const len = 18;
  const thick = 1;
  const inset = 14;
  const baseStyle: any = { position: 'absolute', pointerEvents: 'none', borderColor: c };
  return (
    <>
      <View style={[baseStyle, { top: inset, left: inset, width: len, height: thick, backgroundColor: c }]} />
      <View style={[baseStyle, { top: inset, left: inset, width: thick, height: len, backgroundColor: c }]} />
      <View style={[baseStyle, { top: inset, right: inset, width: len, height: thick, backgroundColor: c }]} />
      <View style={[baseStyle, { top: inset, right: inset, width: thick, height: len, backgroundColor: c }]} />
      <View style={[baseStyle, { bottom: inset, left: inset, width: len, height: thick, backgroundColor: c }]} />
      <View style={[baseStyle, { bottom: inset, left: inset, width: thick, height: len, backgroundColor: c }]} />
      <View style={[baseStyle, { bottom: inset, right: inset, width: len, height: thick, backgroundColor: c }]} />
      <View style={[baseStyle, { bottom: inset, right: inset, width: thick, height: len, backgroundColor: c }]} />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: raw.bg, position: 'relative', overflow: 'hidden' },
  bg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  nativeBg: { backgroundColor: raw.bg },
  content: { flex: 1, position: 'relative', zIndex: 1 },
});
