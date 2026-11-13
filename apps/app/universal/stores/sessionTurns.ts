/**
 * Compact per-session index of human turns, backing the transcript turn rail.
 *
 * The index comes from ``GET /api/sessions/{id}/turns`` (ids, ordinals,
 * author, ``own`` flag and a bounded preview) so the rail can show every
 * prompt of a very long session without loading its transcript. Pages are
 * fetched oldest first; ``refresh`` later fetches only turns newer than the
 * last known ordinal. Gateways without the endpoint mark the session
 * ``unsupported`` and the rail falls back to the loaded transcript.
 */
import { create } from 'zustand';
import type { SessionTurn } from '../../common/unified-history';
import { ApiError, listSessionTurns } from '../services/api';
import { onSessionReadAccessChange, sessionReadGuard } from './sessionReadAccess';

const PAGE_SIZE = 1000;
/** Upper bound on indexed turns per session (memory and rail cost). */
const MAX_TURNS = 20_000;

export type TurnIndexStatus = 'loading' | 'ready' | 'error' | 'unsupported';

export interface TurnIndex {
  turns: SessionTurn[];
  status: TurnIndexStatus;
}

interface SessionTurnsState {
  bySession: Record<string, TurnIndex | undefined>;
  /** Load the full index once per session (no-op when already loaded). */
  ensure: (sessionId: string) => void;
  /** Fetch turns newer than the last indexed one. */
  refresh: (sessionId: string) => void;
  clear: () => void;
  /** Forget one session's index. */
  drop: (sessionId: string) => void;
}

const inflight = new Map<string, Promise<void>>();
const EMPTY: SessionTurn[] = [];

export const useSessionTurns = create<SessionTurnsState>((set, get) => {
  const patch = (sessionId: string, next: Partial<TurnIndex>) => set((state) => ({
    bySession: {
      ...state.bySession,
      [sessionId]: { ...(state.bySession[sessionId] ?? { turns: EMPTY, status: 'loading' }), ...next },
    },
  }));

  const load = (sessionId: string): Promise<void> => {
    const running = inflight.get(sessionId);
    if (running) return running;
    const authorized = sessionReadGuard(sessionId);
    const request = (async () => {
      let turns = get().bySession[sessionId]?.turns ?? EMPTY;
      try {
        for (;;) {
          const after = turns.at(-1)?.ordinal;
          const page = await listSessionTurns(sessionId, { afterOrdinal: after, limit: PAGE_SIZE });
          if (!authorized()) return;
          const known = new Set(turns.map((turn) => turn.message_id));
          turns = [...turns, ...page.turns.filter((turn) => !known.has(turn.message_id))];
          if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
          patch(sessionId, { turns, status: page.has_more ? 'loading' : 'ready' });
          if (!page.has_more || !page.turns.length) break;
        }
      } catch (error) {
        if (!authorized()) return;
        // A gateway without the route answers a bare 404/405; a known route
        // answers a typed problem (e.g. a session not persisted yet).
        const unsupported = error instanceof ApiError && !error.code && !turns.length
          && (error.status === 404 || error.status === 405);
        patch(sessionId, { status: unsupported ? 'unsupported' : 'error' });
      }
    })().finally(() => {
      if (inflight.get(sessionId) === request) inflight.delete(sessionId);
    });
    inflight.set(sessionId, request);
    return request;
  };

  return {
    bySession: {},
    ensure: (sessionId) => {
      const current = get().bySession[sessionId];
      if (current && current.status !== 'error') return;
      if (!current) patch(sessionId, { status: 'loading' });
      void load(sessionId);
    },
    refresh: (sessionId) => {
      const current = get().bySession[sessionId];
      if (!current || current.status === 'unsupported') return;
      void load(sessionId);
    },
    clear: () => {
      inflight.clear();
      set({ bySession: {} });
    },
    drop: (sessionId) => {
      inflight.delete(sessionId);
      set((state) => {
        if (!(sessionId in state.bySession)) return state;
        const { [sessionId]: _dropped, ...rest } = state.bySession;
        return { bySession: rest };
      });
    },
  };
});

onSessionReadAccessChange((sessionId) => {
  if (sessionId == null) useSessionTurns.getState().clear();
  else useSessionTurns.getState().drop(sessionId);
});
