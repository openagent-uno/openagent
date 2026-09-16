/**
 * TabStrip — segmented-pill tabs. Used for channel sub-tabs in Settings,
 * cost-range toggles in Model, auto-update mode selector, etc. Single
 * component so every "segment of mutually-exclusive options" looks the
 * same across screens.
 */

import Feather from '@expo/vector-icons/Feather';
import type { StyleProp, ViewStyle } from 'react-native';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radius, font } from '../theme';

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  icon?: keyof typeof Feather.glyphMap;
}

interface Props<T extends string> {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  size?: 'xs' | 'sm' | 'md';
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

const SIZE = {
  xs: { padH: 10, padV: 4, fontSize: 11, iconSize: 11 },
  sm: { padH: 12, padV: 6, fontSize: 11.5, iconSize: 12 },
  md: { padH: 12, padV: 7, fontSize: 12, iconSize: 13 },
} as const;

export default function TabStrip<T extends string>({
  tabs,
  active,
  onChange,
  size = 'md',
  fullWidth = false,
  style,
}: Props<T>) {
  const s = SIZE[size];
  return (
    <View style={[styles.strip, fullWidth && styles.fullWidth, style]}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <TouchableOpacity
            key={tab.id}
            activeOpacity={0.75}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
            style={[
              styles.tab,
              fullWidth && { flex: 1 },
              { paddingHorizontal: s.padH, paddingVertical: s.padV },
              isActive && styles.tabActive,
            ]}
          >
            {tab.icon && (
              <Feather
                name={tab.icon}
                size={s.iconSize}
                color={isActive ? colors.text : colors.textMuted}
                style={{ marginRight: 5 }}
              />
            )}
            <Text
              style={[
                styles.label,
                { fontSize: s.fontSize },
                isActive && styles.labelActive,
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    backgroundColor: colors.sidebar,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    padding: 2,
    gap: 2,
    alignSelf: 'flex-start',
  },
  fullWidth: { alignSelf: 'stretch' },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  tabActive: {
    backgroundColor: colors.surface,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 2,
  },
  label: {
    color: colors.textMuted,
    fontWeight: '500',
    fontFamily: font.sans,
  },
  labelActive: {
    color: colors.text,
    fontWeight: '600',
  },
});
