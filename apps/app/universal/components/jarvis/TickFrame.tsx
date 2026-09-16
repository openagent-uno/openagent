import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp } from 'react-native';
import { colors } from '../../theme';

interface Props {
  children: React.ReactNode;
  /** Length of each corner bracket leg in px. Default 12. */
  bracketLen?: number;
  /** Color override. */
  color?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Tiny corner-bracket "L" frame around children. Used to add a HUD
 * tick-mark border to list rows, modal headers, and other panels
 * without a full GlassPanel treatment.
 */
export default function TickFrame({
  children,
  bracketLen = 12,
  color = colors.accentDim,
  style,
}: Props) {
  const L = bracketLen;
  const t = 1; // thickness
  return (
    <View style={[styles.root, style]}>
      {/* Top-left */}
      <View style={[styles.bracket, { top: 0, left: 0, width: L, height: t, backgroundColor: color }]} />
      <View style={[styles.bracket, { top: 0, left: 0, width: t, height: L, backgroundColor: color }]} />
      {/* Top-right */}
      <View style={[styles.bracket, { top: 0, right: 0, width: L, height: t, backgroundColor: color }]} />
      <View style={[styles.bracket, { top: 0, right: 0, width: t, height: L, backgroundColor: color }]} />
      {/* Bottom-left */}
      <View style={[styles.bracket, { bottom: 0, left: 0, width: L, height: t, backgroundColor: color }]} />
      <View style={[styles.bracket, { bottom: 0, left: 0, width: t, height: L, backgroundColor: color }]} />
      {/* Bottom-right */}
      <View style={[styles.bracket, { bottom: 0, right: 0, width: L, height: t, backgroundColor: color }]} />
      <View style={[styles.bracket, { bottom: 0, right: 0, width: t, height: L, backgroundColor: color }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'relative' },
  bracket: { position: 'absolute', pointerEvents: 'none' },
});
