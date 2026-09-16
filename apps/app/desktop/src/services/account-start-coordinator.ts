/**
 * Per-account single-flight coordinator.
 *
 * Only the caller that creates a flight executes `onOwnerSuccess`. Waiters
 * receive the same result without being allowed to persist their own input.
 * This matters for credentials: a concurrent waiter may carry a different
 * password that was never used by the successful authentication attempt.
 */
export interface AccountStartCoordinator<T> {
  run(
    accountId: string,
    start: () => Promise<T>,
    onOwnerSuccess: (result: T) => void | Promise<void>,
  ): Promise<T>;
}

export function createAccountStartCoordinator<T>(): AccountStartCoordinator<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(accountId, start, onOwnerSuccess) {
      const existing = inFlight.get(accountId);
      if (existing) return existing;

      const owned = (async () => {
        const result = await start();
        await onOwnerSuccess(result);
        return result;
      })();
      inFlight.set(accountId, owned);
      const cleanup = () => {
        if (inFlight.get(accountId) === owned) inFlight.delete(accountId);
      };
      void owned.then(cleanup, cleanup);
      return owned;
    },
  };
}
