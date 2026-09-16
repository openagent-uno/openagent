/**
 * useAutoScroll — standard "stick to bottom unless user scrolls up" pattern.
 *
 * Used by chat sessions, scheduled runs, and workflow runs to keep the
 * transcript pinned to the latest content while streaming live updates.
 * When the user manually scrolls away from the bottom, auto-scroll pauses
 * and a "jump to bottom" affordance appears. Scrolling back to the very
 * bottom re-engages auto-scroll.
 *
 * This is the same pattern used by Claude Code, VS Code terminal, Slack,
 * and virtually every chat application.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScrollView } from "react-native";

const BOTTOM_THRESHOLD = 48; // px — within this distance we consider "at bottom"
const SCROLL_THROTTLE_MS = 100;

export interface UseAutoScrollOpts {
  /**
   * Values that should trigger a scroll-to-bottom when the user is pinned.
   * Pass the message count, last message text length, status text, etc. —
   * anything that changes when the transcript grows.
   */
  trackDeps: unknown[];
  /** When true, forces auto-scroll regardless of pinned state (e.g. on first mount). */
  force?: boolean;
}

export interface UseAutoScrollResult {
  /** Attach to the ScrollView's onScroll prop. */
  onScroll: (event: any) => void;
  /** Attach to the ScrollView's onContentSizeChange prop. */
  onContentSizeChange: (w: number, h: number) => void;
  /** True when the user has scrolled away from the bottom. */
  isPinned: boolean;
  /** Programmatically scroll to the bottom and re-pin. */
  scrollToBottom: (animated?: boolean) => void;
  /** Attach to the ScrollView ref. */
  scrollRef: React.RefObject<ScrollView | null>;
}

export function useAutoScroll(opts: UseAutoScrollOpts): UseAutoScrollResult {
  const { trackDeps, force } = opts;
  const scrollRef = useRef<ScrollView>(null);
  const [isPinned, setIsPinned] = useState(true);
  // Track whether we just did a programmatic scroll-to-bottom so we don't
  // let onScroll from that same action flip isPinned to false.
  const justScrolledRef = useRef(false);
  // Keep a ref copy so the throttled onScroll callback reads the latest.
  const isPinnedRef = useRef(isPinned);
  isPinnedRef.current = isPinned;

  const scrollToBottom = useCallback((animated = true) => {
    justScrolledRef.current = true;
    setIsPinned(true);
    isPinnedRef.current = true;
    scrollRef.current?.scrollToEnd({ animated });
    // Clear the guard after the scroll animation settles (~300ms is
    // generous for RN's scrollToEnd animation on both native and web).
    setTimeout(() => {
      justScrolledRef.current = false;
    }, 350);
  }, []);

  // Track deps: auto-scroll when pinned and content changes.
  const prevDepsRef = useRef<unknown[] | undefined>(undefined);
  useEffect(() => {
    if (force) {
      scrollToBottom(false);
      return;
    }
    // Skip if the deps haven't actually changed (React's dep array
    // comparison is shallow — this guards against spurious re-renders).
    const prev = prevDepsRef.current;
    if (prev && prev.length === trackDeps.length) {
      let same = true;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== trackDeps[i]) { same = false; break; }
      }
      if (same) return;
    }
    prevDepsRef.current = trackDeps;

    if (!isPinnedRef.current) return;
    // Small delay so the layout has settled after content change.
    const id = setTimeout(() => {
      if (!isPinnedRef.current) return;
      justScrolledRef.current = true;
      scrollRef.current?.scrollToEnd({ animated: true });
      setTimeout(() => { justScrolledRef.current = false; }, 350);
    }, 50);
    return () => clearTimeout(id);
    // We intentionally track `trackDeps` via the array spread — React's
    // rules-of-hooks lint will flag this, but the manual comparison above
    // avoids unnecessary effects while still reacting to actual changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [force, ...trackDeps]);

  // Throttled onScroll handler.
  const lastScrollTime = useRef(0);
  const onScroll = useCallback((event: any) => {
    const now = Date.now();
    if (now - lastScrollTime.current < SCROLL_THROTTLE_MS) return;
    lastScrollTime.current = now;

    // Ignore scroll events triggered by our own programmatic scrollToEnd.
    if (justScrolledRef.current) return;

    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const atBottom = distanceFromBottom < BOTTOM_THRESHOLD;

    if (atBottom && !isPinnedRef.current) {
      setIsPinned(true);
      isPinnedRef.current = true;
    } else if (!atBottom && isPinnedRef.current) {
      setIsPinned(false);
      isPinnedRef.current = false;
    }
  }, []);

  // When the content size grows while pinned (e.g. streaming text causes
  // layout change without a new message), keep us at the bottom.
  const onContentSizeChange = useCallback((_w: number, _h: number) => {
    if (!isPinnedRef.current) return;
    if (justScrolledRef.current) return;
    justScrolledRef.current = true;
    scrollRef.current?.scrollToEnd({ animated: false });
    setTimeout(() => { justScrolledRef.current = false; }, 350);
  }, []);

  return {
    onScroll,
    onContentSizeChange,
    isPinned,
    scrollToBottom,
    scrollRef,
  };
}
