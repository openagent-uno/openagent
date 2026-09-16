/**
 * Resource-event fan-out store.
 *
 * The gateway broadcasts a ``resource_event`` over the chat WebSocket
 * any time a list-backed resource (MCPs, scheduled tasks, workflows,
 * vault notes, config sections) moves on the server. Each list screen
 * subscribes here on mount and refetches when its own resource fires
 * — so a chat-driven create/update/delete (e.g. the agent installing
 * an MCP via marketplace, or scheduling a task via the scheduler MCP)
 * shows up in the relevant tab without the user manually pulling.
 *
 * The store wires itself into ``connection.ws`` lazily the first time
 * a caller subscribes, then re-wires whenever the active connection
 * flips (account switch, reconnect after a restart). A short debounce
 * coalesces bursts — e.g. a workflow editor save can produce
 * ``updated`` for the workflow plus N schedule ticks for its blocks,
 * and we want one refetch, not N.
 */

import { create } from 'zustand';
import type { ResourceKind, ServerMessage } from '../../common/types';
import { useConnection } from './connection';

type Listener = () => void;

interface EventsState {
  // Active per-resource listener sets. Keyed by ResourceKind.
  listeners: Record<ResourceKind, Set<Listener>>;
  // Function returned by ws.onMessage; we call it on rewire/teardown.
  unbind: (() => void) | null;
  // Last ws instance we subscribed to — drives the rewire check.
  boundWs: unknown;

  subscribe: (resource: ResourceKind, cb: Listener) => () => void;
  // Internal: ensures the ws listener is bound to the current ws, and
  // re-binds if the user switched accounts or reconnected.
  _ensureBound: () => void;
}

const RESOURCES: ResourceKind[] = [
  'mcp',
  'scheduled_task',
  'workflow',
  'vault',
  'config',
  // Fires when a child session (delegation / scheduled firing / workflow
  // node) is spawned, so the sidebar refetches and the new session appears
  // and streams live.
  'session',
  // Webhook Events: fires on event create/update/delete AND on every delivery
  // (received → running → success/failed), so the Events screen and the
  // sidebar Recent feed update live when an event is triggered.
  'event',
];

const DEBOUNCE_MS = 150;

function makeEmptyListeners(): Record<ResourceKind, Set<Listener>> {
  const out = {} as Record<ResourceKind, Set<Listener>>;
  for (const r of RESOURCES) out[r] = new Set();
  return out;
}

const pendingTimers = new Map<ResourceKind, ReturnType<typeof setTimeout>>();

function fanOut(state: EventsState, resource: ResourceKind): void {
  const existing = pendingTimers.get(resource);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(resource);
    const listeners = state.listeners[resource];
    if (!listeners) return;
    for (const cb of Array.from(listeners)) {
      try {
        cb();
      } catch {
        // Listeners are screen-local refetches; one crashing must not
        // disrupt the others.
      }
    }
  }, DEBOUNCE_MS);
  pendingTimers.set(resource, timer);
}

export const useEvents = create<EventsState>((set, get) => ({
  listeners: makeEmptyListeners(),
  unbind: null,
  boundWs: null,

  subscribe: (resource, cb) => {
    get()._ensureBound();
    const listeners = get().listeners[resource];
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  _ensureBound: () => {
    const ws = useConnection.getState().ws;
    if (ws === get().boundWs && get().unbind != null) return;
    // Ws changed (account switch, reconnect). Drop any prior binding,
    // then bind to the new one. ``ws`` may be null while the user is
    // logged out; in that case we skip and rebind on the next call.
    const prior = get().unbind;
    if (prior) prior();
    if (!ws) {
      set({ unbind: null, boundWs: null });
      return;
    }
    const off = ws.onMessage((msg: ServerMessage) => {
      if (msg.type !== 'resource_event') return;
      fanOut(get(), msg.resource);
    });
    set({ unbind: off, boundWs: ws });
  },
}));
