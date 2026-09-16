/**
 * PrimaryButton — thin backwards-compat wrapper around `Button` with
 * `variant="primary"`. Keeps older call-sites working while routing
 * every button through the unified component.
 *
 * Prefer `Button` directly for new code.
 */

import type { ReactNode } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import type { StyleProp, TextStyle, TouchableOpacityProps, ViewStyle } from 'react-native';
import { TouchableOpacity, StyleSheet, Text, Platform } from 'react-native';
import { colors, primaryGradientStops, radius, font } from '../theme';

interface PrimaryButtonProps extends TouchableOpacityProps {
  label?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

export default function PrimaryButton({
  label,
  children,
  disabled,
  style,
  contentStyle,
  textStyle,
  activeOpacity = 0.85,
  ...props
}: PrimaryButtonProps) {
  return (
    <TouchableOpacity
      activeOpacity={activeOpacity}
      disabled={disabled}
      accessibilityRole="button"
      // @ts-ignore web className
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
      style={[styles.touchable, disabled && styles.disabled, style]}
      {...props}
    >
      <LinearGradient
        colors={[...primaryGradientStops]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.gradient, contentStyle]}
      >
        {children ?? <Text style={[styles.label, textStyle]}>{label}</Text>}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  touchable: {
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  disabled: {
    opacity: 0.4,
  },
  gradient: {
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  label: {
    color: colors.textInverse,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: font.sans,
    letterSpacing: -0.1,
  },
});
