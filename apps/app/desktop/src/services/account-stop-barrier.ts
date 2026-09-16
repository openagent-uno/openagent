/**
 * Per-account stop barrier.
 *
 * A loopback handle is removed before its asynchronous `stop()` finishes.
 * Starts must therefore wait for the complete stop promise, otherwise a fast
 * A→B→A switch can create a second A while the first A is still tearing down.
 */
export interface AccountStopBarrier {
  run(accountId: string, stop: () => Promise<void>): Promise<void>;
  wait(accountId: string): Promise<void>;
}

export function createAccountStopBarrier(): AccountStopBarrier {
  const stops = new Map<string, Promise<void>>();

  return {
    run(accountId, stop) {
      const previous = stops.get(accountId);
      const current = (async () => {
        if (previous) {
          try { await previous; } catch { /* a later stop still gets its turn */ }
        }
        await stop();
      })();
      stops.set(accountId, current);
      const cleanup = () => {
        if (stops.get(accountId) === current) stops.delete(accountId);
      };
      void current.then(cleanup, cleanup);
      return current;
    },

    async wait(accountId) {
      // Re-check after every await: another stop can be queued behind the one
      // we observed while this caller was suspended.
      while (true) {
        const pending = stops.get(accountId);
        if (!pending) return;
        try { await pending; } catch { /* teardown errors must not deadlock starts */ }
      }
    },
  };
}
