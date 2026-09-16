/**
 * Bound an externally-visible wait without cancelling the underlying work.
 *
 * Loopback teardown cannot be force-cancelled safely: starting a replacement
 * iroh runtime while the old one is still shutting down can race two nodes
 * with the same identity. A deadline should therefore release the IPC caller,
 * while the original promise remains observed and the per-account lifecycle
 * barrier keeps tracking it until it really settles.
 */
export interface DeadlineScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemScheduler: DeadlineScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class OperationDeadlineError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'OperationDeadlineError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  scheduler: DeadlineScheduler = systemScheduler,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError('deadline must be a positive finite number'));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = scheduler.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new OperationDeadlineError(label, timeoutMs));
    }, timeoutMs);

    // Always observe both outcomes of the original operation. If the deadline
    // wins, a late teardown rejection must not become an unhandled rejection.
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
