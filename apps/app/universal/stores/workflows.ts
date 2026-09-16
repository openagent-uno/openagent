/**
 * Workflows state: n8n-style multi-block pipelines stored in SQLite.
 *
 * All CRUD + execution flows through /api/workflows — same source of
 * truth the workflow-manager MCP and the Scheduler loop read from.
 * Runs are fire-and-forget by default (wait=false); the UI polls for
 * status when showing live results.
 */

import { create } from 'zustand';
import type {
  BlockTypeSpec,
  CreateWorkflowInput,
  MCPToolkitDescriptor,
  UpdateWorkflowInput,
  WorkflowRun,
  WorkflowStats,
  WorkflowTask,
} from '../../common/types';
import * as api from '../services/api';

interface WorkflowsState {
  workflows: WorkflowTask[];
  loading: boolean;
  /** True once the first load attempt resolves (success or error). Lets
   *  the UI show a skeleton until then instead of flashing "no workflows". */
  loaded: boolean;
  error: string | null;
  saved: boolean;

  // Editor-adjacent catalogs — loaded once, cached for the editor's
  // palette and the mcp-tool block's tool picker.
  blockTypes: BlockTypeSpec[];
  mcpTools: MCPToolkitDescriptor[];

  // Per-workflow run state — keyed by workflow id. The UI's Run
  // button writes here so the list row can show "running" / "last
  // run succeeded" without a second store.
  runs: Record<string, WorkflowRun | null>;
  runningId: string | null;

  // Stats cache for the run-history view + list-row sparkline.
  stats: Record<string, WorkflowStats | null>;

  loadWorkflows: () => Promise<void>;
  createWorkflow: (input: CreateWorkflowInput) => Promise<WorkflowTask | null>;
  updateWorkflow: (
    id: string,
    input: UpdateWorkflowInput,
  ) => Promise<boolean>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  toggleWorkflow: (id: string, enabled: boolean) => Promise<boolean>;
  // Live-poll version: fires the run with wait=false, then polls
  // workflow-runs/{id} every pollMs until status leaves 'running'.
  // Intermediate trace entries stream into state so the editor can
  // paint per-block status dots as they resolve.
  runWorkflow: (
    id: string,
    inputs?: Record<string, unknown>,
    opts?: { pollMs?: number; onUpdate?: (run: WorkflowRun) => void },
  ) => Promise<WorkflowRun | null>;
  // Hard-stop the in-flight run(s). The gateway flags them cancelling and
  // the scheduler tears the executor down mid-DAG within ~2s; the polling
  // loop in ``runWorkflow`` then sees a terminal status and settles. Pass
  // ``runId`` to stop one specific run when several are in flight.
  //
  // A no-op (the run finished on its own between render and tap) comes back
  // with count 0 and is NOT an error — the button is allowed to be a frame
  // stale without throwing a dialog at the user.
  stopWorkflow: (id: string, runId?: string) => Promise<boolean>;
  loadStats: (id: string, last?: number) => Promise<WorkflowStats | null>;
  loadBlockTypes: () => Promise<void>;
  loadMcpTools: () => Promise<void>;
  clearSaved: () => void;
  clearError: () => void;
}

