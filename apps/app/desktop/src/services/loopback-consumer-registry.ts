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
  hasConsumer(accountId: string, rendererId: number): boolean;
  /** Opaque lifetime of this renderer's current claim, renewed after logout. */
  consumerLifetime(accountId: string, rendererId: number): object | undefined;
  hasConsumers(accountId: string): boolean;
  consumerCount(accountId: string): number;
  clearAccount(accountId: string): void;
}

type ConsumerToken = number | 'session';
type ConsumerClaim = { tokens: Set<ConsumerToken>; lifetime: object };

export function createLoopbackConsumerRegistry(
  onReleased?: (accountId: string, rendererId: number) => void,
): LoopbackConsumerRegistry {
  const accounts = new Map<string, Map<number, ConsumerClaim>>();

  const removeEmptyAccount = (
    accountId: string,
    renderers: Map<number, ConsumerClaim>,
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
      let claim = renderers.get(rendererId);
      if (!claim) {
        claim = { tokens: new Set(), lifetime: {} };
        renderers.set(rendererId, claim);
      }
      claim.tokens.add(attemptToken ?? 'session');
    },

    release(accountId, rendererId, attemptToken) {
      const renderers = accounts.get(accountId);
      if (!renderers) return true;
      let released = false;
      if (attemptToken === undefined) {
        released = renderers.delete(rendererId);
      } else {
        const claim = renderers.get(rendererId);
        claim?.tokens.delete(attemptToken);
        if (claim?.tokens.size === 0) released = renderers.delete(rendererId);
      }
      const empty = removeEmptyAccount(accountId, renderers);
      if (released) onReleased?.(accountId, rendererId);
      return empty;
    },

    releaseRenderer(rendererId) {
      const emptied: string[] = [];
      for (const [accountId, renderers] of accounts) {
        if (!renderers.delete(rendererId)) continue;
        if (removeEmptyAccount(accountId, renderers)) emptied.push(accountId);
        onReleased?.(accountId, rendererId);
      }
      return emptied;
    },

    hasConsumer(accountId,rendererId) { return (accounts.get(accountId)?.get(rendererId)?.tokens.size ?? 0) > 0; },

    consumerLifetime(accountId, rendererId) { return accounts.get(accountId)?.get(rendererId)?.lifetime; },

    hasConsumers(accountId) {
      return (accounts.get(accountId)?.size ?? 0) > 0;
    },

    consumerCount(accountId) {
      const renderers = accounts.get(accountId);
      if (!renderers) return 0;
      let count = 0;
      for (const claim of renderers.values()) count += claim.tokens.size;
      return count;
    },

    clearAccount(accountId) {
      const renderers = accounts.get(accountId);
      accounts.delete(accountId);
      for (const rendererId of renderers?.keys() ?? []) onReleased?.(accountId, rendererId);
    },
  };
}
