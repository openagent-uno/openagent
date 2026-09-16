import React from 'react';
import { View, StyleSheet, Platform, ViewStyle, StyleProp } from 'react-native';
import { colors, radius as r, spacing as s } from '../../theme';
import BlurView from '../BlurView';

interface Props {
  children: React.ReactNode;
  /** Show the glowing cyan rail across the top edge. Default true. */
  rail?: boolean;
  /** Make the rail glow continuously (pulse). Default false. */
  pulseRail?: boolean;
  /** Tighter padding for inline / list-row use. */
  compact?: boolean;
  /** Override padding completely. */
  padding?: number;
  /** Use a more opaque, more solid look (when there's no canvas grid behind). */
  solid?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Optional pressable layer outside this component should set this true to suppress hover effects. */
  noHover?: boolean;
}

/**
 * The shared JARVIS panel material. Translucent dark fill, hairline
 * cyan border, and an optional cyan glowing top rail (the "plugged
 * into a rail" detail you see on the music + chat widgets in the
 * reference video).
 *
 * Uses BlurView for cross-platform glass effect — CSS backdrop-filter
 * on web, native expo-blur on iOS/Android.
 */
export default function GlassPanel({
  children,
  rail = true,
  pulseRail = false,
  compact = false,
  padding,
  solid = false,
  style,
  noHover: _noHover = false,
}: Props) {
  const pad = padding ?? (compact ? s.sm : s.lg);

  const panelStyle: any[] = [
    styles.panel,
    solid ? styles.solid : styles.glass,
    { padding: pad },
    style,
    Platform.OS === 'web' && !solid && webGlassStyle(),
  ].filter(Boolean);

  const inner = (
    <>
      {rail && (
        <View
          style={[
            styles.rail,
            // @ts-ignore — boxShadow web-only
            Platform.OS === 'web' && { boxShadow: `0 0 8px ${colors.accentGlow}` },
            pulseRail && Platform.OS === 'web' && ({ animation: 'oa-jarvis-rail-pulse 2.4s ease-in-out infinite' } as any),
          ]}
        />
      )}
      {children}
    </>
  );

  if (!solid && Platform.OS !== 'web') {
    return (
      <BlurView intensity={2} style={panelStyle as any}>
        {inner}
      </BlurView>
    );
  }

  return <View style={panelStyle}>{inner}</View>;
}

function webGlassStyle(): any {
  return {
    backdropFilter: 'blur(2px) saturate(140%)',
    WebkitBackdropFilter: 'blur(2px) saturate(140%)',
  };
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: r.md,
    borderWidth: 1,
    borderColor: colors.border,
    position: 'relative',
    overflow: 'hidden',
  },
  glass: {
    backgroundColor: colors.panelBg,
  },
  solid: {
    backgroundColor: colors.panelBgSolid,
  },
  rail: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.panelRail,
  },
});
