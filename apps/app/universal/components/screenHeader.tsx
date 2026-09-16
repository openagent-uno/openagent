/**
 * Shared react-navigation header pieces.
 *
 * EVERY screen — top-level tabs AND pushed sub-screens (editors, run
 * history, note views) — uses the real navigator header, never a custom
 * in-content title bar. Top-level screens get `HeaderMenu`; pushed workspace
 * screens pair `HeaderMenu` and `HeaderBack` so both navigation axes remain
 * reachable at every breakpoint.
 * Right-side actions use `HeaderAction` (labelled button) or
 * `HeaderIconButton` (icon-only). All controls are `no-drag` so the rest
 * of the header still drags the window. See DragRegion.
 */

import { Pressable, Text, Platform, View, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { useLayout } from '../hooks/useLayout';
import {
  configureNextDrawerLayout,
  useReducedMotion,
} from '../hooks/useDrawerMotion';
import { goBack } from '../services/windows';
import { useNavHistory } from '../stores/navHistory';
import { useNavigationSidebar } from '../stores/navigationSidebar';
import { useSessionDetailsDrawer } from '../stores/sessionDetailsDrawer';
import DragRegion, { NO_DRAG } from './DragRegion';
import { colors, font, radius, glassSurface } from '../theme';

type IconName = keyof typeof Feather.glyphMap;

// The whole header drags the window. react-navigation paints `headerBackground`
// as a fill BEHIND the title + buttons (its siblings, not its children), so the
// `no-drag` buttons are never nested inside the drag region — which is what
// caused the macOS double-click-to-maximize button freeze. See DragRegion.

/**
 * Frosted-glass header background — a translucent surface tone over the
 * app canvas with a web `backdrop-filter` blur, plus a hairline bottom
 * border. The transparent `DragRegion` sits on top so the window still
 * drags from the empty header space (Electron). The header is
 * `headerTransparent`, so content scrolls UNDER this glass and is blurred
 * by it; each screen offsets its top content by `useHeaderInset()`.
 */
function HeaderGlassBackground() {
  return (
    <View style={[StyleSheet.absoluteFill, headerGlassStyle]}>
      <DragRegion />
    </View>
  );
}

const headerGlassStyle = {
  // Shared frosted-glass recipe (see theme `glassSurface`) so the header
  // matches every floating panel exactly. Low-alpha tint keeps content
  // scrolling underneath visible; the blur is a faint softening on top.
  backgroundColor: glassSurface.backgroundColor,
  borderBottomWidth: 1,
  borderBottomColor: colors.borderLight,
  ...(Platform.OS === 'web'
    ? ({
        backdropFilter: glassSurface.webFilter,
        WebkitBackdropFilter: glassSurface.webFilter,
      } as any)
    : {}),
};

/** Themed header options shared by every screen's navigator. */
export const themedHeader = {
  headerShown: true,
  // Draw screen content BEHIND the header so the frosted glass blurs the
  // content scrolling under it. Every screen offsets its top content by
  // `useHeaderInset()` (header height + safe-area top) so nothing hides.
  headerTransparent: true,
  // Transparent so the frosted `headerBackground` is what shows.
  headerStyle: { backgroundColor: 'transparent' },
  headerShadowVisible: false,
  headerTitleAlign: 'center' as const,
  headerTintColor: colors.accent,
  // Frosted glass strip behind the title/buttons, doubling as the
  // window drag region (Electron) via the transparent DragRegion.
  headerBackground: () => <HeaderGlassBackground />,
  headerTitleStyle: {
    fontFamily: font.display,
    fontSize: 17,
    fontWeight: '600' as const,
    color: colors.text,
    letterSpacing: -0.1,
  },
};

/**
 * Top inset for screen content, equal to the (transparent) header height
 * including the device safe-area top. Add it as `paddingTop` to a
 * screen's scroll `contentContainerStyle` (so content scrolls behind the
 * frosted header) or to a pinned top bar's container (so it sits just
 * below the header). Only valid inside a screen that renders a header.
 */
export function useHeaderInset(): number {
  return useHeaderHeight();
}

/** Left navigation-drawer toggle. It stays available at every breakpoint:
 *  desktop starts open, but the user can reclaim the full content width. */
export function HeaderMenu() {
  const navigation = useNavigation();
  const { isPhone } = useLayout();
  const reducedMotion = useReducedMotion();
  const wideSidebarOpen = useNavigationSidebar((state) => state.isOpen);
  const toggleWideSidebar = useNavigationSidebar((state) => state.toggle);
  return (
    <Pressable
      onPress={() => {
        if (isPhone) navigation.dispatch(DrawerActions.toggleDrawer());
        else {
          configureNextDrawerLayout(reducedMotion);
          toggleWideSidebar();
        }
      }}
      hitSlop={8}
      style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginLeft: 6, borderRadius: radius.md, ...NO_DRAG }}
      accessibilityRole="button"
      accessibilityState={{ expanded: isPhone ? undefined : wideSidebarOpen }}
      accessibilityLabel="Toggle navigation sidebar"
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
    >
      <Feather name="sidebar" size={18} color={colors.textSecondary} />
    </Pressable>
  );
}

/** Right session-details drawer toggle. Mirroring the left sidebar glyph and
 *  button geometry makes the two workspace edges read as one control pair. */
