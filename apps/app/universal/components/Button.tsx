/**
 * Unified Button system. Variants: primary | secondary | ghost | danger.
 * Sizes: xs | sm | md. Flat — no colored glow — consistent across screens.
 *
 * Why one component: buttons were previously a mix of PrimaryButton and
 * raw TouchableOpacity with ad-hoc styles, so identical actions looked
 * different between Settings and MCPs. Funneling every tappable "action"
 * through this component keeps the design system cohesive.
 */

import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import type { StyleProp, TextStyle, TouchableOpacityProps, ViewStyle } from 'react-native';
import { TouchableOpacity, StyleSheet, Text, View, Platform } from 'react-native';
import { colors, primaryGradientStops, radius, font } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

interface ButtonProps extends TouchableOpacityProps {
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: keyof typeof Feather.glyphMap;
  iconPosition?: 'left' | 'right';
  fullWidth?: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

const SIZE_STYLES = {
  xs: { minHeight: 26, paddingHorizontal: 10, paddingVertical: 4, fontSize: 11 as const, iconSize: 11 },
  sm: { minHeight: 30, paddingHorizontal: 12, paddingVertical: 6, fontSize: 12 as const, iconSize: 12 },
  md: { minHeight: 36, paddingHorizontal: 14, paddingVertical: 8, fontSize: 13 as const, iconSize: 13 },
} as const;

export default function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'left',
  fullWidth,
  disabled,
  children,
  style,
  textStyle,
  activeOpacity = 0.85,
  ...rest
}: ButtonProps) {
  const s = SIZE_STYLES[size];
  const color = textColorFor(variant);

  const inner = (
    <View style={[
      styles.row,
      { minHeight: s.minHeight, paddingHorizontal: s.paddingHorizontal, paddingVertical: s.paddingVertical },
    ]}>
      {icon && iconPosition === 'left' && (
        <Feather name={icon} size={s.iconSize} color={color} style={label || children ? { marginRight: 6 } : undefined} />
      )}
      {children ?? (label ? (
        <Text style={[styles.label, { color, fontSize: s.fontSize }, textStyle]}>
          {typeof label === 'string' ? label.toUpperCase() : label}
        </Text>
      ) : null)}
      {icon && iconPosition === 'right' && (
        <Feather name={icon} size={s.iconSize} color={color} style={label || children ? { marginLeft: 6 } : undefined} />
      )}
    </View>
  );

  const touchable = (
    <TouchableOpacity
      activeOpacity={activeOpacity}
      disabled={disabled}
      accessibilityRole="button"
      // @ts-ignore web className
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
      style={[
        styles.touchable,
        fullWidth && { alignSelf: 'stretch' },
        disabled && styles.disabled,
        variant !== 'primary' && variantStyle(variant),
        style,
      ]}
      {...rest}
    >
      {variant === 'primary' ? (
        <LinearGradient
          colors={[...primaryGradientStops]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradient}
        >
          {inner}
        </LinearGradient>
      ) : inner}
    </TouchableOpacity>
  );

  return touchable;
}

function textColorFor(variant: ButtonVariant): string {
  switch (variant) {
    case 'primary': return colors.textInverse;
    case 'secondary': return colors.text;
    case 'ghost': return colors.textSecondary;
    case 'danger': return colors.error;
  }
}

function variantStyle(variant: Exclude<ButtonVariant, 'primary'>): ViewStyle {
  switch (variant) {
    case 'secondary':
      return {
        backgroundColor: colors.panelBg ?? colors.surface,
        borderWidth: 1,
        borderColor: colors.borderStrong,
      };
    case 'ghost':
      return {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: colors.border,
      };
    case 'danger':
      return {
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.errorBorder,
      };
  }
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
    borderRadius: radius.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
    fontFamily: font.sans,
    letterSpacing: 1.4,
  },
});
