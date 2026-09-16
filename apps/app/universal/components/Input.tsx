/**
 * Input — text field wrapped with an optional uppercase label and hint.
 * Used everywhere forms appear so fields look identical app-wide.
 * `mono` applies the platform monospace family — good for tokens, paths, IDs.
 */

import type { ReactNode } from 'react';
import type { StyleProp, TextInputProps, TextStyle, ViewStyle } from 'react-native';
import { View, Text, TextInput, StyleSheet, Platform } from 'react-native';
import { colors, font, radius } from '../theme';

interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  mono?: boolean;
  multiline?: boolean;
  rows?: number;
  rightAdornment?: ReactNode;
}

export default function Input({
  label,
  hint,
  containerStyle,
  inputStyle,
  mono = false,
  multiline = false,
  rows = 3,
  rightAdornment,
  style,
  ...textProps
}: FieldProps) {
  const fontFamily = mono ? font.mono : font.sans;

  const input = Platform.OS === 'web' && multiline ? (
    <textarea
      value={(textProps.value as any) ?? ''}
      onChange={(e: any) => (textProps as any).onChangeText?.(e.target.value)}
      placeholder={textProps.placeholder}
      rows={rows}
      style={{
        backgroundColor: colors.inputBg,
        borderRadius: radius.md,
        border: `1px solid ${colors.border}`,
        borderTopWidth: 1.5,
        borderTopColor: colors.accentDim,
        padding: '9px 11px',
        color: colors.text,
        fontSize: 13,
        fontFamily,
        letterSpacing: 0.3,
        resize: 'vertical',
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 72,
        transition: 'box-shadow 160ms ease, border-color 160ms ease',
      } as any}
    />
  ) : (
    <TextInput
      placeholderTextColor={colors.textMuted}
      multiline={multiline}
      {...textProps}
      style={[
        styles.input,
        { fontFamily },
        multiline && styles.multiline,
        inputStyle,
        style,
      ]}
    />
  );

  return (
    <View style={containerStyle}>
      {label && <Text style={styles.label}>{label}</Text>}
      {rightAdornment ? (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>{input}</View>
          <View style={styles.adornment}>{rightAdornment}</View>
        </View>
      ) : input}
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 1.5,
    borderTopColor: colors.accentDim,
    paddingHorizontal: 11,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 13,
    letterSpacing: 0.3,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: 9,
  },
  hint: {
    fontSize: 10.5,
    color: colors.textMuted,
    marginTop: 5,
    lineHeight: 15,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  adornment: {},
});
