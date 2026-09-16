/**
 * SectionTabs — horizontal, scrollable section switcher pinned under the
 * react-navigation header on screens that split their content into
 * categories (Settings, System).
 *
 * Replaces the old nested-drawer ``CategorySidebar`` pattern, which broke
 * in the single-window sidebar shell (an independent ``drawerType: 'front'``
 * drawer fought the outer app drawer and only ever showed one section).
 * A single pill strip reads well everywhere: swipe the row sideways on a
 * phone, all pills visible on desktop. An optional ``trailing`` slot stays
 * pinned to the right (used for the System live/uptime badge).
 */

import type { ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { colors, font, radius } from '../theme';

export interface SectionTabItem<T extends string = string> {
  id: T;
  label: string;
  icon: keyof typeof Feather.glyphMap;
}

interface Props<T extends string> {
  tabs: SectionTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Pinned to the right of the strip, outside the scroll area. */
  trailing?: ReactNode;
}

export default function SectionTabs<T extends string>({
  tabs,
  active,
  onChange,
  trailing,
}: Props<T>) {
  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.row}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <TouchableOpacity
              key={tab.id}
              activeOpacity={0.75}
              onPress={() => onChange(tab.id)}
              style={[styles.tab, isActive && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={tab.label}
            >
              <Feather
                name={tab.icon}
                size={13}
                color={isActive ? colors.accent : colors.textMuted}
                style={styles.icon}
              />
              <Text
                style={[styles.label, isActive && styles.labelActive]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {trailing != null && <View style={styles.trailing}>{trailing}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    backgroundColor: colors.bg,
  },
  scroll: { flexShrink: 1, flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.inputBg,
  },
  tabActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.borderStrong,
  },
  icon: { marginRight: 6 },
  label: {
    fontSize: 12.5,
    color: colors.textSecondary,
    fontWeight: '500',
    fontFamily: font.sans,
  },
  labelActive: {
    color: colors.accent,
    fontWeight: '700',
  },
  trailing: {
    paddingHorizontal: 14,
    paddingLeft: 10,
  },
});
