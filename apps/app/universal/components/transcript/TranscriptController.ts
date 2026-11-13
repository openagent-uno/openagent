/**
 * TranscriptController — the bridge between the chat screen's ScrollView
 * (which owns scroll events) and the transcript renderer (which owns the
 * rendered window). The screen forwards scroll metrics; the renderer attaches
 * a handle that slides its window, and publishes small observable bits of
 * state (current turn, page loading) that overlays such as the turn rail can
 * subscribe to without re-rendering the whole screen.
 */
import { useSyncExternalStore } from 'react';

export interface ScrollMetrics {
  /** Distance scrolled from the top of the content. */
  offset: number;
  /** Visible height of the scroll viewport. */
  viewport: number;
  /** Total content height. */
  content: number;
}

export type TranscriptLoading = 'before' | 'after' | 'around' | null;

export interface TranscriptWindowHandle {
  /** Re-evaluate the window after scroll metrics changed. */
  onMetrics(reason: 'scroll' | 'content' | 'layout'): void;
  /** Bring a message into the window and scroll it into view. */
  jumpTo(messageId: string): void;
  /** Return to the default window that follows the live tail. */
  resetToTail(): void;
}

interface Observed {
  activeTurnId: string | null;
  loading: TranscriptLoading;
}

export class TranscriptController {
  metrics: ScrollMetrics = { offset: 0, viewport: 0, content: 0 };
  /** Content inset hidden behind the floating header. */
  topInset = 0;
  /** Mirrors the screen's stick-to-bottom state. */
  pinned = true;
  /** Set by the renderer: the rendered window reaches the live tail. */
  followsTail = true;
  /** Called when a programmatic jump detaches the view from the live tail. */
  onDetach: (() => void) | null = null;

  private handle: TranscriptWindowHandle | null = null;
  private observed: Observed = { activeTurnId: null, loading: null };
  private listeners = new Set<() => void>();

  attach(handle: TranscriptWindowHandle): () => void {
    this.handle = handle;
    return () => {
      if (this.handle === handle) this.handle = null;
    };
  }

  update(metrics: Partial<ScrollMetrics>, reason: 'scroll' | 'content' | 'layout'): void {
    this.metrics = { ...this.metrics, ...metrics };
    this.handle?.onMetrics(reason);
  }

  jumpTo(messageId: string): void {
    this.handle?.jumpTo(messageId);
  }

  resetToTail(): void {
    this.handle?.resetToTail();
  }

  get snapshot(): Observed {
    return this.observed;
  }

  setActiveTurn(activeTurnId: string | null): void {
    if (this.observed.activeTurnId === activeTurnId) return;
    this.observed = { ...this.observed, activeTurnId };
    this.emit();
  }

  setLoading(loading: TranscriptLoading): void {
    if (this.observed.loading === loading) return;
    this.observed = { ...this.observed, loading };
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const NO_CONTROLLER: Observed = { activeTurnId: null, loading: null };
const noopSubscribe = () => () => {};

/** Subscribe to one observed field of a controller. */
export function useTranscriptObserved<K extends keyof Observed>(
  controller: TranscriptController | null | undefined,
  key: K,
): Observed[K] {
  return useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    () => (controller ? controller.snapshot[key] : NO_CONTROLLER[key]),
    () => NO_CONTROLLER[key],
  );
}
