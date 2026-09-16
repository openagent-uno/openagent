/**
 * In-app navigation for "detached" views.
 *
 * Editors, run history, and terminals used to open in their own desktop
 * OS window. They now render inline as ordinary pushed routes in every
 * environment — one window, one content area — so `openDetached` is just
 * a `router.push` and `closeDetached` pops the stack. The desktop
 * multi-window story is handled separately: `openNewMainWindow` opens a
 * second *full* app window that shares this one's live connection through
 * the primary window's WS relay (see desktop/src/main.ts).
 *
 * Callers pass a relative route (no leading slash, e.g. ``workflows/abc``
 * or ``tasks/runs/abc``).
 */

import { useNavHistory } from '../stores/navHistory';

type RouterLike = {
  push: (href: any) => void;
  back: () => void;
  replace: (href: any) => void;
  canGoBack?: () => boolean;
};

function desktop(): any {
  if (typeof window === 'undefined') return undefined;
  return (window as any).desktop;
}

/** Running inside the Electron desktop shell. */
export function isDesktop(): boolean {
  return desktop()?.isDesktop === true;
}

/** A secondary desktop window that relays its WS through the primary. */
export function isDesktopChild(): boolean {
  return desktop()?.isChild === true;
}

/**
 * Navigate to ``route`` inline (a pushed full-screen route). ``route`` is
 * relative with no leading slash — e.g. ``workflows/abc``, ``tasks/new``,
 * ``tasks/runs/abc``.
 */
export function openDetached(router: RouterLike, route: string): void {
  const normalized = route.replace(/^\/+/, '');
  router.push(`/${normalized}` as any);
}

/**
 * Go back one step in the app's navigation history — the single, unified
 * "back" primitive for every screen (sub-screen back chevrons, editor
 * dismissals, run/terminal close, chat child-session exit).
 *
 * It pops expo-router's history (``router.back()``), which — unlike
 * react-navigation's per-navigator ``goBack()`` / ``StackActions.popTo`` —
 * composes across the Drawer's section stacks: a run opened from a Chat
 * card returns to that chat, a note opened from the vault returns to the
 * graph, etc. Forward navigation everywhere is ``router.push``, so this
 * mirror is always correct.
 *
 * When there is nothing to pop (a deep-linked tab opened cold), it
 * ``replace``s to ``fallback`` instead of bubbling up to ``/`` (the login
 * screen), which would look like a logout. The default fallback is the
 * chat tab; editors/run-history pass their own section root so a cold
 * deep-link lands on the natural parent (e.g. the Workflows list) rather
 * than chat.
 */
export function goBack(router: RouterLike, fallback: string = '/(tabs)/chat'): void {
  // Drive back from the explicit route trail (deterministic across the
  // Drawer's section stacks) rather than react-navigation's GO_BACK, which
  // bubbles to the wrong section here. See stores/navHistory.
  useNavHistory.getState().back(router, fallback);
}

/** @deprecated Use {@link goBack}. Kept as a name-compatible alias. */
export function closeDetached(router: RouterLike, fallback?: string): void {
  goBack(router, fallback);
}

/**
 * Desktop only: open another full app window. It loads the app shell with
 * the ``child`` marker so the connection store tunnels its WebSocket
 * through the primary window's live socket (shared connection) rather than
 * opening a second one. A no-op on web / native, where there is one window.
 */
export function openNewMainWindow(): void {
  const d = desktop();
  if (d?.isDesktop && typeof d.openWindow === 'function') {
    void d.openWindow('chat');
  }
}
