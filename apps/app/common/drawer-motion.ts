/** Shared timing/layout policy for the two app-shell drawers. */

export const DRAWER_MOTION_DURATION_MS = 220;
export const DRAWER_CONTENT_RETENTION_BUFFER_MS = 80;
export const PHONE_DRAWER_CONTENT_RETENTION_MS = 340;

/** Permanent panes reflow the workspace; overlay drawers retain their width. */
export function resolvedDrawerWidth(
  expandedWidth: number,
  overlay: boolean,
  open: boolean,
): number {
  return overlay || open ? expandedWidth : 0;
}

/** Our desktop/tablet layout motion follows the OS reduced-motion setting. */
export function drawerMotionDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : DRAWER_MOTION_DURATION_MS;
}

/**
 * Keep content alive until its pane is fully clipped. React Navigation's
 * phone drawer owns a 300 ms transition, while wide panes use our timing.
 */
export function drawerContentRetentionDuration(
  overlay: boolean,
  reducedMotion: boolean,
): number {
  if (overlay) return PHONE_DRAWER_CONTENT_RETENTION_MS;
  const duration = drawerMotionDuration(reducedMotion);
  return duration > 0 ? duration + DRAWER_CONTENT_RETENTION_BUFFER_MS : 0;
}
