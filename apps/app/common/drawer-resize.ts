/** Shared geometry policy for the two desktop app-shell drawers. */

export type ResizableDrawerKind = 'navigation' | 'session-details';
export type ResizableDrawerSide = 'left' | 'right';

export const NAVIGATION_DRAWER_DEFAULT_WIDTH = 244;
export const NAVIGATION_DRAWER_MIN_WIDTH = 220;
export const NAVIGATION_DRAWER_MAX_WIDTH = 420;

export const SESSION_DETAILS_DRAWER_DEFAULT_WIDTH = 344;
export const SESSION_DETAILS_DRAWER_MIN_WIDTH = 280;
export const SESSION_DETAILS_DRAWER_MAX_WIDTH = 640;

/** Keep enough of the workspace visible to understand what the drawer annotates. */
// At the 768 px wide-layout breakpoint the shipped 244 + 344 defaults leave
// 180 px to the workspace. Preserve that established floor so both drawers
// still have a useful resize range in narrow Electron windows.
export const MIN_WORKSPACE_WIDTH = 180;

export interface DrawerWidthBounds {
  min: number;
  max: number;
}

export interface ResponsiveDrawerWidthContext {
  /** Current width of the drawer on the opposite edge. */
  otherDrawerWidth?: number;
  /** Closed drawers do not reserve workspace. */
  otherDrawerOpen?: boolean;
}

export function hardDrawerWidthBounds(kind: ResizableDrawerKind): DrawerWidthBounds {
  return kind === 'navigation'
    ? { min: NAVIGATION_DRAWER_MIN_WIDTH, max: NAVIGATION_DRAWER_MAX_WIDTH }
    : { min: SESSION_DETAILS_DRAWER_MIN_WIDTH, max: SESSION_DETAILS_DRAWER_MAX_WIDTH };
}

/**
 * Keep the centre workspace usable while allowing the open drawer to consume
 * space released by a closed or narrowed opposite drawer. When a very small
 * wide-layout viewport cannot fit every minimum at once, the drawer minimum
 * wins and React Navigation keeps the remaining workspace.
 */
export function responsiveDrawerWidthBounds(
  kind: ResizableDrawerKind,
  viewportWidth: number,
  context: ResponsiveDrawerWidthContext = {},
): DrawerWidthBounds {
  const hard = hardDrawerWidthBounds(kind);
  const occupiedByOther = context.otherDrawerOpen
    ? Math.max(0, Number(context.otherDrawerWidth) || 0)
    : 0;
  const available = Math.floor(Math.max(
    0,
    viewportWidth - MIN_WORKSPACE_WIDTH - occupiedByOther,
  ));
  return {
    min: hard.min,
    max: Math.max(hard.min, Math.min(hard.max, available)),
  };
}

export function clampDrawerWidth(
  width: number,
  bounds: DrawerWidthBounds,
): number {
  if (!Number.isFinite(width)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/** Moving right grows a left drawer and shrinks a right drawer. */
export function resizedDrawerWidth(
  startWidth: number,
  deltaX: number,
  side: ResizableDrawerSide,
  bounds: DrawerWidthBounds,
): number {
  const direction = side === 'left' ? 1 : -1;
  return clampDrawerWidth(startWidth + deltaX * direction, bounds);
}

export function drawerKeyboardStep(
  width: number,
  key: string,
  side: ResizableDrawerSide,
  bounds: DrawerWidthBounds,
  step = 12,
): number | null {
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const deltaX = key === 'ArrowRight' ? step : -step;
  return resizedDrawerWidth(width, deltaX, side, bounds);
}
