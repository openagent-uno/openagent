/**
 * Tasks state: scheduled tasks stored in the backend SQLite database.
 *
 * All CRUD flows through /api/scheduled-tasks — the same source of truth
 * the Scheduler loop and the scheduler MCP server use. No restart required
 * when changing tasks; the runtime picks up changes on its next tick (~30s).
 */

import { create } from 'zustand';
import type {
  ScheduledTask,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from '../../common/types';
import * as api from '../services/api';

interface TasksState {
  tasks: ScheduledTask[];
  loading: boolean;
  /** True after the first load attempt resolves (success or error). Lets
   *  the UI show a skeleton until then instead of flashing "no tasks". */
  loaded: boolean;
  error: string | null;
  saved: boolean;

  loadTasks: () => Promise<void>;
  createTask: (input: CreateScheduledTaskInput) => Promise<boolean>;
  updateTask: (id: string, input: UpdateScheduledTaskInput) => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  toggleTask: (id: string, enabled: boolean) => Promise<boolean>;
  /** Fire a task now, out of band from its cron schedule. Returns true once
   *  the run is dispatched (does not block on the firing finishing). */
  runTask: (id: string) => Promise<boolean>;
  /** Stop the currently-running firing(s) of a task. Returns true once the
   *  stop is requested (the scheduler hard-stops within ~2s). */
  stopTask: (id: string) => Promise<boolean>;
  clearSaved: () => void;
}

export const useTasks = create<TasksState>((set, get) => ({
  tasks: [],
  loading: false,
  loaded: false,
  error: null,
  saved: false,

  loadTasks: async () => {
    set({ loading: true, error: null });
    try {
      const tasks = await api.getScheduledTasks();
      set({ tasks, loading: false, loaded: true });
    } catch (e: any) {
      set({ error: e.message, loading: false, loaded: true });
    }
  },

  createTask: async (input) => {
    try {
      set({ error: null });
      const created = await api.createScheduledTask(input);
      set({ tasks: [created, ...get().tasks], saved: true });
      setTimeout(() => set({ saved: false }), 2000);
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  updateTask: async (id, input) => {
    try {
      set({ error: null });
      const updated = await api.updateScheduledTask(id, input);
      set({
        tasks: get().tasks.map((t) => (t.id === id ? updated : t)),
        saved: true,
      });
      setTimeout(() => set({ saved: false }), 2000);
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  deleteTask: async (id) => {
    try {
      set({ error: null });
      await api.deleteScheduledTask(id);
      set({ tasks: get().tasks.filter((t) => t.id !== id) });
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  toggleTask: async (id, enabled) => {
    return get().updateTask(id, { enabled });
  },

  runTask: async (id) => {
    try {
      set({ error: null });
      // wait=false: return as soon as the run is dispatched. The firing
      // continues server-side; its start flips ``running`` true and its
      // completion flips it back — both arrive as ``scheduled_task``
      // broadcasts the list refetches on. Refetch now too so the tile shows
      // the Stop control promptly without waiting on the event.
      await api.runScheduledTask(id, { wait: false });
      void get().loadTasks();
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  stopTask: async (id) => {
    try {
      set({ error: null });
      // wait=false: the scheduler hard-stops the firing within ~2s and
      // broadcasts the cancelled state. Refetch now for immediate feedback.
      await api.stopScheduledTask(id, { wait: false });
      void get().loadTasks();
      return true;
    } catch (e: any) {
      set({ error: e.message });
      return false;
    }
  },

  clearSaved: () => set({ saved: false }),
}));
