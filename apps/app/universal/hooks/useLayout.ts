/**
 * Responsive layout primitives.
 *
 * One breakpoint drives the shell: phone (<768) rides the toggleable
 * slide-in drawer; tablet+ (≥768) shows the permanent full sidebar. There
 * is no collapsed icon-density middle stage — the sidebar is always full.
 *
 * Mobile-first: every screen reads correctly on a phone; `isTablet`
 * / `isDesktop` are additive toggles for wider chrome where needed.
 */

import { useWindowDimensions } from 'react-native';

export const BREAKPOINTS = {
  /** ≥ 768px — permanent full sidebar (below this it's a drawer). */
  tablet: 768,
  /** ≥ 1024px — extra room for wider content layouts. */
  desktop: 1024,
} as const;

export interface Layout {
  width: number;
  height: number;
  /** < 768 — phone: toggleable drawer. */
  isPhone: boolean;
  /** ≥ 768 — tablet or larger: permanent full sidebar. */
  isTablet: boolean;
  /** ≥ 1024 — desktop: extra room for wider content. */
  isDesktop: boolean;
}

/** Resolve the current breakpoint state, recomputing on resize. */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return {
    width,
    height,
    isPhone: width < BREAKPOINTS.tablet,
    isTablet: width >= BREAKPOINTS.tablet,
    isDesktop: width >= BREAKPOINTS.desktop,
  };
}

/** @deprecated kept for older call-sites — true at ≥ 768. */
export function useIsWideScreen(): boolean {
  return useLayout().isTablet;
}
