import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  LayoutAnimation,
  Platform,
  type View,
} from 'react-native';
import { DRAWER_MOTION_DURATION_MS } from '../../common/drawer-motion';

const DRAWER_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

function initialReducedMotion(): boolean {
  return Platform.OS === 'web'
    && typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Reactive OS/browser reduced-motion preference, with a synchronous web seed. */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);

  useEffect(() => {
    if (
      Platform.OS === 'web'
      && typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
    ) {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
      setReducedMotion(query.matches);
      query.addEventListener?.('change', update);
      return () => query.removeEventListener?.('change', update);
    }

    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReducedMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReducedMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reducedMotion;
}

/** Keep expensive drawer content mounted just long enough to finish closing. */
export function useRetainedPresence(visible: boolean, durationMs: number): boolean {
  const [retained, setRetained] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRetained(true);
      return undefined;
    }
    if (durationMs <= 0) {
      setRetained(false);
      return undefined;
    }
    const timer = setTimeout(() => setRetained(false), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, visible]);

  return visible || retained;
}

/** RN Web filters the DOM `inert` prop, so apply it through the host ref. */
export function useWebInert(inert: boolean) {
  const ref = useRef<View>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = ref.current as unknown as HTMLElement | null;
    if (inert) element?.setAttribute('inert', '');
    else element?.removeAttribute('inert');
  }, [inert]);

  return ref;
}

/** CSS-only on web: React does not re-render the chat on every width frame. */
export function webDrawerWidthTransition(durationMs: number): Record<string, string> | undefined {
  if (Platform.OS !== 'web') return undefined;
  return {
    transitionProperty: 'width',
    transitionDuration: `${durationMs}ms`,
    transitionTimingFunction: DRAWER_EASING,
    willChange: durationMs > 0 ? 'width' : 'auto',
  };
}

/** Native wide layouts use the platform layout animator; phones already slide. */
export function configureNextDrawerLayout(reducedMotion: boolean): void {
  if (Platform.OS === 'web' || reducedMotion) return;
  LayoutAnimation.configureNext({
    duration: DRAWER_MOTION_DURATION_MS,
    create: {
      type: LayoutAnimation.Types.easeInEaseOut,
      property: LayoutAnimation.Properties.opacity,
    },
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: {
      type: LayoutAnimation.Types.easeInEaseOut,
      property: LayoutAnimation.Properties.opacity,
    },
  });
}
