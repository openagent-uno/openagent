import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, ScrollView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, font, radius } from '../../theme';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import TickFrame from './TickFrame';
import BlurView from '../BlurView';

/**
 * Custom tab bar that replaces the default Expo bottom tabs with a
 * JARVIS-style dock — centered glass strip with outlined glyph icons,
 * a sliding cyan indicator under the active tab, and tracked-out
 * uppercase labels. Designed to be passed directly as the `tabBar`
 * render prop on the `Tabs` navigator.
 */
export default function JarvisDock(props: BottomTabBarProps) {
  const { state, descriptors, navigation } = props;

  const isElectron = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return (window as any).desktop?.isDesktop === true;
  }, []);

  // Build the visible-tab list once. Routes are hidden from the dock
  // when expo-router marks them with `href: null` (legacy redirects).
  // expo-router signals this several ways depending on version, so we
  // check all of them.
  // On Electron the Chat tab opens in the main window — hide it from
  // sub-window dock bars so the user opens it via the window menu.
  const visible = state.routes
    .map((route, index) => {
      const desc = descriptors[route.key];
      const opt: any = desc.options ?? {};
      const hidden =
        opt.href === null ||
        opt.tabBarButton === null ||
        opt.tabBarItemStyle?.display === 'none' ||
        // expo-router sets this on hidden routes in some versions:
        opt.tabBarStyle?.display === 'none' ||
        // Final safety net for known legacy routes:
        route.name === 'automations' ||
        // Electron: hide Chat from sub-window dock bars
        (isElectron && route.name === 'chat');
      return hidden ? null : { route, index, desc };
    })
    .filter(Boolean) as { route: typeof state.routes[number]; index: number; desc: any }[];

  // Width of each item — track on layout so the indicator can slide.
  const [itemWidths, setItemWidths] = useState<Record<number, number>>({});
  const [itemX, setItemX] = useState<Record<number, number>>({});

  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);
  const indicatorOpacity = useSharedValue(0);

  // The "visible index" of the currently-active route.
  const activeVisibleIndex = visible.findIndex((v) => v.index === state.index);

  useEffect(() => {
    if (isElectron) return;
    if (activeVisibleIndex < 0) return;
    const x = itemX[activeVisibleIndex];
    const w = itemWidths[activeVisibleIndex];
    if (typeof x !== 'number' || typeof w !== 'number') return;
    indicatorX.value = withSpring(x, { damping: 22, stiffness: 220 });
    indicatorW.value = withSpring(w, { damping: 22, stiffness: 220 });
    indicatorOpacity.value = withTiming(1, { duration: 200 });
  }, [isElectron, activeVisibleIndex, itemX, itemWidths]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorW.value,
    opacity: indicatorOpacity.value,
  }));

  const dockStyle: any[] = [
    styles.dock,
    Platform.OS === 'web' && { backdropFilter: 'blur(2.6px) saturate(140%)', WebkitBackdropFilter: 'blur(2.6px) saturate(140%)' },
    // @ts-ignore boxShadow web-only
    Platform.OS === 'web' && { boxShadow: `0 0 24px ${colors.accentGlow}, 0 12px 28px rgba(0,0,0,0.4)` },
  ].filter(Boolean);

  const dockInner = (
    <>
      {/* Top cyan rail — hidden in Electron (no active tab). */}
      {!isElectron && (
        <View
          style={[
            styles.rail,
            // @ts-ignore boxShadow web-only
            Platform.OS === 'web' && { boxShadow: `0 0 6px ${colors.accentGlow}` },
          ]}
        />
      )}

      {/* Sliding indicator under the active tab — hidden in Electron. */}
      {!isElectron && (
        <Animated.View style={[styles.indicator, indicatorStyle]} pointerEvents="none" />
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {visible.map(({ route, index, desc }, vIdx) => {
          const isFocused = !isElectron && state.index === index;
          const label =
            typeof desc.options.tabBarLabel === 'string'
              ? desc.options.tabBarLabel
              : (desc.options.title ?? route.name);
          const iconName = (desc.options.tabBarIcon as any)?.({})?.props?.name as
            | keyof typeof Feather.glyphMap
            | undefined;

          const onPress = () => {
            if (isElectron) {
              (window as any).desktop.openWindow(route.name);
              return;
            }

            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              (navigation as any).navigate(route.name, route.params);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              onLayout={(e) => {
                if (isElectron) return;
                const { width, x } = e.nativeEvent.layout;
                setItemWidths((m) => (m[vIdx] === width ? m : { ...m, [vIdx]: width }));
                setItemX((m) => (m[vIdx] === x ? m : { ...m, [vIdx]: x }));
              }}
              style={styles.item}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
            >
              {iconName && (
                <Feather
                  name={iconName as any}
                  size={16}
                  color={isFocused ? colors.accent : colors.textSecondary}
                  style={
                    Platform.OS === 'web' && isFocused
                      ? ({ textShadow: `0 0 8px ${colors.accentGlow}` } as any)
                      : undefined
                  }
                />
              )}
              <Text
                style={[
                  styles.label,
                  { color: isFocused ? colors.accent : colors.textSecondary },
                ]}
              >
                {String(label).toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </>
  );

  return (
    <View style={styles.outer}>
      <TickFrame style={styles.frame} bracketLen={8}>
        {Platform.OS !== 'web' ? (
          <BlurView intensity={2.6} style={dockStyle as any}>
            {dockInner}
          </BlurView>
        ) : (
          <View style={dockStyle}>
            {dockInner}
          </View>
        )}
      </TickFrame>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    paddingBottom: 14,
    paddingTop: 6,
    alignItems: 'center',
  },
  frame: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  dock: {
    flexDirection: 'row',
    backgroundColor: colors.panelBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    paddingHorizontal: 6,
    overflow: 'hidden',
    minWidth: 320,
    maxWidth: 760,
  },
  rail: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
    backgroundColor: colors.panelRail,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  item: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 64,
  },
  label: {
    fontSize: 9.5,
    fontFamily: font.sans,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 4,
  },
  indicator: {
    position: 'absolute',
    bottom: 2,
    height: 2,
    backgroundColor: colors.accent,
    borderRadius: 2,
    // @ts-ignore web boxShadow
    ...(Platform.OS === 'web' ? { boxShadow: `0 0 8px ${jarvisGlow()}` } : {}),
  },
});

function jarvisGlow(): string {
  // colors.accentGlow is a CSS var on web; resolve via CSS var literal.
  return 'var(--oa-accentGlow)';
}