export function HeaderSessionDetails() {
  const { isPhone } = useLayout();
  const reducedMotion = useReducedMotion();
  const requestToggle = useSessionDetailsDrawer((state) => state.requestToggle);
  const isOpen = useSessionDetailsDrawer((state) => state.isOpen);
  return (
    <Pressable
      onPress={() => {
        if (!isPhone) configureNextDrawerLayout(reducedMotion);
        requestToggle();
      }}
      hitSlop={8}
      style={{
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 6,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: isOpen ? colors.border : 'transparent',
        backgroundColor: isOpen ? colors.primaryLight : 'transparent',
        ...NO_DRAG,
      }}
      accessibilityRole="button"
      accessibilityState={{ expanded: isOpen }}
      accessibilityLabel="Toggle session details"
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
    >
      <Feather
        name="sidebar"
        size={18}
        color={isOpen ? colors.accent : colors.textSecondary}
        style={{ transform: [{ scaleX: -1 }] }}
      />
    </Pressable>
  );
}

/** Back control for `headerLeft` on pushed sub-screens — a themed,
 *  no-drag chevron that steps back through the app's navigation history
 *  via `goBack` (expo-router's `router.back()`, guarded + with a
 *  `fallback`). Unlike react-navigation's per-navigator `goBack()`, this
 *  composes across the Drawer's section stacks, so a screen pushed from
 *  another section (a run opened from a Chat card) returns to where it was
 *  opened from rather than dead-ending on a single-screen stack. Pass
 *  `onPress` to override the dismissal (e.g. terminal closes its window);
 *  pass `fallback` for the cold-deep-link landing (defaults to chat). */
export function HeaderBack({ onPress, label, fallback }: { onPress?: () => void; label?: string; fallback?: string }) {
  const router = useRouter();
  const onBack = () => {
    if (onPress) { onPress(); return; }
    goBack(router, fallback);
  };
  return (
    <Pressable
      onPress={onBack}
      hitSlop={8}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 2,
        height: 36, paddingHorizontal: 8, marginLeft: 4,
        borderRadius: radius.md, ...NO_DRAG,
      }}
      accessibilityRole="button"
      accessibilityLabel="Back"
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
    >
      <Feather name="chevron-left" size={22} color={colors.accent} />
      {label ? (
        <Text style={{ fontFamily: font.sans, fontSize: 14, fontWeight: '600', color: colors.accent }}>{label}</Text>
      ) : null}
    </Pressable>
  );
}

/** Desktop/mobile-safe left header pair for a pushed screen. The navigation
 *  sidebar must remain reachable even while a Back action owns this slot. */
export function HeaderMenuAndBack({
  onPress,
  label,
  fallback,
}: {
  onPress?: () => void;
  label?: string;
  fallback?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <HeaderMenu />
      <HeaderBack onPress={onPress} label={label} fallback={fallback} />
    </View>
  );
}

/**
 * Header-left for a screen that is the ROOT of its own stack yet is reached
 * by a push from elsewhere — the single-run detail (`runs/[id]`), opened
 * from a Chat card or the sidebar's Recent feed. When there is history to
 * pop it shows the back chevron (return to where it was opened from);
 * opened cold from a deep link, it falls back to the drawer toggle so the
 * sidebar is still reachable. `fallback` is forwarded to `HeaderBack`.
 */
export function HeaderBackOrMenu({ fallback }: { fallback?: string }) {
  // Back when the route trail has somewhere to return to (this screen was
  // pushed from elsewhere); the drawer toggle when opened cold from a deep
  // link. Subscribes to the trail so it updates as navigation changes.
  const canBack = useNavHistory((s) => s.trail.length > 1);
  return canBack ? <HeaderMenuAndBack fallback={fallback} /> : <HeaderMenu />;
}

/** Right-side header action — the unified "create / add new / save" control. */
export function HeaderAction({
  icon = 'plus',
  label,
  onPress,
  disabled = false,
}: {
  icon?: IconName;
  label?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 11,
        paddingVertical: 6,
        marginRight: 12,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.primaryLight,
        opacity: disabled ? 0.45 : 1,
        ...NO_DRAG,
      }}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label ?? 'Create'}
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-hover-lift' } : {})}
    >
      <Feather name={icon} size={14} color={colors.accent} />
      {label ? (
        <Text style={{ fontFamily: font.sans, fontSize: 13, fontWeight: '600', color: colors.text }}>{label}</Text>
      ) : null}
    </Pressable>
  );
}

/** Icon-only header control (no-drag). Use for refresh / mode toggles /
 *  secondary actions; group several inside a `HeaderRight` row. */
export function HeaderIconButton({
  icon,
  onPress,
  active = false,
  disabled = false,
  accessibilityLabel,
}: {
  icon: IconName;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={{
        width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
        borderRadius: radius.md, borderWidth: 1,
        borderColor: active ? colors.border : 'transparent',
        backgroundColor: active ? colors.primaryLight : 'transparent',
        opacity: disabled ? 0.45 : 1,
        ...NO_DRAG,
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={accessibilityLabel}
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-side-row' } : {})}
    >
      <Feather name={icon} size={16} color={active ? colors.accent : colors.textSecondary} />
    </Pressable>
  );
}

/** Row wrapper for several header controls (keeps right padding consistent). */
export function HeaderRight({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 8 }}>
      {children}
    </View>
  );
}
