/**
 * Event definitions state — the webhook Events channel.
 *
 * Named ``eventDefs`` to avoid colliding with ``stores/events.ts`` (the
 * resource-event bus). All CRUD flows through /api/events — the same source of
 * truth the events-manager MCP writes to. The dedicated webhook listener
 * serves inbound deliveries; this store manages the definitions.
 *
 * Create + rotate-secret return the clear secret ONCE (inline on the response);
 * the store surfaces it to the caller so the editor can show it a single time.
 */

import { create } from 'zustand';
import type {
  AgentEvent,
  CreateEventInput,
  UpdateEventInput,
  EventTypeSpec,
} from '../../common/types';
import * as api from '../services/api';

interface EventDefsState {
  events: AgentEvent[];
  types: EventTypeSpec[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  saved: boolean;

  loadEvents: () => Promise<void>;
  loadTypes: () => Promise<void>;
  /** Returns the created event WITH its one-time ``secret`` on success. */
  createEvent: (input: CreateEventInput) => Promise<AgentEvent | null>;
  updateEvent: (id: string, input: UpdateEventInput) => Promise<boolean>;
  deleteEvent: (id: string) => Promise<boolean>;
  toggleEvent: (id: string, enabled: boolean) => Promise<boolean>;
  /** Returns the event WITH its new one-time ``secret``. */
  rotateSecret: (id: string) => Promise<AgentEvent | null>;
  /** Fire an event now with a sample payload (the "Test" button). */
  testEvent: (id: string, payload: Record<string, unknown>) => Promise<boolean>;
  clearSaved: () => void;
}

export const useEventDefs = create<EventDefsState>((set, get) => ({
  events: [],
  types: [],
  loading: false,
  loaded: false,
  error: null,
  saved: false,

  loadEvents: async () => {
    set({ loading: true, error: null });
    try {
      const events = await api.getEvents();
      set({ events, loading: false, loaded: true });
    } catch (e: any) {
      set({ error: e.message, loading: false, loaded: true });
    }
  },

  loadTypes: async () => {
    try {
      set({ types: await api.getEventTypes() });
    } catch {
      /* non-fatal: the editor falls back to a static list */
    }
  },

  createEvent: async (input) => {
    try {
      set({ error: null });
      const created = await api.createEvent(input);
      set({ events: [created, ...get().events], saved: true });
      setTimeout(() => set({ saved: false }), 2000);
      return created;
    } catch (e: any) {
      set({ error: e.message });
      return null;
    }
  },

  updateEvent: async (id, input) => {
    try {
      set({ error: null });
      const updated = await api.updateEvent(id, input);
      set({ events: get().events.map((e) => (e.id === id ? updated : e)), saved: true });
      setTimeout(() => set({ saved: false }), 2000);
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  deleteEvent: async (id) => {
    try {
      set({ error: null });
      await api.deleteEvent(id);
      set({ events: get().events.filter((e) => e.id !== id) });
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  toggleEvent: async (id, enabled) => get().updateEvent(id, { enabled }),

  rotateSecret: async (id) => {
    try {
      set({ error: null });
      const ev = await api.rotateEventSecret(id);
      set({ events: get().events.map((e) => (e.id === id ? { ...ev, secret: undefined } : e)) });
      return ev;
    } catch (e: any) {
      set({ error: e.message });
      return null;
    }
  },

  testEvent: async (id, payload) => {
    try {
      set({ error: null });
      await api.triggerEvent(id, payload, { wait: false });
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  clearSaved: () => set({ saved: false }),
}));
