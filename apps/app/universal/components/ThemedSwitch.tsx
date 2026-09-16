import type { StyleProp, ViewStyle } from 'react-native';
import { Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import { colors } from '../theme';

interface ThemedSwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function ThemedSwitch({
  value,
  onValueChange,
  disabled = false,
  style,
}: ThemedSwitchProps) {
  if (Platform.OS !== 'web') {
    return (
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={colors.surface}
      />
    );
  }

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => [
        styles.webRoot,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <View style={[styles.track, value ? styles.trackOn : styles.trackOff]}>
        <View style={[styles.thumb, value ? styles.thumbOn : styles.thumbOff]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  webRoot: { padding: 2, borderRadius: 999 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  track: {
    width: 32, height: 18, borderRadius: 999,
    padding: 2, justifyContent: 'center',
    // @ts-ignore web transition
    transition: 'background-color 0.18s ease',
  },
  trackOn: { backgroundColor: colors.primary },
  trackOff: { backgroundColor: colors.borderStrong },
  thumb: {
    width: 14, height: 14, borderRadius: 999,
    backgroundColor: colors.surface,
    shadowColor: 'rgba(26, 25, 21, 0.24)',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1, shadowRadius: 2,
    // @ts-ignore
    transition: 'transform 0.18s ease',
  },
  thumbOn: { transform: [{ translateX: 14 }] },
  thumbOff: { transform: [{ translateX: 0 }] },
});