export const useWorkflows = create<WorkflowsState>((set, get) => ({
  workflows: [],
  loading: false,
  loaded: false,
  error: null,
  saved: false,
  blockTypes: [],
  mcpTools: [],
  runs: {},
  runningId: null,
  stats: {},

  loadWorkflows: async () => {
    set({ loading: true, error: null });
    try {
      const workflows = await api.getWorkflows();
      set({ workflows, loading: false, loaded: true });
    } catch (e: any) {
      set({ error: e?.message ?? String(e), loading: false, loaded: true });
    }
  },

  createWorkflow: async (input) => {
    try {
      set({ error: null });
      const created = await api.createWorkflow(input);
      set({ workflows: [created, ...get().workflows], saved: true });
      setTimeout(() => set({ saved: false }), 2000);
      return created;
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
      return null;
    }
  },

  updateWorkflow: async (id, input) => {
    try {
      set({ error: null });
      const updated = await api.updateWorkflow(id, input);
      set({
        workflows: get().workflows.map((w) => (w.id === id ? updated : w)),
        saved: true,
      });
      setTimeout(() => set({ saved: false }), 2000);
      return true;
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
      return false;
    }
  },

  deleteWorkflow: async (id) => {
    try {
      set({ error: null });
      await api.deleteWorkflow(id);
      const { [id]: _removed, ...remainingRuns } = get().runs;
      set({
        workflows: get().workflows.filter((w) => w.id !== id),
        runs: remainingRuns,
      });
      return true;
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
      return false;
    }
  },

  toggleWorkflow: async (id, enabled) => get().updateWorkflow(id, { enabled }),

  stopWorkflow: async (id, runId) => {
    try {
      set({ error: null });
      // wait=false so the button returns immediately; the run poller
      // already running in ``runWorkflow`` picks up the cancelled status.
      await api.stopWorkflow(id, { runId, wait: false });
      return true;
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
      return false;
    }
  },

  runWorkflow: async (id, inputs, opts = {}) => {
    const pollMs = opts.pollMs ?? 500;
    set({ runningId: id, error: null });
    try {
      // wait=false — the gateway returns the run_id as soon as the
      // executor inserts the row. We poll from here so the caller can
      // react to intermediate trace entries (blocks going from
      // 'running' → 'success' / 'failed').
      const started = await api.runWorkflow(id, { inputs, wait: false });
      const runId = (started as any)?.run_id;
      if (!runId) {
        set({
          error: 'Server did not return a run_id',
          runningId: null,
        });
        return null;
      }
      // Poll until the run leaves 'running'. Give ourselves a
      // generous upper bound (5 minutes) after which we surface a
      // timeout — the executor itself imposes per-block timeouts.
      const deadline = Date.now() + 5 * 60 * 1000;
      let last: WorkflowRun | null = null;
      while (Date.now() < deadline) {
        try {
          last = await api.getWorkflowRun(runId);
        } catch (e) {
          // The run row may take a beat to appear right after the
          // request lands — retry until the deadline.
          last = null;
        }
        if (last) {
          set({ runs: { ...get().runs, [id]: last } });
          opts.onUpdate?.(last);
          if (last.status !== 'running') break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (last && last.status !== 'running') {
        set({
          runningId: null,
          workflows: get().workflows.map((w) =>
            w.id === id
              ? {
                  ...w,
                  last_run_at: last!.started_at,
                  last_run_at_iso:
                    last!.started_at_iso ?? w.last_run_at_iso,
                }
              : w,
          ),
        });
      } else {
        set({ runningId: null, error: 'run polling timed out' });
      }
      // Refresh stats so the history drawer sees the new run.
      void get().loadStats(id);
      return last;
    } catch (e: any) {
      set({ error: e?.message ?? String(e), runningId: null });
      return null;
    }
  },

  loadStats: async (id, last = 10) => {
    try {
      const stats = await api.getWorkflowStats(id, { last });
      set({ stats: { ...get().stats, [id]: stats } });
      return stats;
    } catch (e: any) {
      // Non-fatal — the drawer just shows empty state.
      set({ stats: { ...get().stats, [id]: null } });
      return null;
    }
  },

  loadBlockTypes: async () => {
    try {
      const blockTypes = await api.getWorkflowBlockTypes();
      set({ blockTypes });
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
    }
  },

  loadMcpTools: async () => {
    try {
      const mcpTools = await api.getMcpTools();
      set({ mcpTools });
    } catch (e: any) {
      // Non-fatal — the tool picker just shows an empty list.
      set({ error: e?.message ?? String(e) });
    }
  },

  clearSaved: () => set({ saved: false }),
  clearError: () => set({ error: null }),
}));
