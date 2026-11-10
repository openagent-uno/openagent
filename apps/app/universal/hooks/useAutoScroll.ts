/** Follow transcript layout while pinned. Only scrolling up detaches the view. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from 'react-native';

const BOTTOM_THRESHOLD = 48;

interface UseAutoScrollOpts {
  trackDeps: unknown[];
}

export function useAutoScroll({ trackDeps }: UseAutoScrollOpts) {
  const scrollRef = useRef<ScrollView>(null);
  const [isPinned, setIsPinned] = useState(true);
  const pinned = useRef(true);
  const previousOffset = useRef(0);
  const frame = useRef<number | null>(null);

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
      updatePinned(true);
    } else if (movedUp) {
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

  const pauseFollowing = useCallback(() => updatePinned(false), [updatePinned]);
  const onWheel = useCallback((event: {
    deltaY: number; ctrlKey: boolean; currentTarget: { scrollTop: number };
  }) => {
    if (!event.ctrlKey && event.deltaY < 0 && event.currentTarget.scrollTop > 0) pauseFollowing();
  }, [pauseFollowing]);
  // Record an upward wheel gesture before any queued resize scroll can win.
  const scrollInteraction = Platform.OS === 'web'
    ? { onWheel } : { onScrollBeginDrag: pauseFollowing };

  return { scrollRef, isPinned, scrollToBottom, pauseFollowing, onScroll, scrollInteraction,
    onContentSizeChange: followLayout, onLayout: followLayout };
}
