/**
 * System telemetry store — live snapshots from the gateway.
 *
 * The gateway pushes a ``system_snapshot`` over the chat WebSocket
 * every ~2 seconds when at least one client is connected. Components
 * call ``useSystem()`` to read the latest value and ``startSystemFeed``
 * (typically from a screen's mount effect) to bootstrap the
 * subscription. The first snapshot lands either via REST seed or via
 * the next WS tick — whichever wins.
 *
 * The store rebinds itself when the WebSocket reconnects (account
 * switch or transient drop) so the live feed survives both.
 */

import { create } from 'zustand';
import type { ServerMessage, SystemSnapshot } from '../../common/types';
import { useConnection } from './connection';
import { getSystemSnapshot } from '../services/api';

interface SystemState {
  snapshot: SystemSnapshot | null;
  error: string | null;
  // Set in start/stop pairs; we only want one binding per ws.
  unbind: (() => void) | null;
  boundWs: unknown;

  /** Seed the snapshot via REST and bind the WS push feed. Idempotent. */
  start: () => Promise<void>;
  /** Drop the WS binding. Safe to call when nothing is bound. */
  stop: () => void;
}

export const useSystem = create<SystemState>((set, get) => ({
  snapshot: null,
  error: null,
  unbind: null,
  boundWs: null,

  start: async () => {
    const ws = useConnection.getState().ws;
    // Re-bind if the active ws changed (account switch, reconnect).
    if (ws !== get().boundWs) {
      const prior = get().unbind;
      if (prior) prior();
      set({ unbind: null, boundWs: null });
    }

    if (ws && get().unbind == null) {
      const off = ws.onMessage((msg: ServerMessage) => {
        if (msg.type !== 'system_snapshot') return;
        set({ snapshot: msg.snapshot, error: null });
      });
      set({ unbind: off, boundWs: ws });
    }

    // Kick off a REST fetch so the screen has data to paint while
    // waiting for the next WS tick. Failures (gateway not yet
    // serving, transient DNS) are surfaced as ``error`` and don't
    // throw — the WS feed is the authoritative source anyway.
    try {
      const snap = await getSystemSnapshot();
      // Only adopt the REST snapshot if no fresher one arrived via
      // WS while the request was in flight.
      const current = get().snapshot;
      if (!current || current.timestamp < snap.timestamp) {
        set({ snapshot: snap, error: null });
      }
    } catch (e: any) {
      set({ error: e?.message || String(e) });
    }
  },

  stop: () => {
    const off = get().unbind;
    if (off) off();
    set({ unbind: null, boundWs: null });
  },
}));
