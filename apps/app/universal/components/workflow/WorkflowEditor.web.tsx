/**
 * WorkflowEditor — web/Electron implementation backed by React Flow.
 *
 * Layout: [BlockPalette | ReactFlow canvas | PropertiesPanel], with
 * a top bar carrying Back / workflow name / Save / Run controls.
 * Unsaved edits are tracked locally and only flushed to the gateway
 * when the user clicks Save — keeps the graph validator from firing
 * on every keystroke.
 *
 * The block palette pushes drag events; the canvas's ``onDrop``
 * translates the screen coordinates into graph coordinates and
 * appends a new node with a fresh short id (``n1``, ``n2``, …).
 * Auto-layout uses dagre: one click re-lays the whole graph in a
 * left-to-right DAG view.
 */

import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  Edge,
  MiniMap,
  Node as RFNode,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  Panel,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';

import Feather from '@expo/vector-icons/Feather';
import dagre from 'dagre';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';

import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowTask,
  WorkflowTraceEntry,
} from '../../../common/types';
import { useWorkflows } from '../../stores/workflows';
import { colors, font, radius } from '../../theme';
import BlockPalette from './BlockPalette';
import PropertiesPanel from './PropertiesPanel';
import { openDetached } from '../../services/windows';
import { HeaderMenu } from '../screenHeader';
import { nodeTypes } from './nodes/nodeTypes';

interface Props {
  workflow: WorkflowTask;
  onBack: () => void;
  onWorkflowUpdated?: (wf: WorkflowTask) => void;
  initialNodeId?: string;
  initialField?: string;
}

type NodeStatus = 'idle' | 'running' | 'success' | 'failed';

