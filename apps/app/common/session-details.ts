/** Pure policies shared by the session-details drawer and its node tests. */

const LIVE_RUN_STATUSES = new Set(['pending', 'queued', 'received', 'running']);

export const RUN_LIVE_POLL_MAX_ATTEMPTS = 180;
export const RUN_LIVE_POLL_MAX_DURATION_MS = 10 * 60 * 1000;
export const RUN_RELATIONS_REFRESH_EVERY_POLLS = 3;

export function isLiveRunStatus(status?: string | null): boolean {
  return !!status && LIVE_RUN_STATUSES.has(status);
}

/** Keep a visible live drawer fresh, but never leave an unbounded timer loop. */
export function shouldContinueRunPolling(
  status: string | null | undefined,
  elapsedMs: number,
  attempts: number,
): boolean {
  return isLiveRunStatus(status)
    && attempts < RUN_LIVE_POLL_MAX_ATTEMPTS
    && elapsedMs < RUN_LIVE_POLL_MAX_DURATION_MS;
}

/** Fast feedback initially, then a lower duty cycle for unusually long runs. */
export function runLivePollDelay(attempts: number): number {
  return attempts < 30 ? 2_000 : 5_000;
}

export interface RunRelationRefreshPlan {
  sourceIds: string[];
  nextRoundRobinCursor: number;
}

/**
 * Bound ancillary refreshes to a few session roots per detail poll. Newly
 * discovered roots win; once all roots have been hydrated, existing roots are
 * revisited round-robin every few polls so context/descendants/run links can
 * still advance without an N-roots request burst every two seconds.
 */
export function planRunRelationRefresh({
  sessionIds,
  hydratedSessionIds,
  roundRobinCursor,
  pollAttempt,
  sourceLimit = 2,
}: {
  sessionIds: readonly string[];
  hydratedSessionIds: ReadonlySet<string>;
  roundRobinCursor: number;
  pollAttempt: number;
  sourceLimit?: number;
}): RunRelationRefreshPlan {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  const limit = Math.max(1, Math.floor(sourceLimit));
  const discovered = ids.filter((id) => !hydratedSessionIds.has(id));
  if (discovered.length) {
    return {
      sourceIds: discovered.slice(0, limit),
      nextRoundRobinCursor: ids.length ? roundRobinCursor % ids.length : 0,
    };
  }
  if (!ids.length || pollAttempt % RUN_RELATIONS_REFRESH_EVERY_POLLS !== 0) {
    return {
      sourceIds: [],
      nextRoundRobinCursor: ids.length ? roundRobinCursor % ids.length : 0,
    };
  }

  const start = roundRobinCursor % ids.length;
  const count = Math.min(limit, ids.length);
  const sourceIds = Array.from({ length: count }, (_, offset) => (
    ids[(start + offset) % ids.length]
  ));
  return {
    sourceIds,
    nextRoundRobinCursor: (start + count) % ids.length,
  };
}

export interface SessionHierarchyMetadata {
  id: string;
  depth: number;
  lineageRedacted: boolean;
}

/** Merge duplicate descendants without flattening their hierarchy or privacy. */
export function mergeSessionHierarchyRows<T extends SessionHierarchyMetadata>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const rows = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) {
    const existing = rows.get(row.id);
    rows.set(row.id, existing
      ? {
          ...existing,
          ...row,
          depth: Math.min(existing.depth, row.depth),
          lineageRedacted: existing.lineageRedacted || row.lineageRedacted,
        }
      : row);
  }
  return [...rows.values()];
}
