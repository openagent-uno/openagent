/**
 * Renderer ownership for shared loopbacks.
 *
 * Claims are registered before an asynchronous start begins. That makes an
 * in-flight start visible to sibling waiters: when an older same-account
 * attempt becomes stale, releasing it cannot reap the loopback reserved by a
 * newer attempt. This module deliberately has no Electron dependency so the
 * ownership rules can be exercised deterministically in unit tests.
 */
export interface LoopbackConsumerRegistry {
  claim(accountId: string, rendererId: number, attemptToken?: number): void;
  /** Returns true when the account has no consumers after the release. */
  release(accountId: string, rendererId: number, attemptToken?: number): boolean;
  /**
   * Releases every claim owned by a renderer and returns the affected
   * accounts that now have no consumers.
   */
  releaseRenderer(rendererId: number): string[];
  hasConsumers(accountId: string): boolean;
  consumerCount(accountId: string): number;
  clearAccount(accountId: string): void;
}

type ConsumerToken = number | 'session';

export function createLoopbackConsumerRegistry(): LoopbackConsumerRegistry {
  const accounts = new Map<string, Map<number, Set<ConsumerToken>>>();

  const removeEmptyAccount = (
    accountId: string,
    renderers: Map<number, Set<ConsumerToken>>,
  ): boolean => {
    if (renderers.size > 0) return false;
    accounts.delete(accountId);
    return true;
  };

  return {
    claim(accountId, rendererId, attemptToken) {
      let renderers = accounts.get(accountId);
      if (!renderers) {
        renderers = new Map();
        accounts.set(accountId, renderers);
      }
      let tokens = renderers.get(rendererId);
      if (!tokens) {
        tokens = new Set();
        renderers.set(rendererId, tokens);
      }
      tokens.add(attemptToken ?? 'session');
    },

    release(accountId, rendererId, attemptToken) {
      const renderers = accounts.get(accountId);
      if (!renderers) return true;
      if (attemptToken === undefined) {
        renderers.delete(rendererId);
      } else {
        const tokens = renderers.get(rendererId);
        tokens?.delete(attemptToken);
        if (tokens?.size === 0) renderers.delete(rendererId);
      }
      return removeEmptyAccount(accountId, renderers);
    },

    releaseRenderer(rendererId) {
      const emptied: string[] = [];
      for (const [accountId, renderers] of accounts) {
        if (!renderers.delete(rendererId)) continue;
        if (removeEmptyAccount(accountId, renderers)) emptied.push(accountId);
      }
      return emptied;
    },

    hasConsumers(accountId) {
      return (accounts.get(accountId)?.size ?? 0) > 0;
    },

    consumerCount(accountId) {
      const renderers = accounts.get(accountId);
      if (!renderers) return 0;
      let count = 0;
      for (const tokens of renderers.values()) count += tokens.size;
      return count;
    },

    clearAccount(accountId) {
      accounts.delete(accountId);
    },
  };
}