export default function WorkflowEditor(props: Props) {
  // ReactFlowProvider must wrap anything that calls useReactFlow().
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({ workflow, onBack, onWorkflowUpdated, initialNodeId, initialField }: Props) {
  const {
    blockTypes,
    mcpTools,
    runningId,
    loadBlockTypes,
    loadMcpTools,
    updateWorkflow,
    runWorkflow,
    stopWorkflow,
    runs,
  } = useWorkflows();
  const router = useRouter();

  // Local graph state — the gateway-persisted shape only flushes on Save.
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastRunStatus, setLastRunStatus] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, NodeStatus>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Empty string ↔ no cap (unlimited). The text input keeps the raw
  // string so a user can type-and-correct without losing focus.
  const [maxConcurrentInput, setMaxConcurrentInput] = useState<string>(
    workflow.max_concurrent_runs != null
      ? String(workflow.max_concurrent_runs)
      : '',
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  // Seed editor state from the loaded workflow.
  useEffect(() => {
    const g = workflow.graph || { nodes: [], edges: [], variables: {} };
    setNodes(
      (g.nodes || []).map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position || { x: 0, y: 0 },
        data: { label: n.label, config: n.config, status: 'idle' },
      })),
    );
    setEdges(
      (g.edges || []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        label: e.label || undefined,
      })),
    );
    setVariables(g.variables || {});
    setDirty(false);
    setSelectedNodeId(
      initialNodeId && (g.nodes || []).some((node) => node.id === initialNodeId)
        ? initialNodeId : null,
    );
    // ``maxConcurrentInput`` is seeded in its OWN effect (below) so a
    // settings save — which mutates ``workflow.max_concurrent_runs`` on
    // the parent and re-renders us — cannot retrigger this effect and
    // wipe unsaved graph edits. Same applies to any future scalar
    // metadata field: do not depend on it here.
  }, [initialNodeId, workflow.id]);

  // Seed/refresh just the concurrency input when the parent prop
  // changes. Decoupled from the graph-seed effect so saving the cap
  // mid-edit does not clobber unsaved nodes/edges/variables.
  useEffect(() => {
    setMaxConcurrentInput(
      workflow.max_concurrent_runs != null
        ? String(workflow.max_concurrent_runs)
        : '',
    );
    setSettingsError(null);
  }, [workflow.id, workflow.max_concurrent_runs]);

  useEffect(() => {
    if (blockTypes.length === 0) void loadBlockTypes();
    if (mcpTools.length === 0) void loadMcpTools();
  }, []);

  // ── React Flow event bridges ────────────────────────────────────

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    // Pure selection/dimension changes don't count as unsaved edits.
    if (changes.some((c) => c.type === 'position' || c.type === 'remove')) {
      setDirty(true);
    }
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type === 'remove')) {
      setDirty(true);
    }
  }, []);

  const onConnect: OnConnect = useCallback((conn: Connection) => {
    setEdges((es) =>
      addEdge(
        {
          ...conn,
          id: newEdgeId(es),
          sourceHandle: conn.sourceHandle || 'out',
          targetHandle: conn.targetHandle || 'in',
        },
        es,
      ),
    );
    setDirty(true);
  }, []);

  const onNodeClick = useCallback((_evt: unknown, n: RFNode) => {
    setSelectedNodeId(n.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // Drag-from-palette → drop on canvas.
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/oa-block');
      if (!type) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = newNodeId(nodes);
      setNodes((ns) => [
        ...ns,
        {
          id,
          type,
          position,
          data: { label: '', config: defaultConfigFor(type), status: 'idle' },
        },
      ]);
      setDirty(true);
      setSelectedNodeId(id);
    },
    [nodes, screenToFlowPosition],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // ── Selected node helpers ───────────────────────────────────────

  const selectedNode = useMemo<WorkflowNode | null>(() => {
    if (!selectedNodeId) return null;
    const rf = nodes.find((n) => n.id === selectedNodeId);
    if (!rf) return null;
    const data = (rf.data || {}) as { label?: string; config?: Record<string, unknown> };
    return {
      id: rf.id,
      type: rf.type as WorkflowNode['type'],
      label: data.label,
      position: { x: rf.position.x, y: rf.position.y },
      config: data.config || {},
    };
  }, [nodes, selectedNodeId]);

  const patchSelectedNode = useCallback(
    (nodeId: string, patch: Partial<WorkflowNode>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...(n.data as object),
                  ...(patch.label !== undefined ? { label: patch.label } : {}),
                  ...(patch.config !== undefined ? { config: patch.config } : {}),
                },
              }
            : n,
        ),
      );
      setDirty(true);
    },
    [],
  );

  const deleteSelectedNode = useCallback((nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedNodeId(null);
    setDirty(true);
  }, []);

  // ── Save / Run / auto-layout ────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const graphNodes: WorkflowNode[] = nodes.map((n) => ({
        id: n.id,
        type: n.type as WorkflowNode['type'],
        label: ((n.data as any)?.label) || undefined,
        position: { x: n.position.x, y: n.position.y },
        config: ((n.data as any)?.config) || {},
      }));
      const graphEdges: WorkflowEdge[] = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || 'out',
        targetHandle: e.targetHandle || 'in',
        label: (e.label as string | null | undefined) ?? null,
      }));
      const ok = await updateWorkflow(workflow.id, {
        nodes: graphNodes,
        edges: graphEdges,
        variables,
      });
      if (ok) {
        setDirty(false);
        // Refresh the upstream prop so onWorkflowUpdated gets the
        // latest row — keeps the header reflecting real state.
        const updated = useWorkflows
          .getState()
          .workflows.find((w) => w.id === workflow.id);
        if (updated && onWorkflowUpdated) onWorkflowUpdated(updated);
      } else {
        const err = useWorkflows.getState().error;
        setSaveError(err || 'Failed to save — server rejected the graph.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSettingsError(null);
    const trimmed = maxConcurrentInput.trim();
    let cap: number | null;
    if (trimmed === '') {
      cap = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setSettingsError(
          'Enter a whole number >= 1, or leave empty for unlimited.',
        );
        return;
      }
      cap = parsed;
    }
    setSavingSettings(true);
    try {
      const ok = await updateWorkflow(workflow.id, {
        max_concurrent_runs: cap,
      });
      if (ok) {
        setSettingsOpen(false);
        const updated = useWorkflows
          .getState()
          .workflows.find((w) => w.id === workflow.id);
        if (updated && onWorkflowUpdated) onWorkflowUpdated(updated);
      } else {
        setSettingsError(
          useWorkflows.getState().error ||
            'Failed to save concurrency setting.',
        );
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRun = async () => {
    // Reset node statuses for the new run, then stream trace entries
    // back onto the canvas as the executor resolves each block.
    setNodeStatuses({});
    setLastRunStatus('running');
    const run = await runWorkflow(workflow.id, {}, {
      onUpdate: (live) => {
        setLastRunStatus(live.status);
        const incremental: Record<string, NodeStatus> = {};
        for (const entry of live.trace || []) {
          const s = entry.status;
          if (s === 'success' || s === 'failed' || s === 'running') {
            incremental[entry.node_id] = s;
          }
        }
        setNodeStatuses(incremental);
      },
    });
    if (!run) {
      setLastRunStatus('failed');
      return;
    }
    setLastRunStatus(run.status);
    // Paint the trace back onto the canvas so each node shows what happened.
    const statuses: Record<string, NodeStatus> = {};
    for (const entry of run.trace || []) {
      const e = entry as WorkflowTraceEntry;
      statuses[e.node_id] =
        e.status === 'success' || e.status === 'failed' || e.status === 'running'
          ? e.status
          : 'idle';
    }
    setNodeStatuses(statuses);
  };

  // Paint statuses into node data so custom nodes re-render.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const s = nodeStatuses[n.id];
        if (!s) return n;
        return {
          ...n,
          data: { ...(n.data as object), status: s },
        };
      }),
    );
  }, [nodeStatuses]);

  const handleAutoLayout = useCallback(() => {
    setNodes((ns) => {
      const laid = autoLayout(ns, edges);
      return laid;
    });
    setDirty(true);
  }, [edges]);

  const isRunning = runningId === workflow.id;

  // Stop the run this editor is watching. Without it the Run button was a
  // one-way door: a runaway DAG could only be killed by asking the agent
  // to call its MCP tool.
  const handleStop = async () => {
    await stopWorkflow(workflow.id, runs[workflow.id]?.id);
  };

  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <HeaderMenu />
        <button onClick={onBack} style={styles.iconBtn as any} title="Back">
          <Feather name="arrow-left" size={14} color={colors.textSecondary} />
        </button>
        <div style={styles.workflowInfo}>
          <div style={styles.workflowName}>Workflow</div>
          {workflow.description && (
            <div style={styles.workflowDescription}>{workflow.description}</div>
          )}
        </div>
        <div style={styles.topBarActions}>
          {lastRunStatus && (
            <span
              style={{
                ...styles.statusPill,
                ...(lastRunStatus === 'success'
                  ? styles.statusPillOk
                  : lastRunStatus === 'running'
                  ? styles.statusPillRun
                  : styles.statusPillErr),
              } as any}
            >
              {lastRunStatus}
            </span>
          )}
          <button
            onClick={() => openDetached(router, `workflows/runs/${workflow.id}`)}
            style={styles.secondaryBtn as any}
            title="Run history"
          >
            <Feather name="clock" size={12} color={colors.textSecondary} />
            <span style={{ marginLeft: 5 }}>History</span>
          </button>
          <button
            onClick={() => setSettingsOpen((open) => !open)}
            style={styles.secondaryBtn as any}
            title={
              workflow.max_concurrent_runs == null
                ? 'Concurrency: unlimited'
                : `Concurrency: max ${workflow.max_concurrent_runs} at a time`
            }
          >
            <Feather name="sliders" size={12} color={colors.textSecondary} />
            <span style={{ marginLeft: 5 }}>
              {workflow.max_concurrent_runs == null
                ? '∞'
                : `≤${workflow.max_concurrent_runs}`}
            </span>
          </button>
          <button
            onClick={handleAutoLayout}
            style={styles.secondaryBtn as any}
            title="Auto-layout with dagre"
          >
            <Feather name="grid" size={12} color={colors.textSecondary} />
            <span style={{ marginLeft: 5 }}>Tidy</span>
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            style={
              {
                ...styles.primaryBtn,
                opacity: !dirty || saving ? 0.55 : 1,
              } as any
            }
          >
            <Feather
              name="save"
              size={12}
              color={colors.textInverse}
            />
            <span style={{ marginLeft: 5 }}>
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </span>
          </button>
          {isRunning ? (
            <button
              onClick={handleStop}
              style={{ ...styles.runBtn, backgroundColor: colors.error } as any}
            >
              <Feather name="square" size={12} color={colors.textInverse} />
              <span style={{ marginLeft: 5 }}>Stop</span>
            </button>
          ) : (
            <button onClick={handleRun} style={styles.runBtn as any}>
              <Feather name="play" size={12} color={colors.textInverse} />
              <span style={{ marginLeft: 5 }}>Run</span>
            </button>
          )}
        </div>
      </div>

      {saveError && <div style={styles.banner}>{saveError}</div>}

      {settingsOpen && (
        <div style={styles.settingsPanel as any}>
          <div style={styles.settingsRow as any}>
            <div style={styles.settingsLabel as any}>Max concurrent runs</div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={maxConcurrentInput}
              onChange={(e) => setMaxConcurrentInput(e.target.value)}
              placeholder="unlimited"
              style={styles.settingsInput as any}
              aria-label="Maximum concurrent runs"
            />
            <button
              onClick={() => {
                void handleSaveSettings();
              }}
              disabled={savingSettings}
              style={
                {
                  ...styles.primaryBtn,
                  opacity: savingSettings ? 0.55 : 1,
                } as any
              }
            >
              {savingSettings ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setSettingsOpen(false);
                setSettingsError(null);
                setMaxConcurrentInput(
                  workflow.max_concurrent_runs != null
                    ? String(workflow.max_concurrent_runs)
                    : '',
                );
              }}
              style={styles.secondaryBtn as any}
            >
              Cancel
            </button>
          </div>
          <div style={styles.settingsHint as any}>
            Leave empty for unlimited (default — every triggered run starts
            immediately). 1 fully serializes. Higher numbers admit that many
            simultaneous runs; additional ones queue.
          </div>
          {settingsError && (
            <div style={styles.settingsError as any}>{settingsError}</div>
          )}
        </div>
      )}

      <div style={styles.main}>
        <BlockPalette blockTypes={blockTypes} />

        <div
          ref={canvasRef}
          style={styles.canvas}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor={() => colors.primary}
              maskColor="rgba(26, 25, 21, 0.06)"
              pannable
              zoomable
            />
            {nodes.length === 0 && (
              <Panel position="top-center">
                <div style={styles.emptyHint}>
                  Drag a block from the left to start. Connect blocks by
                  dragging from one handle (●) to another.
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        <PropertiesPanel
          node={selectedNode}
          blockTypes={blockTypes}
          initialField={initialField}
          onChange={patchSelectedNode}
          onDelete={deleteSelectedNode}
        />
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function newNodeId(existing: RFNode[]): string {
  const used = new Set(existing.map((n) => n.id));
  let i = existing.length + 1;
  while (used.has(`n${i}`)) i++;
  return `n${i}`;
}

function newEdgeId(existing: Edge[]): string {
  const used = new Set(existing.map((e) => e.id));
  let i = existing.length + 1;
  while (used.has(`e${i}`)) i++;
  return `e${i}`;
}

function defaultConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case 'trigger-manual':
      return {};
    case 'trigger-schedule':
      return { cron_expression: '' };
    case 'trigger-ai':
      return { description: '' };
    case 'mcp-tool':
      return { mcp_name: '', tool_name: '', args: {} };
    case 'ai-prompt':
      return { prompt: '', session_policy: 'ephemeral' };
    case 'set-variable':
      return { key: '', value_expr: '' };
    case 'if':
      return { expression: '' };
    case 'loop':
      return { items_expr: '', max_iterations: 100, iteration_var: 'item' };
    case 'wait':
      return { mode: 'duration', seconds: 5 };
    case 'parallel':
      return { branches: 2 };
    case 'merge':
      return { strategy: 'all' };
    case 'http-request':
      return { method: 'GET', url: '' };
    default:
      return {};
  }
}

