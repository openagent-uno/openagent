/** Renderer-local latest-attempt gate for async connection work. */
export interface LatestAttemptLease<TTarget> {
  readonly token: number;
  readonly target: TTarget;
  isCurrent(): boolean;
  settle<TResult>(
    onCurrent: () => TResult | Promise<TResult>,
    onStale: () => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

export interface LatestAttemptGate<TTarget> {
  begin(target: TTarget): LatestAttemptLease<TTarget>;
  invalidate(): void;
  currentTarget(): TTarget | undefined;
}

/**
 * Creates an isolated gate. Callers intentionally instantiate this inside a
 * Zustand store/renderer, not in Electron main, so independent windows can
 * connect concurrently while only the latest attempt in one UI may commit.
 */
export function createLatestAttemptGate<TTarget>(): LatestAttemptGate<TTarget> {
  let latestToken = 0;
  let target: TTarget | undefined;

  return {
    begin(nextTarget) {
      const token = ++latestToken;
      target = nextTarget;
      const isCurrent = () => token === latestToken;
      return {
        token,
        target: nextTarget,
        isCurrent,
        async settle(onCurrent, onStale) {
          return isCurrent() ? onCurrent() : onStale();
        },
      };
    },
    invalidate() {
      latestToken += 1;
      target = undefined;
    },
    currentTarget() {
      return target;
    },
  };
}
