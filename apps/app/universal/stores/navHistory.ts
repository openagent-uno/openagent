/**
 * Explicit app navigation history (a route "trail").
 *
 * react-navigation's back — whether dispatched via expo-router `router.back()`
 * or `navigation.goBack()` — is unreliable in this app's nested
 * Drawer > per-section-Stack tree: a target-less GO_BACK is consumed by the
 * deepest focused stack and, when that stack can't pop (single-screen run
 * sections, or stacks expo-router rebuilds from the URL without their index),
 * it bubbles into the Drawer and jumps to the first/previous *section* rather
 * than the screen the user actually came from. Tuning `backBehavior` /
 * `initialRouteName` only papers over parts of it.
 *
 * So instead of trusting the navigator, we record where the user has been and
 * drive "back" ourselves: `record()` appends the current route to a trail on
 * every navigation, and `back()` pops the trail and `router.replace()`s to the
 * exact previous route. This composes across sections, stacks, and run
 * screens deterministically — back always returns to the literal previous
 * screen, to any depth.
 *
 * Chat *sessions* are deliberately NOT distinguished in the trail (every
 * ``/chat?session=…`` collapses to a single ``/chat`` entry): session lineage
 * (parent ↔ child ↔ grandchild) is its own semantic axis, handled in the chat
 * screen via each session's ``parentSessionId``, and must not interleave with
 * the route trail. Opening a run from a chat card keeps the chat's active
 * session untouched, so a route-`back()` to ``/chat`` lands on the same
 * session the user launched from.
 */

import { create } from 'zustand';

type RouterLike = { replace: (href: any) => void };

/** Normalize a full href (path + optional ?query) to its trail identity. */
export function trailHref(href: string): string {
  const qIdx = href.indexOf('?');
  let path = qIdx === -1 ? href : href.slice(0, qIdx);
  const search = qIdx === -1 ? '' : href.slice(qIdx); // keeps the leading '?'
  // Strip route groups like ``(tabs)`` so a router href (``/(tabs)/chat``) and
  // the global href the recorder reads (``/chat``) normalize identically —
  // otherwise a fallback seeded as ``/(tabs)/chat`` never dedupes against the
  // recorded ``/chat`` and leaves a phantom back chevron.
  path = path.replace(/\/\([^)]+\)/g, '');
  // Fold expo-router's internal ResponsiveSidebar anchor (``/chat/__main__``,
  // which can surface for the inner drawer) onto the bare chat route — but
  // KEEP the ``?session=`` query, so each chat session is its own distinct
  // back target (a sub-agent opened from a run returns to the run; an in-chat
  // child returns to its parent session — the trail drives both uniformly).
  if (path === '/chat/__main__') path = '/chat';
  return path + search;
}

// Set right before our own `back()` triggers a navigation, so the resulting
// `record()` for the destination is recognised as a pop, not a new push.
let suppressNext = false;

interface NavHistoryState {
  trail: string[];
  /** Append the current route (called by the recorder on every nav change). */
  record: (href: string) => void;
  /** Pop one level and navigate to the previous route (or `fallback`). */
  back: (router: RouterLike, fallback?: string) => void;
}

export const useNavHistory = create<NavHistoryState>((set, get) => ({
  trail: [],
  record: (href) => {
    // Our own back() navigations are flagged so they don't re-grow the trail.
    if (suppressNext) { suppressNext = false; return; }
    const { trail } = get();
    if (trail[trail.length - 1] === href) return; // dedupe the current route
    // Every other route change is a forward move → append. (We deliberately do
    // NOT try to detect a "back to the previous entry" by value: a genuine
    // forward navigation to a route that happens to equal trail[-2] — e.g.
    // opening a run again after visiting it earlier — would be misread as a
    // back and corrupt the trail. back() is the only thing that pops.)
    const next = [...trail, href];
    // Cap so bouncing between tabs over a long session can't grow unbounded;
    // dropping the oldest never affects the reachable recent back path.
    if (next.length > 100) next.shift();
    set({ trail: next });
  },
  back: (router, fallback = '/(tabs)/chat') => {
    const { trail } = get();
    if (trail.length > 1) {
      // ``prev`` is always != the current top (record() dedupes consecutive
      // duplicates), so this replace ALWAYS changes the route → the resulting
      // record() consumes the flag. No no-op leak in this branch.
      const prev = trail[trail.length - 2];
      suppressNext = true;
      set({ trail: trail.slice(0, -1) });
      router.replace(prev as any);
    } else {
      // Cold-load / nothing to pop. Seed the trail with the NORMALIZED fallback
      // identity (so it equals what the recorder will store — no phantom back
      // chevron on the home/section-root) and do NOT arm suppressNext: the
      // replace may be a no-op (already on the fallback), and a dangling flag
      // would swallow the next real forward navigation. If the replace does
      // navigate, record() simply dedupes against this seed.
      set({ trail: [trailHref(fallback)] });
      router.replace(fallback as any);
    }
  },
}));
