/**
 * Which conversation Chat should show when its route and the chat store
 * disagree.
 *
 * Chat reads ``?session=<id>`` from its route so a deep link (or returning
 * from Settings) reaches the right conversation. Expo Router can keep the
 * previous query parameters when a Drawer replaces an already-focused Chat
 * route, so after an in-app selection the route may still name an older
 * conversation (often an empty "New Chat" draft). Re-applying that stale
 * parameter when Chat mounts again would replace the conversation the user
 * just chose with the old one.
 *
 * In-app selections (sidebar rows, "New session") therefore also record an
 * explicit destination in the store. A pending destination always wins; the
 * route value present when it is consumed is remembered as stale, so the same
 * leftover parameter is never applied later. A route value that differs from
 * the stale one is a genuine deep link and is applied.
 */

export interface ChatRouteSessionInput {
  /** ``?session=`` from the route, if any. */
  routeSession: string | undefined;
  /** The route value this Chat instance has already applied. */
  appliedRouteSession: string | null;
  /** Pending in-app destination from the store, if any. */
  destination: string | null;
  /** Route value consumed together with the last destination. */
  staleRouteSession: string | null;
  /** The store's current active session. */
  activeSessionId: string | null;
}

export interface ChatRouteSessionDecision {
  /** Session to activate, or null to leave the store as it is. */
  activate: string | null;
  /** New value for the instance's applied-route marker. */
  appliedRouteSession: string | null;
  /** True when the pending destination was consumed by this decision. */
  consumeDestination: boolean;
  /** New stale route value to store (unchanged unless a destination was consumed). */
  staleRouteSession: string | null;
}

export function resolveChatRouteSession(input: ChatRouteSessionInput): ChatRouteSessionDecision {
  const route = input.routeSession ?? null;
  if (input.destination) {
    return {
      activate: input.destination !== input.activeSessionId ? input.destination : null,
      appliedRouteSession: route,
      consumeDestination: true,
      staleRouteSession: route,
    };
  }
  const unchanged = {
    activate: null,
    appliedRouteSession: route,
    consumeDestination: false,
    staleRouteSession: input.staleRouteSession,
  };
  if (!route) return { ...unchanged, appliedRouteSession: null };
  if (input.appliedRouteSession === route) return unchanged;
  if (route === input.staleRouteSession) return unchanged;
  if (route === input.activeSessionId) return unchanged;
  return { ...unchanged, activate: route };
}
