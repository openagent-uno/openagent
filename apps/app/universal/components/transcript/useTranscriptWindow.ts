/**
 * Bidirectional infinite scroll for the session transcript.
 *
 * Renders a bounded window of rows inside one contiguous loaded segment and
 * slides it as the reader approaches either edge: first by revealing rows the
 * store already holds, then by fetching the neighbouring canonical page. The
 * window never exceeds ``MAX_ROWS`` — growing it on one side trims the far
 * side — so a session with thousands of messages keeps a constant DOM size.
 *
 * Changes above the viewport (revealing older rows, trimming the top) keep
 * the reading position stable: on web a row element visible before the
 * change is re-measured after it and the scroll offset corrected; native
 * applies the content-height delta.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Platform, type ScrollView } from 'react-native';
import type { ChatMessage } from '../../../common/types';
import {
  canonicalRowId,
  edgeOf,
  hasHistoryBefore,
  ordinalRowAtOrAfter,
  ordinalRowAtOrBefore,
  resolveWindow,
  segmentBounds,
  transcriptGaps,
  type LoadedRange,
  type WindowState,
} from '../../../common/transcript-window';
import type { TranscriptController } from './TranscriptController';

/** Rows in the default tail window. */
export const WINDOW_ROWS = 60;
/** Rows revealed per step at either edge. */
const STEP_ROWS = 40;
/** Hard cap on rendered rows. */
const MAX_ROWS = 160;
/** Rows kept above a jump target for context. */
const JUMP_CONTEXT_ROWS = 8;
/** Back-off after a failed page request before trying the same edge again. */
const RETRY_MS = 4000;
const FLASH_MS = 1800;

type Loader = (messageId: string, direction: 'before' | 'after' | 'around') => Promise<void>;

interface Options {
  sessionId?: string;
  rows: readonly ChatMessage[];
  ranges?: readonly LoadedRange[];
  /** Used when no range metadata exists (first page before ranges). */
  hasMoreBeforeFallback?: boolean;
  controller: TranscriptController;
  scrollRef: RefObject<ScrollView | null>;
  loadPage: Loader;
}

interface WebAnchor {
  element: HTMLElement;
  /** Position inside the scrolled content (independent of scrollTop). */
  contentTop: number;
}

function contentTopOf(node: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
}

function scrollNode(scrollRef: RefObject<ScrollView | null>): HTMLElement | null {
  if (Platform.OS !== 'web') return null;
  const ref = scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement } | null;
  return ref?.getScrollableNode?.() ?? null;
}