// dagre auto-layout: left-to-right DAG. Mutates node positions; edges
// are untouched. Width/height are the approximate bounding box of
// BaseNode — slight overdraw is cheap compared to dynamic measurement.
const NODE_WIDTH = 220;
const NODE_HEIGHT = 88;

function autoLayout(nodes: RFNode[], edges: Edge[]): RFNode[] {
  if (nodes.length === 0) return nodes;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return pos
      ? {
          ...n,
          position: {
            x: pos.x - NODE_WIDTH / 2,
            y: pos.y - NODE_HEIGHT / 2,
          },
        }
      : n;
  });
}

// ── styles ──────────────────────────────────────────────────────────

const styles: Record<string, any> = {
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    background: colors.bg,
    fontFamily: font.sans,
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    borderBottom: `1px solid ${colors.border}`,
    background: colors.surface,
  },
  iconBtn: {
    padding: 6,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: radius.sm,
  },
  workflowInfo: { flex: 1, minWidth: 0 },
  workflowName: {
    fontSize: 14,
    fontWeight: 600,
    color: colors.text,
    letterSpacing: -0.1,
  },
  workflowDescription: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: '15px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  topBarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  primaryBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    borderRadius: radius.md,
    background: `linear-gradient(90deg, ${colors.primary}, ${colors.primaryEnd})`,
    color: colors.textInverse,
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    borderRadius: radius.md,
    background: colors.surface,
    color: colors.textSecondary,
    border: `1px solid ${colors.border}`,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  runBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    borderRadius: radius.md,
    background: colors.success,
    color: colors.textInverse,
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  statusPill: {
    fontSize: 10,
    padding: '3px 10px',
    borderRadius: radius.pill,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: 600,
  },
  statusPillOk: { background: 'rgba(21, 136, 94, 0.12)', color: '#15885E' },
  statusPillErr: { background: 'rgba(201, 74, 67, 0.12)', color: '#C94A43' },
  statusPillRun: { background: 'rgba(204, 128, 32, 0.15)', color: '#CC8020' },
  banner: {
    padding: '6px 12px',
    background: 'rgba(201, 74, 67, 0.08)',
    color: colors.error,
    fontSize: 11,
    borderBottom: `1px solid ${colors.border}`,
  },
  settingsPanel: {
    padding: '10px 14px',
    background: colors.surface,
    borderBottom: `1px solid ${colors.border}`,
  },
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  settingsLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: colors.text,
  },
  settingsInput: {
    flex: '0 0 110px',
    padding: '5px 9px',
    fontSize: 12,
    fontFamily: 'inherit',
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    background: colors.inputBg,
    color: colors.text,
    outline: 'none',
  },
  settingsHint: {
    marginTop: 6,
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: '15px',
  },
  settingsError: {
    marginTop: 6,
    fontSize: 11,
    color: colors.error,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'row',
    minHeight: 0,
  },
  canvas: {
    flex: 1,
    position: 'relative',
    minWidth: 0,
    background: colors.bg,
  },
  emptyHint: {
    background: colors.surface,
    border: `1px dashed ${colors.border}`,
    color: colors.textMuted,
    borderRadius: radius.md,
    padding: '8px 12px',
    fontSize: 11,
    maxWidth: 420,
    textAlign: 'center',
  },
};
