import type { ActivityItem, ActivityKind } from './unified-history';

// Keep the wire order stable for request fingerprints. This mirrors the
// frozen ACTIVITY_KINDS contract without a runtime import, so the repository's
// zero-build node test runner can execute this policy module directly.
const ORDERED_ACTIVITY_KINDS: readonly ActivityKind[] = [
  'chat', 'delegated_session', 'workflow_run', 'scheduled_run', 'event_delivery',
];

/** The sidebar filters are presentation names; the gateway accepts canonical
 * activity kinds. Delegated sessions are intentionally absent: they navigate
 * from their parent transcript and would consume page slots without ever
 * rendering a top-level row. Global search pages them independently. */
export interface HistoryFeedFilters {
  chat: boolean;
  workflow: boolean;
  task: boolean;
  event: boolean;
}

/** Ten gateway pages is enough for fast local navigation without letting a
 * long-lived renderer retain an unbounded account history. Older activity is
 * still reachable through the independently paged global search endpoint. */
export const MAX_RETAINED_HISTORY_ITEMS = 600;
export const MAX_RETAINED_SEARCH_RESULTS = 400;

export function historyKindsForFilters(filters: HistoryFeedFilters): ActivityKind[] {
  const kinds: ActivityKind[] = [];
  if (filters.chat) kinds.push('chat');
  if (filters.workflow) kinds.push('workflow_run');
  if (filters.task) kinds.push('scheduled_run');
  if (filters.event) kinds.push('event_delivery');
  return kinds;
}

const HIDDEN_CHILD_ACTIVITY_ORIGINS = new Set([
  'delegation', 'scheduler', 'workflow', 'event',
]);

/**
 * Only first-class roots belong in the flat Recent feed. Child sessions stay
 * searchable and navigable from their parent/run screen, but must not consume
 * a second top-level row. The origin/parent guards protect mixed-version data
 * where a delegated session may temporarily arrive with kind="chat".
 */
export function isTopLevelSidebarActivity(item: ActivityItem): boolean {
  if (item.kind === 'delegated_session') return false;
  if (item.kind !== 'chat') return true;
  if (item.origin && HIDDEN_CHILD_ACTIVITY_ORIGINS.has(item.origin)) return false;
  return item.parent?.kind !== 'session';
}

/**
 * A run row represents the scheduled task, workflow, or event that fired.
 * The activity title identifies the individual firing (for example,
 * "Scheduled run ab12…"), while the parent title is the stable name users
 * recognise in navigation. Keep chats on their own title and fall back to the
 * activity title for mixed-version servers that do not include parent names.
 */
export function sidebarActivityTitle(item: ActivityItem): string {
  if (
    item.kind === 'workflow_run'
    || item.kind === 'scheduled_run'
    || item.kind === 'event_delivery'
  ) {
    const parentTitle = item.parent?.title?.trim();
    if (parentTitle && parentTitle !== item.parent?.id) return parentTitle;
  }
  return item.title;
}

export interface LocalHistorySession {
  id: string;
  origin?: string;
  parentSessionId?: string;
}

/**
 * History v2 is durable by design, so a brand-new turn does not necessarily
 * have a row there until its first run is committed. The client store is the
 * authority for that short live window. Return top-level local sessions that
 * are not represented by the current history page, so Recent keeps the active
 * conversation reachable while its assistant reply is still streaming.
 *
 * The overlay is deliberately identity-only: the Sidebar reads presentation
 * state (title, processing dot, timestamp) from the live ChatSession itself.
 */
export function localSessionIdsMissingFromHistory(
  sessions: readonly LocalHistorySession[],
  history: readonly ActivityItem[],
): string[] {
  const durableIds = new Set<string>();
  for (const item of history) {
    if (item.kind !== 'chat' && item.kind !== 'delegated_session') continue;
    const sessionId = item.session_id || item.resource_id;
    if (sessionId) durableIds.add(sessionId);
  }

  return sessions
    .filter((session) => {
      if (durableIds.has(session.id)) return false;
      if (session.parentSessionId) return false;
      return !session.origin || !HIDDEN_CHILD_ACTIVITY_ORIGINS.has(session.origin);
    })
    .map((session) => session.id);
}

export function normalizeHistoryKinds(kinds: readonly ActivityKind[]): ActivityKind[] {
  const selected = new Set(kinds);
  return ORDERED_ACTIVITY_KINDS.filter((kind) => selected.has(kind));
}

export function historyKindsKey(kinds: readonly ActivityKind[]): string {
  return normalizeHistoryKinds(kinds).join(',');
}

export function historyCoversAllKinds(kinds: readonly ActivityKind[]): boolean {
  return historyKindsKey(kinds) === ORDERED_ACTIVITY_KINDS.join(',');
}

/** A response may only mutate the store that issued it. Account switches,
 * reconnect refreshes and filter changes all advance the generation/key. */
export function historyRequestKey(
  accountId: string | null,
  kinds: readonly ActivityKind[],
  generation: number,
): string {
  return `${accountId ?? ''}|${historyKindsKey(kinds)}|${generation}`;
}

export function mergeBoundedHistory(
  previous: readonly ActivityItem[],
  incoming: readonly ActivityItem[],
  reset: boolean,
  maxItems = MAX_RETAINED_HISTORY_ITEMS,
): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  if (!reset) {
    for (const item of previous) byId.set(item.id, item);
  }
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    .slice(0, Math.max(0, maxItems));
}

/** V2 owns session discovery. Legacy servers still need the old flat list. */
export function sessionDiscoveryStrategy(historyVersion?: number): 'history_page' | 'legacy_sessions' {
  return historyVersion === 2 ? 'history_page' : 'legacy_sessions';
}
