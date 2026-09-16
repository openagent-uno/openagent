/**
 * Activity store — the data behind the sidebar's unified "Recent" feed.
 *
 * The sidebar shows one chronological stream mixing three kinds of work:
 * conversations (owned by the chat store), workflow runs, and
 * scheduled-task runs. Conversations arrive live over the chat socket;
 * runs do not have a single list endpoint, so this store fans out over
 * every workflow / scheduled task and pulls each one's recent run history,
 * then flattens the results into two flat, recency-sortable lists.
 *
 * The fan-out is bounded (a cap on parents, a small per-parent run limit,
 * and a single in-flight guard) so a busy agent can't turn one sidebar
 * mount into hundreds of requests. The dedicated Workflows / Scheduled
 * screens hold the full history; this is just the at-a-glance feed.
 */

import { create } from 'zustand';
import {
  getWorkflows,
  getWorkflowRuns,
  getScheduledTasks,
  getScheduledTaskRuns,
  getEvents,
  getEventDeliveries,
} from '../services/api';

/** A run flattened with its parent's display name, ready for the feed. */
export interface ActivityRun {
  /** Run id. */
  id: string;
  /** Produced chat session id, when the run owns/reuses one. */
  sessionId?: string | null;
  /** Parent workflow / task id (for routing to its run screen). */
  parentId: string;
  /** Parent display name (what the row shows). */
  parentName: string;
  /** Run status — drives the status dot colour. */
  status: string;
  /** Run start, normalized epoch (whatever the server emitted). */
  startedAt: number | null;
}

export interface ActivityFilters {
  chat: boolean;
  workflow: boolean;
  task: boolean;
  event: boolean;
}

interface ActivityState {
  workflowRuns: ActivityRun[];
  taskRuns: ActivityRun[];
  eventRuns: ActivityRun[];
  filters: ActivityFilters;
  loading: boolean;
  loadedOnce: boolean;

  loadActivity: () => Promise<void>;
  setFilter: (key: keyof ActivityFilters, value: boolean) => void;
  clear: () => void;
}

// Bounds on the fan-out. We only need enough rows to fill the visible feed
// (the sidebar caps it again at FEED_MAX); pulling the most-recent handful
// per parent keeps the request count and payload small.
const MAX_PARENTS = 40;
const RUNS_PER_PARENT = 6;
const CONCURRENCY = 6;

/** Run `tasks` with a small concurrency cap so a wide fan-out doesn't open
 *  dozens of sockets at once. Failures resolve to `null` rather than
 *  rejecting the whole batch — one dead workflow shouldn't blank the feed. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

let inFlight: Promise<void> | null = null;

export const useActivity = create<ActivityState>((set, _get) => ({
  workflowRuns: [],
  taskRuns: [],
  eventRuns: [],
  filters: { chat: true, workflow: true, task: true, event: true },
  loading: false,
  loadedOnce: false,

  loadActivity: async () => {
    // Coalesce concurrent callers (mount + event refresh racing) onto one
    // request batch.
    if (inFlight) return inFlight;
    set({ loading: true });

    inFlight = (async () => {
      try {
        const [workflows, tasks, events] = await Promise.all([
          getWorkflows().catch(() => []),
          // Include framework built-ins so a dream-mode firing surfaces in
          // the Recent feed like any other scheduled run. The dedicated
          // Scheduled-tasks screen still lists user tasks only.
          getScheduledTasks(false, true).catch(() => []),
          getEvents().catch(() => []),
        ]);

        // Prioritise the parents most likely to have fresh runs.
        const wf = [...workflows]
          .sort((a, b) => (b.last_run_at ?? b.updated_at ?? 0) - (a.last_run_at ?? a.updated_at ?? 0))
          .slice(0, MAX_PARENTS);
        const tk = [...tasks]
          .sort((a, b) => (b.last_run ?? b.updated_at ?? 0) - (a.last_run ?? a.updated_at ?? 0))
          .slice(0, MAX_PARENTS);
        const ev = [...events]
          .sort((a, b) => (b.last_triggered_at ?? b.updated_at ?? 0) - (a.last_triggered_at ?? a.updated_at ?? 0))
          .slice(0, MAX_PARENTS);

        const wfRunsNested = await mapLimit(wf, CONCURRENCY, async (w) => {
          const runs = await getWorkflowRuns(w.id, { limit: RUNS_PER_PARENT });
          return runs.map<ActivityRun>((r) => ({
            id: r.id,
            parentId: w.id,
            parentName: w.name,
            status: r.status,
            startedAt: r.started_at ?? null,
          }));
        });

        const tkRunsNested = await mapLimit(tk, CONCURRENCY, async (t) => {
          const runs = await getScheduledTaskRuns(t.id, { limit: RUNS_PER_PARENT });
          return runs.map<ActivityRun>((r) => ({
            id: r.id,
            parentId: t.id,
            parentName: t.name,
            status: r.status,
            startedAt: r.started_at ?? null,
          }));
        });

        // Events' "runs" are their deliveries — one row per inbound trigger.
        const evRunsNested = await mapLimit(ev, CONCURRENCY, async (e) => {
          const dels = await getEventDeliveries(e.id, RUNS_PER_PARENT);
          return dels.map<ActivityRun>((d) => ({
            id: d.id,
            sessionId: d.session_id ?? null,
            parentId: e.id,
            parentName: e.name,
            status: d.status,
            startedAt: d.started_at ?? null,
          }));
        });

        const workflowRuns = wfRunsNested.filter(Boolean).flat() as ActivityRun[];
        const taskRuns = tkRunsNested.filter(Boolean).flat() as ActivityRun[];
        const eventRuns = evRunsNested.filter(Boolean).flat() as ActivityRun[];

        set({ workflowRuns, taskRuns, eventRuns, loading: false, loadedOnce: true });
      } catch {
        set({ loading: false, loadedOnce: true });
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  },

  setFilter: (key, value) =>
    set((s) => ({ filters: { ...s.filters, [key]: value } })),

  clear: () => set({ workflowRuns: [], taskRuns: [], eventRuns: [], loadedOnce: false }),
}));
