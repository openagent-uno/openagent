/**
 * DragRegion — the window-drag layer for the frameless Electron window.
 *
 * Drop it as the FIRST child of any header / toolbar that should drag the
 * window; the interactive controls render after it (as siblings, painted on
 * top) and must each carry `NO_DRAG`.
 *
 * Why a sibling layer rather than making the container itself `drag`:
 * `-webkit-app-region` propagates to descendants, so a `drag` container makes
 * its `no-drag` buttons *nested* no-drag regions. On macOS that leaves the
 * buttons unresponsive for the double-click interval after a
 * double-click-to-maximize (the gesture re-rasterizes the drag region). As a
 * separate fill BEHIND the buttons, the buttons are never descendants of a
 * drag region, so that freeze never happens — while the empty space and the
 * (non-interactive) title still drag, because the draggable region is computed
 * geometrically from the union of `drag` rects minus `no-drag` rects,
 * independent of paint/stacking order.
 *
 * The fill always paints `color` (so it can double as a header background on
 * every platform); the `drag` CSS is added only inside Electron, where window
 * drag regions mean anything.
 */

import { View, StyleSheet, Platform } from 'react-native';

function isElectron(): boolean {
  return typeof window !== 'undefined' && (window as any).desktop?.isDesktop === true;
}

/** Spread onto any interactive control sitting over a DragRegion. */
export const NO_DRAG: any = Platform.OS === 'web' ? { WebkitAppRegion: 'no-drag' } : null;

export default function DragRegion({ color }: { color?: string }) {
  const drag = Platform.OS === 'web' && isElectron();
  return (
    <View
      // No `pointerEvents: none` here — some Chromium builds drop the drag
      // region when the element is pointer-transparent. As the first child it
      // already paints behind the controls, so they win their own clicks while
      // the empty space falls through to this layer and drags.
      // @ts-ignore web drag region
      style={[
        StyleSheet.absoluteFill,
        color ? { backgroundColor: color } : null,
        drag ? ({ WebkitAppRegion: 'drag' } as any) : null,
      ]}
    />
  );
}