export function useTranscriptWindow({
  sessionId, rows, ranges, hasMoreBeforeFallback, controller, scrollRef, loadPage,
}: Options) {
  const [stored, setStored] = useState<{ sessionId?: string } & WindowState>({ sessionId, start: null, end: null });
  const state: WindowState = stored.sessionId === sessionId ? stored : { start: null, end: null };
  const setWindow = useCallback((next: WindowState) => setStored({ sessionId, ...next }), [sessionId]);

  const gaps = useMemo(() => transcriptGaps(rows, ranges), [rows, ranges]);
  const win = resolveWindow(rows, gaps, state, WINDOW_ROWS);
  const visible = useMemo(
    () => (win.start === 0 && win.end === rows.length - 1 ? rows : rows.slice(win.start, win.end + 1)),
    [rows, win.start, win.end],
  );
  const moreBefore = win.segmentStart > 0 || hasHistoryBefore(rows, ranges, hasMoreBeforeFallback);

  const latest = useRef({ rows, gaps, win, state, moreBefore, sessionId });
  latest.current = { rows, gaps, win, state, moreBefore, sessionId };
  controller.followsTail = win.followsTail;

  const turnRefs = useRef(new Map<string, unknown>());
  const registerTurn = useCallback((id: string, node: unknown) => {
    if (node) turnRefs.current.set(id, node);
    else turnRefs.current.delete(id);
  }, []);

  const [flashId, setFlashId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ id: string; nonce: number } | null>(null);
  const pendingJump = useRef<string | null>(null);
  const webAnchor = useRef<WebAnchor | null>(null);
  const nativeAnchor = useRef<{ content: number; offset: number } | null>(null);
  const adjusting = useRef(false);
  const guardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(new Map<string, number>());
  const inflight = useRef(new Set<string>());
  const loads = useRef(0);

  /** Remember what the reader sees before the window changes above it. */
  const captureAnchor = useCallback(() => {
    adjusting.current = true;
    // Never leave the guard stuck when a change produces no visible commit.
    if (guardTimer.current) clearTimeout(guardTimer.current);
    guardTimer.current = setTimeout(() => {
      guardTimer.current = null;
      adjusting.current = false;
      nativeAnchor.current = null;
      const stale = scrollNode(scrollRef);
      if (stale) stale.style.overflowAnchor = '';
    }, 600);
    const node = scrollNode(scrollRef);
    if (!node) {
      nativeAnchor.current = { content: controller.metrics.content, offset: controller.metrics.offset };
      return;
    }
    const top = node.getBoundingClientRect().top + controller.topInset;
    for (const element of Array.from(node.querySelectorAll<HTMLElement>('[data-oa-row]'))) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > top) {
        webAnchor.current = { element, contentTop: contentTopOf(node, element) };
        break;
      }
    }
    // The browser's own scroll anchoring would correct the same shift a
    // second time; it is off only while this change lands.
    node.style.overflowAnchor = 'none';
  }, [controller, scrollRef]);

  const fetchPage = useCallback((index: number, direction: 'before' | 'after') => {
    const { rows: current } = latest.current;
    const row = current[index];
    if (!row) return;
    const id = canonicalRowId(row.id);
    const key = `${direction}:${id}`;
    if (inflight.current.has(key) || Date.now() - (failures.current.get(key) ?? 0) < RETRY_MS) return;
    inflight.current.add(key);
    loads.current += 1;
    controller.setLoading(direction);
    loadPage(id, direction)
      .catch(() => { failures.current.set(key, Date.now()); })
      .finally(() => {
        inflight.current.delete(key);
        loads.current -= 1;
        if (!loads.current) controller.setLoading(null);
      });
  }, [controller, loadPage]);

  const evaluate = useCallback(() => {
    if (adjusting.current) return;
    const { rows: current, win: w, state: s, moreBefore: before } = latest.current;
    const metrics = controller.metrics;
    if (!metrics.viewport || !current.length) return;
    const threshold = Math.max(600, metrics.viewport * 1.2);
    const nearTop = metrics.offset < threshold;
    const nearBottom = metrics.content - metrics.offset - metrics.viewport < threshold;

    if (nearTop) {
      if (w.start > w.segmentStart) {
        const start = Math.max(w.segmentStart, w.start - STEP_ROWS);
        const overflow = w.end - start + 1 > MAX_ROWS;
        // A short transcript followed live must not detach from its tail.
        if (!(overflow && w.followsTail && controller.pinned)) {
          captureAnchor();
          setWindow({ start: edgeOf(current, start), end: overflow ? edgeOf(current, start + MAX_ROWS - 1) : s.end });
          return;
        }
      } else if (before) {
        const anchor = ordinalRowAtOrAfter(current, w.segmentStart, w.segmentEnd);
        if (anchor >= 0) fetchPage(anchor, 'before');
      }
    }

    if (nearBottom && !w.followsTail) {
      if (w.end < w.segmentEnd) {
        const end = Math.min(w.segmentEnd, w.end + STEP_ROWS);
        const endEdge = end === current.length - 1 ? null : edgeOf(current, end);
        let startEdge = s.start ?? edgeOf(current, w.start);
        if (end - w.start + 1 > MAX_ROWS) {
          captureAnchor();
          startEdge = edgeOf(current, end - MAX_ROWS + 1);
        }
        setWindow({ start: startEdge, end: endEdge });
        return;
      }
      if (w.segmentEnd < current.length - 1) {
        const anchor = ordinalRowAtOrBefore(current, w.segmentEnd, w.segmentStart);
        if (anchor >= 0) fetchPage(anchor, 'after');
      } else {
        setWindow({ start: s.start, end: null });
      }
      return;
    }

    // Following the live tail: keep the window bounded as new turns stream in.
    if (w.followsTail && controller.pinned && w.end - w.start + 1 > MAX_ROWS) {
      setWindow({ start: edgeOf(current, w.end - (MAX_ROWS - STEP_ROWS) + 1), end: null });
    }
  }, [captureAnchor, controller, fetchPage, setWindow]);

  const trackActiveTurn = useCallback(() => {
    const node = scrollNode(scrollRef);
    if (!node) return;
    const { rows: current, win: w } = latest.current;
    const line = node.getBoundingClientRect().top + controller.topInset + controller.metrics.viewport * 0.3;
    let best: { id: string; top: number } | null = null;
    for (const [id, element] of turnRefs.current) {
      const top = (element as HTMLElement).getBoundingClientRect?.().top;
      if (top == null || top > line) continue;
      if (!best || top > best.top) best = { id, top };
    }
    if (!best) {
      // No rendered prompt above the reading line: the current turn is the
      // last prompt before the rendered window, if the window holds it.
      for (let i = w.start - 1; i >= 0; i -= 1) {
        const row = current[i];
        if (row.role === 'user' && row.author?.kind !== 'agent') { best = { id: row.id, top: 0 }; break; }
      }
    }
    if (!best) {
      for (let i = w.start; i <= w.end; i += 1) {
        const row = current[i];
        if (row?.role === 'user' && row.author?.kind !== 'agent') { best = { id: row.id, top: 0 }; break; }
      }
    }
    controller.setActiveTurn(best?.id ?? null);
  }, [controller, scrollRef]);

  const frame = useRef<number | null>(null);
  const scheduleTrack = useCallback(() => {
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      trackActiveTurn();
    });
  }, [trackActiveTurn]);

  /** Put a row inside the window (e.g. a search anchor) without moving the
   * scroll position; the caller scrolls it into view. */
  const reveal = useCallback((messageId: string) => {
    const { rows: current, gaps: g, win: w } = latest.current;
    const index = current.findIndex((row) => row.id === messageId);
    if (index < 0 || (index >= w.start && index <= w.end)) return;
    controller.onDetach?.();
    const [segmentStart, segmentEnd] = segmentBounds(g, index);
    const start = Math.max(segmentStart, index - WINDOW_ROWS / 2);
    const end = Math.min(segmentEnd, index + WINDOW_ROWS / 2);
    setWindow({
      start: edgeOf(current, start),
      end: end === current.length - 1 ? null : edgeOf(current, end),
    });
  }, [controller, setWindow]);

  const doJump = useCallback((index: number) => {
    const { rows: current, gaps: g } = latest.current;
    const [segmentStart, segmentEnd] = segmentBounds(g, index);
    const start = Math.max(segmentStart, index - JUMP_CONTEXT_ROWS);
    const end = Math.min(segmentEnd, index + WINDOW_ROWS);
    setWindow({
      start: edgeOf(current, start),
      end: end === current.length - 1 ? null : edgeOf(current, end),
    });
    const id = current[index].id;
    setJump({ id, nonce: Date.now() });
    setFlashId(id);
  }, [setWindow]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  // Attach the handle to the screen's controller.
  useEffect(() => controller.attach({
    onMetrics: (reason) => {
      if (reason === 'content' && nativeAnchor.current) {
        const anchor = nativeAnchor.current;
        if (controller.metrics.content !== anchor.content) {
          nativeAnchor.current = null;
          scrollRef.current?.scrollTo({
            y: Math.max(0, anchor.offset + controller.metrics.content - anchor.content),
            animated: false,
          });
          adjusting.current = false;
        }
        return;
      }
      evaluate();
      if (reason === 'scroll') scheduleTrack();
    },
    jumpTo: (messageId) => {
      controller.onDetach?.();
      const index = latest.current.rows.findIndex((row) => row.id === messageId);
      if (index >= 0) { doJump(index); return; }
      pendingJump.current = messageId;
      loads.current += 1;
      controller.setLoading('around');
      loadPage(messageId, 'around')
        .catch(() => { if (pendingJump.current === messageId) pendingJump.current = null; })
        .finally(() => {
          loads.current -= 1;
          if (!loads.current) controller.setLoading(null);
        });
    },
    resetToTail: () => {
      pendingJump.current = null;
      setWindow({ start: null, end: null });
    },
  }), [controller, doJump, evaluate, loadPage, scheduleTrack, scrollRef, setWindow]);

  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    if (guardTimer.current) clearTimeout(guardTimer.current);
  }, []);

  // Fix the default window's first row once resolved: appended rows then
  // grow the window at the bottom instead of sliding it (which removed a row
  // above the reader for every new message), and it is trimmed in batches.
  useLayoutEffect(() => {
    if (state.start || !rows.length || win.end < win.start) return;
    setStored({ sessionId, start: edgeOf(rows, win.start), end: state.end });
  }, [state.start, state.end, rows, win.start, win.end, sessionId]);

  // A jump target that had to be fetched first.
  useEffect(() => {
    const target = pendingJump.current;
    if (!target) return;
    const index = rows.findIndex((row) => row.id === target);
    if (index < 0) return;
    pendingJump.current = null;
    doJump(index);
  }, [rows, doJump]);

  // Correct the scroll position after a change above the viewport, then
  // scroll a jump target into view, then look at the edges again.
  useLayoutEffect(() => {
    const node = scrollNode(scrollRef);
    const anchor = webAnchor.current;
    if (node && anchor) {
      webAnchor.current = null;
      // Shift by how far the row moved inside the content, so any scroll
      // that happened in between (e.g. following the tail) is preserved.
      if (anchor.element.isConnected) {
        const delta = contentTopOf(node, anchor.element) - anchor.contentTop;
        if (delta) node.scrollTop += delta;
      }
    }
    if (jump) {
      const element = turnRefs.current.get(jump.id);
      if (element && node) {
        const rect = (element as HTMLElement).getBoundingClientRect();
        node.scrollTop += rect.top - (node.getBoundingClientRect().top + controller.topInset + 12);
        setJump(null);
      } else if (element && !node) {
        const content = (scrollRef.current as unknown as { getInnerViewRef?: () => unknown } | null)
          ?.getInnerViewRef?.();
        (element as { measureLayout?: (rel: unknown, ok: (x: number, y: number) => void, fail: () => void) => void })
          .measureLayout?.(content, (_x, y) => {
            scrollRef.current?.scrollTo({ y: Math.max(0, y - controller.topInset - 12), animated: false });
          }, () => {});
        setJump(null);
      } else if (!pendingJump.current) {
        setJump(null);
      }
    }
    if (node && adjusting.current && !nativeAnchor.current) {
      const frameId = requestAnimationFrame(() => {
        node.style.overflowAnchor = '';
        adjusting.current = false;
        if (guardTimer.current) { clearTimeout(guardTimer.current); guardTimer.current = null; }
        controller.update({
          offset: node.scrollTop, content: node.scrollHeight, viewport: node.clientHeight,
        }, 'scroll');
      });
      return () => {
        cancelAnimationFrame(frameId);
        node.style.overflowAnchor = '';
        adjusting.current = false;
      };
    }
    return undefined;
  }, [visible, jump, controller, scrollRef]);

  // Rows arriving from the store (a fetched page, a reconcile) can leave the
  // reader at an edge without any further scroll event.
  useEffect(() => {
    const timer = setTimeout(evaluate, 0);
    return () => clearTimeout(timer);
  }, [rows, ranges, evaluate]);

  return { visible, start: win.start, registerTurn, flashId, reveal };
}
