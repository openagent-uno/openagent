/**
 * Follow transcript layout while pinned to the bottom.
 *
 * Only the *reader* detaches the view: an upward wheel/trackpad gesture, a
 * touch drag, keyboard scrolling or dragging the scrollbar. Programmatic
 * scroll changes — the browser's scroll anchoring when rows above the
 * viewport are trimmed, the transcript window keeping its position, a
 * clamp after content shrinks — are not intent and never unpin; previously
 * each new row trimmed the top of the rendered window, the browser nudged
 * ``scrollTop`` up to compensate, and that nudge read as "scrolled up",
 * silently stopping auto-scroll for the rest of the turn.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from 'react-native';

const BOTTOM_THRESHOLD = 48;
/** How long after an input event a scroll still counts as the reader's. */
const USER_INTENT_MS = 250;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

interface UseAutoScrollOpts {
  trackDeps: unknown[];
  /** Whether reaching the bottom may re-engage following. A windowed
   *  transcript whose rendered rows do not reach the live tail returns false:
   *  its bottom edge is older history still being paged in, not the tail. */
  canPin?: () => boolean;
}

export function useAutoScroll({ trackDeps, canPin }: UseAutoScrollOpts) {
  const canPinRef = useRef(canPin);
  canPinRef.current = canPin;
  const scrollRef = useRef<ScrollView>(null);
  const [isPinned, setIsPinned] = useState(true);
  const pinned = useRef(true);
  const previousOffset = useRef(0);
  const frame = useRef<number | null>(null);
  /** Until when scroll events are attributed to the reader. */
  const userIntentUntil = useRef(0);
  /** A native drag or a web scrollbar/pointer drag is in progress. */
  const dragging = useRef(false);

  const updatePinned = useCallback((value: boolean) => {
    if (pinned.current === value) return;
    pinned.current = value;
    setIsPinned(value);
  }, []);

  const followLayout = useCallback(() => {
    if (!pinned.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pinned.current) scrollRef.current?.scrollToEnd({ animated: false });
    });
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    updatePinned(true);
    if (animated) scrollRef.current?.scrollToEnd({ animated: true });
    else followLayout();
  }, [followLayout, updatePinned]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const offset = Math.max(0, contentOffset.y);
    const movedUp = offset < previousOffset.current;
    previousOffset.current = offset;
    if (contentSize.height - offset - layoutMeasurement.height < BOTTOM_THRESHOLD) {
      if (canPinRef.current?.() ?? true) updatePinned(true);
    } else if (movedUp && (dragging.current || Date.now() < userIntentUntil.current)) {
      updatePinned(false);
    }
  }, [updatePinned]);

  // Layout callbacks drive scrolling after content/viewport resize. This
  // also covers updates which replace a row without changing total height.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(followLayout, [followLayout, ...trackDeps]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // Web: attribute scroll events to the reader only right after real input
  // inside the transcript. Listening on the document keeps this working when
  // the scroll view mounts after this hook (e.g. once a session loads).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const inside = (target: EventTarget | null) => {
      const node = (scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement } | null)
        ?.getScrollableNode?.();
      return !!node && target instanceof Node && node.contains(target);
    };
    const intent = () => { userIntentUntil.current = Date.now() + USER_INTENT_MS; };
    const pointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) return;
      dragging.current = true;
      intent();
    };
    const pointerUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      intent();
    };
    const touchMove = (event: TouchEvent) => { if (inside(event.target)) intent(); };
    const keyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && (inside(event.target) || event.target === document.body)) intent();
    };
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointerup', pointerUp, true);
    document.addEventListener('touchmove', touchMove, { capture: true, passive: true });
    document.addEventListener('keydown', keyDown, true);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('pointerup', pointerUp, true);
      document.removeEventListener('touchmove', touchMove, true);
      document.removeEventListener('keydown', keyDown, true);
    };
  }, []);

  const pauseFollowing = useCallback(() => updatePinned(false), [updatePinned]);
  const onWheel = useCallback((event: {
    deltaY: number; ctrlKey: boolean; currentTarget: { scrollTop: number };
  }) => {
    if (event.ctrlKey) return;
    userIntentUntil.current = Date.now() + USER_INTENT_MS;
    if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) pauseFollowing();
  }, [pauseFollowing]);
  // Record an upward wheel gesture before any queued resize scroll can win.
  const scrollInteraction = Platform.OS === 'web'
    ? { onWheel }
    : {
        onScrollBeginDrag: () => { dragging.current = true; pauseFollowing(); },
        onScrollEndDrag: () => {
          dragging.current = false;
          userIntentUntil.current = Date.now() + USER_INTENT_MS;
        },
        onMomentumScrollEnd: () => { userIntentUntil.current = 0; },
      };

  return { scrollRef, isPinned, scrollToBottom, pauseFollowing, onScroll, scrollInteraction,
    onContentSizeChange: followLayout, onLayout: followLayout };
}
