/**
 * Shared types for OpenAgent WebSocket protocol and REST API.
 * Used by both the universal app and the desktop Electron wrapper.
 */

import type { ToolExecutionHost } from './client-capabilities';
import type {
  CapabilitiesResponse,
  HistoryChangedEvent,
  SearchIndexChangedEvent,
  Completeness,
  MessageStatus,
} from './unified-history';
import type { MessagePart } from './ui-views';
import type { AttachmentRef } from './attachments';
export type { AttachmentRef } from './attachments';

// ── WebSocket Protocol ──

export type ClientMessage =
  // Legacy AUTH frame: ignored by the gateway (auth is enforced at the
  // Iroh transport layer via the device cert), but we keep sending one
  // for back-compat with code that waits for AUTH_OK as a "ready"
  // signal. ``token`` is no longer required.
  | {
      type: 'auth';
      token?: string;
      client_id?: string;
      client_kind?: string;
      client_instance_id?: string;
    }
  // ``input_was_voice``: true when the user just spoke (mic + ASR via
  // /api/upload). The gateway responds via the streaming TTS pipeline
  // when a TTS provider is configured, falling through to text-only
  // otherwise. Mirror-modality semantics — text-typed messages get
  // text-only replies regardless of voice mode.
  // ``voice_language``: ISO-639-1 hint matching what Whisper used for
  // transcription. The gateway forwards it to Piper so a transcribed
  // Italian message gets spoken with an Italian voice instead of the
  // default American one. Ignored unless ``input_was_voice`` is true.
  | {
      type: 'message';
      text: string;
      session_id: string;
      input_was_voice?: boolean;
      voice_language?: string;
    }
  // ``session_id`` MUST be passed for ``stop`` / ``new`` / ``clear`` / ``reset``
  // when the client hosts multiple independent conversations on one ws
  // (e.g. two chat tabs). The gateway scopes those commands to the tab's
  // session so one tab's /clear doesn't wipe the others.
  // ``arg`` carries an optional positional argument (e.g. ``/model gpt-4o``
  // sends ``name: 'model', arg: 'gpt-4o'``). Undefined = no argument.
  | {
      type: 'command';
      name: 'stop' | 'new' | 'clear' | 'reset' | 'status' | 'queue' | 'help'
           | 'usage' | 'context' | 'update' | 'restart' | 'compact' | 'model';
      session_id?: string;
      arg?: string;
    }
  | { type: 'ping' }
  // ── Stream protocol (additive) ──
  // Long-lived realtime sessions carry typed events on top of the same
  // WS. ``session_open`` begins; ``audio_chunk_in`` / ``video_frame`` /
  // ``text_delta`` / ``text_final`` / ``attachment`` push input;
  // ``interrupt`` triggers barge-in; ``session_close`` ends. The legacy
  // ``message`` frame still works for one-shot text turns; the new
  // surface is opt-in. Audio/video bytes are base64-encoded.
  | {
      type: 'session_open';
      session_id: string;
      profile?: 'realtime' | 'batched';
      llm_pin?: string;
      stt_pin?: string;
      tts_pin?: string;
      language?: string;
      client_kind?: string;
      /** Boot-scoped interactive client identity. The server only attaches
       *  client-local tools when this exact instance has a live, certified
       *  capability channel; absent means server-only execution. */
      client_instance_id?: string;
      // Debounce window for typed-text bursts. Server-side StreamSession
      // coalesces messages arriving during an in-flight turn into a
      // single merged turn. ``0`` = disabled (preempt-on-each-message).
      // Voice/STT messages always bypass the window.
      coalesce_window_ms?: number;
      // When false, the session never invokes its TTS sidecar even if
      // a provider is configured. Chat-tab sessions pass false so typed
      // replies stay silent; voice-mode sessions keep the default.
      speak?: boolean;
      client_capabilities?: {
        attachments: boolean;
        ordered_parts: boolean;
        inline_ui: boolean;
        sidebar_ui: boolean;
        custom_ui_version: number;
      };
    }
  | { type: 'session_close'; session_id: string }
  | { type: 'text_delta'; session_id: string; text: string; final?: boolean }
  | {
      type: 'text_final';
      session_id: string;
      text: string;
      source?: 'user_typed' | 'stt' | 'system';
      attachments?: Attachment[];
    }
  | {
      type: 'audio_chunk_in';
      session_id: string;
      data: string;
      end_of_speech?: boolean;
      sample_rate?: number;
      encoding?: string;
    }
  | { type: 'audio_end_in'; session_id: string }
  | {
      type: 'video_frame';
      session_id: string;
      stream: string;
      data: string;
      width?: number;
      height?: number;
      keyframe?: boolean;
    }
  | {
      type: 'attachment';
      session_id: string;
      kind: 'image' | 'file' | 'voice' | 'video';
      artifact_id?: string;
      artifact_link_id?: string;
      url?: string;
      path?: string;
      filename?: string;
      mime_type?: string;
      size_bytes?: number;
      sha256?: string;
    }
  | {
      type: 'interrupt';
      session_id: string;
      reason?: 'user_speech' | 'user_text' | 'manual';
    }
  // ── Interactive terminals (PTY on the gateway host) ──
  // The "SSH terminal" surface: a real pseudo-terminal on the machine
  // running the OpenAgent server, driven live from the System tab. Each
  // ``terminal_id`` is one shell. ``data`` is base64-encoded raw bytes
  // so colour/cursor control sequences survive the JSON transport.
  | {
      type: 'terminal_open';
      terminal_id: string;
      cols: number;
      rows: number;
      cwd?: string;
      shell?: string;
    }
  | { type: 'terminal_input'; terminal_id: string; data: string }
  | { type: 'terminal_resize'; terminal_id: string; cols: number; rows: number }
  | { type: 'terminal_signal'; terminal_id: string; signal: 'INT' | 'TERM' | 'HUP' | 'QUIT' | 'KILL' }
  | { type: 'terminal_close'; terminal_id: string }
  | {
      type: 'ui_subscribe'; subscriptionId: string; viewId: string;
      /** Exact immutable layout/action revision for inline embeds. Omitted for
       * mutable sidebar pages; knownRevision is only a cache hint. */
      revision?: number;
      knownRevision?: number;
    }
  | { type: 'ui_unsubscribe'; subscriptionId: string }
  | {
      type: 'ui_action';
      subscriptionId: string;
      actionId: string;
      input?: unknown;
      idempotencyKey: string;
    };

export type ResourceKind = 'mcp' | 'scheduled_task' | 'workflow' | 'vault' | 'config' | 'session' | 'event' | 'ui_view';
export type ResourceAction = 'created' | 'updated' | 'deleted' | 'changed';

export type ServerMessage =
  | {
      type: 'auth_ok';
      agent_name: string;
      version: string;
      /** New gateways may inline discovery; older ones omit it. */
      capabilities?: CapabilitiesResponse;
    }
  | { type: 'auth_error'; reason: string }
  // Rehydration snapshot for a turn that is still live on the server.
  // Frames reuse the normal stream wire types (text_final/status/delta/etc.)
  // so clients can rebuild the not-yet-persisted tail without inventing a
  // parallel transcript shape.
  | { type: 'live_state'; session_id: string; active: boolean; frames: any[]; started_at?: number; updated_at?: number }
  | { type: 'status'; text: string; session_id: string }
  // ── Reasoning indicator (transient, session-scoped) ──
  // ``active=true`` while the agent is thinking with no visible output yet;
  // ``active=false`` once visible output starts OR the turn ends. The UI
  // swaps the static status row for an animated "Reasoning" shimmer while
  // active. Several may arrive per turn (true→false→true→false across
  // tool-call iterations). Transient — never persisted in the transcript.
  // ``seq``/``ts_ms`` ride along for ordering/debug; the UI only needs
  // ``active``. Clients also clear reasoning on the turn-final ``response``
  // frame as a safety net in case an explicit ``active=false`` is missed.
  | { type: 'reasoning'; session_id: string; active: boolean; seq?: number; ts_ms?: number }
  // Token-streaming frame for text-mode chat. Clients accumulate each
  // ``text`` chunk into the in-progress assistant bubble; the trailing
  // ``response`` is the canonical record (full text + attachments +
  // model meta) and replaces the streamed buffer. Older clients that
  // don't recognize ``delta`` ignore it and render the final
  // ``response`` like before — backward-compatible.
  | { type: 'delta'; text: string; session_id: string }
  | {
      type: 'response';
      text: string;
      session_id: string;
      attachments?: Attachment[];
      /** Ordered parts are additive; artifacts is accepted by the client as
       * the early-beta alias but new gateways should emit parts. */
      parts?: unknown[];
      artifacts?: unknown[];
      model?: string;
    }
  // The agent-self seed that opens a spawned child session (a delegated
  // sub-agent, a scheduled firing, a workflow node) — the task/mission/role
  // prompt. Streamed FIRST so a run screen shows the Mission block at the top
  // while it runs, not only once the run completes. ``author.kind === 'agent'``
  // makes it render as a Mission/Role/Task block rather than a "You" bubble.
  | { type: 'seed'; text: string; session_id: string; author?: MessageAuthor }
  // ``session_id`` is set by the gateway when the error originated from
  // a specific session's processing (see _process_message). Older client
  // builds tolerated its absence — keep it optional for back-compat.
  | { type: 'error'; text: string; session_id?: string }
  | { type: 'queued'; position: number }
  // ``context`` rides along on the /context command reply — the structured
  // window breakdown for rich clients; ``text`` already carries the same as
  // a monospace block for text-only surfaces. Additive & optional.
  | { type: 'command_result'; text: string; context?: SessionContext }
  // ── Live context-window composition (Claude-Code /context) ──
  // Pushed after each turn completes so an always-visible context panel
  // updates in realtime as the conversation grows. Same payload as
  // ``GET /api/sessions/{id}/context``. Clients that don't know it ignore it.
  | { type: 'context_report'; session_id: string; report: SessionContext; seq?: number; ts_ms?: number }
  | { type: 'pong' }
  | { type: 'agent_identity_changed'; name: string; revision: string }
  // Resource-change ping: a list the desktop app might be showing
  // moved on the server. Subscribed stores refetch on receipt.
  | { type: 'resource_event'; resource: ResourceKind; action: ResourceAction; id?: string }
  | HistoryChangedEvent
  | SearchIndexChangedEvent
  // Live host telemetry — emitted every ~2s by the gateway when at
  // least one client is connected. The System screen subscribes here
  // and re-renders without polling.
  | { type: 'system_snapshot'; snapshot: SystemSnapshot }
  // Streaming TTS frames for voice-mode replies. ``audio_start`` opens
  // the playback queue, ``audio_chunk`` carries one segment of audio
  // (base64 of MP3 frames by default — see ``mime``), ``audio_end``
  // closes it. The trailing ``response`` event still carries the full
  // text + attachments so non-audio-aware clients render unchanged.
  | { type: 'audio_start'; session_id: string; format: string; voice_id: string; mime: string }
  | { type: 'audio_chunk'; session_id: string; seq: number; data: string }
  | { type: 'audio_end'; session_id: string; total_chunks: number }
  // ── Stream protocol (additive) ──
  // ``turn_complete`` marks the end of one logical assistant turn for
  // batched-channel consumers; realtime clients can ignore it (the
  // ``response`` frame already drives "Thinking…" → "Done"). Backward
  // compat: clients that don't recognise these types ignore them.
  //
  // ``text_final`` echoes a recognised user utterance from streaming
  // STT — voice mode renders it as the user message in the transcript
  // without round-tripping through the legacy REST upload. ``source``
  // distinguishes user-typed (no UI update needed; chat already added
  // it) from STT (server-recognised — UI adds it now).
  //
  // ``reason`` says HOW the turn ended — 'completed' | 'error' | 'cancelled' |
  // 'empty' — with ``error`` carrying the text when it failed. A bare marker
  // could only say "it's over", so a turn that died and a turn that answered
  // looked identical and the app had to infer the difference from what did or
  // did not arrive next. An older gateway omits both fields: absent means
  // 'completed', which is exactly what the app assumed before.
  | { type: 'turn_complete'; session_id: string; reason?: 'completed' | 'error' | 'cancelled' | 'empty'; error?: string }
  // ── In-place session compaction (vision §2) ──
  // The agent folds older turns into a recap when the context fills up.
  // ``phase='running'`` fires before the (slow) summariser call so the UI
  // can show a "Compacting…" card; ``phase='done'`` once the fold lands
  // (with the run/token stats); ``phase='error'`` if the fold was skipped.
  // Rendered as a tool-style CompactionCard in the transcript. Backward
  // compat: clients that don't recognise this type ignore it.
  | {
      type: 'session_compacted';
      session_id: string;
      phase?: 'running' | 'done' | 'error';
      folded_runs?: number;
      kept_runs_count?: number;
      summary_chars?: number;
      tokens_before?: number;
      tokens_after?: number;
      seq?: number;
      ts_ms?: number;
    }
  | {
      type: 'text_final';
      session_id: string;
      text: string;
      source?: 'user_typed' | 'stt' | 'system';
      attachments?: Attachment[];
    }
  | {
      type: 'video_frame_out';
      session_id: string;
      stream: string;
      data: string;
      width?: number;
      height?: number;
    }
  // ── Interactive terminals ──
  // ``terminal_ready`` confirms the PTY spawned (pid + resolved shell).
  // ``terminal_output`` carries base64 raw bytes for xterm to render.
  // ``terminal_exit`` fires when the shell ends (one of exit_code/signal
  // is set). ``terminal_error`` covers open failures (e.g. unsupported
  // host OS). All are scoped by ``terminal_id``.
  | { type: 'terminal_ready'; terminal_id: string; pid: number | null; shell: string; cols: number; rows: number; cwd?: string }
  | { type: 'terminal_output'; terminal_id: string; data: string }
  | { type: 'terminal_exit'; terminal_id: string; exit_code: number | null; signal: string | null }
  | { type: 'terminal_error'; terminal_id: string; error: string }
  // OA-UI v1 realtime feed. Camel-case is canonical on the wire; the view
  // store accepts snake-case aliases from early beta gateways at runtime.
  | { type: 'ui_snapshot'; subscriptionId: string; view: unknown }
  | {
      type: 'ui_data'; subscriptionId: string; viewId: string; key: string;
      value: unknown; version: number; generation?: number; seq?: number;
    }
  | {
      type: 'ui_source_status'; subscriptionId: string; viewId: string; key: string;
      status: string; error?: { code?: string; message: string } | string;
      updatedAt?: string | number; generation?: number; seq?: number;
    }
  | { type: 'ui_view_changed'; viewId: string; revision: number; action?: string }
  | {
      type: 'ui_action_result'; subscriptionId?: string; viewId?: string;
      actionId?: string; result?: unknown; error?: unknown;
    }
  | {
      type: 'ui_error'; subscriptionId?: string; viewId?: string;
      code?: string; message: string;
    };

export type Attachment = AttachmentRef;

// ── Interactive terminal ──
// One live (or recently-closed) PTY shell on the gateway host. Returned
// by ``GET /api/terminals`` and tracked in the terminals store so the
// System tab can list sessions Termius-style.
export interface TerminalInfo {
  id: string;
  title: string;
  shell?: string;
  cwd?: string;
  pid?: number | null;
  /** ``pending`` = open frame sent, awaiting ready; ``running`` = live;
   *  ``exited`` = shell ended; ``error`` = failed to open. */
  status: 'pending' | 'running' | 'exited' | 'error';
  createdAt: number;
  /** Short epilogue once closed — e.g. "exited (code 0)" or the error. */
  detail?: string;
}

// ── Chat State ──

// Server-native ``ToolExecution.to_dict()`` shape — emitted verbatim
// on live STATUS frames and on the rehydration endpoint. Phase
// (running / completed / error) is derived locally in the UI from
// ``tool_call_error`` + presence of ``result``; the server does not
// synthesise a status enum on the wire.
//
// Additional fields (metrics, child_run_id, etc.) ride along through
// the index signature so future renderers can pick them up without
// another wire change.
export interface ToolInfo {
  tool_name: string;
  /** Compact normalized history can identify the real tool behind
   * ``tool_search_call_tool`` without re-exposing its arguments/result. */
  effective_tool_name?: string;
  effective_tool_server?: string;
  tool_call_id?: string;
  tool_args?: Record<string, any>;
  tool_call_error?: boolean | null;
  result?: string | null;
  /** Physical execution boundary, stamped by the server. Client-hosted calls
   *  always identify the exact certified device + boot instance; ordinary
   *  calls explicitly identify the OpenAgent server. */
  execution_host?: ToolExecutionHost;
  /** When this tool call spawned a delegated sub-agent that runs as its own
   *  full session, the server stamps the child session id (+ optional title /
   *  model). MessageList renders such a tool call as a DelegationCard that
   *  deep-links into the child session instead of a generic tool chip. */
  child_session_id?: string;
  child_session_title?: string;
  child_model?: string;
  /** Minimal ACL-checked link supplied by normalized transcript history. */
  run_target?: {
    kind: 'task' | 'workflow' | 'event';
    run_id: string;
    parent_id?: string | null;
  };
  [key: string]: any;
}

// Derive the chip's visual phase from the wire tool-execution fields.
// Errors take precedence (the ``result`` slot carries the error text
// in error frames — that's how live ``ToolCallErrorEvent`` rides
// through), otherwise a populated ``result`` flips the chip to
// "completed".
export function toolPhase(t: ToolInfo): 'running' | 'completed' | 'stopped' | 'error' {
  const status = String(t.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'interrupted') return 'stopped';
  if (t.tool_call_error) return 'error';
  if (t.result !== undefined && t.result !== null) return 'completed';
  return 'running';
}

// A delegated sub-agent's session id always embeds a ``::sub::`` (MCP
// delegate_task) or ``::member::`` (team member) marker after its parent's id
// — e.g. ``agent:dev:abc::member::opus::1f2e``. These sessions are hidden from
// the sidebar / history list (navigable only from the parent's delegation
// card), so the id pattern lets the app recognise and hide a child even before
// its origin metadata loads (e.g. a lazy stub built from a live stream frame).
const SUB_AGENT_MARKER = /::(?:sub|member)::/;

export function isSubAgentSessionId(id: string): boolean {
  return SUB_AGENT_MARKER.test(id);
}

/** The parent chat session id a sub-agent session belongs to (the prefix
 *  before its ``::sub::`` / ``::member::`` marker), or undefined if ``id`` is
 *  not a sub-agent session. Drives the "← parent" breadcrumb for a child
 *  opened straight from a deep link before its metadata has loaded. */
export function subAgentParentId(id: string): string | undefined {
  // Greedy capture so the LAST marker delimits the IMMEDIATE parent: a
  // sub-agent that itself delegates yields ``A::member::x::yy::sub::z::ww``,
  // whose real parent is ``A::member::x::yy``, not the root ``A``. Model ids
  // embed only single colons, never ``::``, so every ``::sub::``/``::member::``
  // is a genuine lineage boundary.
  const m = id.match(/^(.*)::(?:sub|member)::/);
  return m ? m[1] : undefined;
}

// Child-session origins that never appear as standalone sidebar / history
// rows: a delegated sub-agent (reachable from its parent's transcript card),
// a scheduled firing, workflow node, or event-prompt delivery (reachable from
// its run/execution screen). Mirrors the server's ``HIDDEN_CHILD_ORIGINS`` so
// both ends hide the same set. ``chat`` is the only origin that lists normally.
const HIDDEN_CHILD_ORIGINS = new Set(['delegation', 'scheduler', 'workflow', 'event']);

/** Whether a session should be hidden from the flat sidebar / history list
 *  (a spawned child — by loaded origin metadata or sub-agent id shape). */
export function isHiddenChildSession(s: { id: string; origin?: string }): boolean {
  return (!!s.origin && HIDDEN_CHILD_ORIGINS.has(s.origin)) || isSubAgentSessionId(s.id);
}

// ── Run-launch tool cards ────────────────────────────────────────────
// When a chat turn runs a scheduled task, workflow, or event (the agent calls
// the scheduler / workflow-manager / events-manager MCP), the resulting tool message
// renders as a navigable card into that run's execution screen — the run
// analogue of a DelegationCard. The MCP exposes these tools namespaced
// (``scheduler_run_scheduled_task_now`` / ``workflow_manager_run_workflow`` /
// ``events_manager_trigger_event``), so we match by suffix to stay robust to
// the server-name prefix.
const RUN_LAUNCH_SUFFIXES: { suffix: string; kind: 'task' | 'workflow' | 'event' }[] = [
  { suffix: 'run_scheduled_task_now', kind: 'task' },
  { suffix: 'run_workflow', kind: 'workflow' },
  { suffix: 'trigger_event', kind: 'event' },
];

export interface RunLaunchTarget {
  kind: 'task' | 'workflow' | 'event';
  /** The firing / workflow-run id to open (absent until the tool returns). */
  runId?: string;
  /** Owning task / workflow id, for the run screen's "open parent" link. */
  parentId?: string;
  /** Human label when the tool result carries one. */
  name?: string;
  /** ``running`` | ``success`` | ``failed`` | … from the tool result. */
  status?: string;
}

function parseToolResult(result: unknown): Record<string, any> | undefined {
  if (result == null) return undefined;
  if (typeof result === 'object') return result as Record<string, any>;
  if (typeof result === 'string') {
    try {
      const j = JSON.parse(result);
      return j && typeof j === 'object' ? (j as Record<string, any>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ── Effective-tool normalization (unwraps the deferred-tool dispatcher) ──
// In automations — and any run where the provider's upfront tool budget trims
// MCP tools — the agent reaches a tool indirectly through the tool-search
// dispatcher: ``tool_search_call_tool({server, tool, args})``. The persisted /
// streamed ToolExecution is then the GENERIC dispatcher, not the real tool, and
// the dispatcher's JSON coercion drops the inner result's structured
// ``child_session_id``. Card detection keys off the REAL tool, so we resolve it
// ONCE here and every detector (delegation, run-launch) shares the result — so
// the cards render identically on every screen (chat, scheduled run, workflow
// run) and at any delegation depth, no matter how the tool was invoked.
const TOOL_SEARCH_DISPATCHER = 'tool_search_call_tool';

export interface EffectiveTool {
  /** The real tool the agent invoked (unwrapped from the dispatcher). */
  tool_name: string;
  /** The MCP server the real tool lives on, when the call went through the
   *  deferred-tool dispatcher (``tool_search_call_tool({server, …})``).
   *  Undefined for a direct (upfront) tool call. Lets memory detection key
   *  off the server (``vault`` / ``vault-gate``) instead of guessing from
   *  the bare tool name. */
  server?: string;
  /** The real tool's arguments. */
  tool_args: Record<string, any>;
  /** The tool result verbatim — the dispatcher returns the inner result. */
  result?: string | null;
  tool_call_error?: boolean | null;
  /** Child session this call spawned — taken from the structured field, or
   *  (when the dispatcher dropped it) recovered from the inner result JSON,
   *  which the handler still echoes. */
  child_session_id?: string;
  child_session_title?: string;
  child_model?: string;
}

export function effectiveTool(t?: ToolInfo): EffectiveTool | undefined {
  if (!t) return undefined;
  const name = String(t.tool_name || '');
  if (name === TOOL_SEARCH_DISPATCHER) {
    const outer = t.tool_args || {};
    const innerName = String(t.effective_tool_name || outer.tool || '');
    const innerServer = String(t.effective_tool_server || outer.server || '');
    const innerArgs =
      outer.args && typeof outer.args === 'object'
        ? (outer.args as Record<string, any>)
        : {};
    const res = parseToolResult(t.result);
    return {
      tool_name: innerName || name,
      server: innerServer || undefined,
      tool_args: innerArgs,
      result: t.result,
      tool_call_error: t.tool_call_error,
      child_session_id:
        t.child_session_id || (res?.child_session_id as string) || undefined,
      child_session_title:
        t.child_session_title || (res?.child_session_title as string) || undefined,
      // Symmetric with the direct branch — the model surfaces as the card
      // TITLE via delegationTitle's args.model_id fallback, so no subtitle
      // fallback here (it would duplicate the title on the dispatched path).
      child_model: t.child_model,
    };
  }
  return {
    tool_name: name,
    tool_args: t.tool_args || {},
    result: t.result,
    tool_call_error: t.tool_call_error,
    child_session_id: t.child_session_id,
    child_session_title: t.child_session_title,
    child_model: t.child_model,
  };
}

// ── Delegation cards ─────────────────────────────────────────────────
// A delegation renders as a navigable DelegationCard (deep-links into the
// spawned sub-agent's child session) instead of a raw tool chip — even while
// still running. Detection lives here (shared) so every screen agrees.
const DELEGATION_TOOLS = new Set([
  'delegate_task_to_member', 'delegate_task', 'run_dream_mode',
]);

/** Whether a tool message should render as a DelegationCard. True when the call
 *  spawned a SUB-AGENT child session OR is a known delegation tool — unwrapping
 *  the dispatcher so a deferred-dispatched delegation is detected exactly like a
 *  direct one. A scheduler/workflow child session id is deliberately NOT a
 *  delegation (it renders as a RunLaunchCard via {@link runLaunchTarget}). */
export function isDelegationTool(t?: ToolInfo): boolean {
  const eff = effectiveTool(t);
  if (!eff) return false;
  return (
    (!!eff.child_session_id && isSubAgentSessionId(eff.child_session_id))
    || DELEGATION_TOOLS.has(eff.tool_name)
  );
}

/** The human title for a delegation card — child title, delegated member/model
 *  id, or a sensible default. */
export function delegationTitle(t?: ToolInfo): string {
  const eff = effectiveTool(t);
  if (!eff) return 'Sub-agent';
  const args = eff.tool_args;
  return (
    eff.child_session_title
    || String(args.member_id || args.model_id || '')
    || (eff.tool_name === 'run_dream_mode' ? 'Dream mode' : 'Sub-agent')
  );
}

/** The DelegationCard kind label ('dream mode' vs 'sub-agent'). */
export function delegationLabel(t?: ToolInfo): string {
  return effectiveTool(t)?.tool_name === 'run_dream_mode' ? 'dream mode' : 'sub-agent';
}

/** The run a scheduler / workflow / event CHILD SESSION id points at, parsed
 *  from its shape (``scheduler:{task}:{run}`` /
 *  ``workflow:{wf}:{run}:{node}`` / ``event:{event}:{delivery}``). The
 *  run segment equals the task_run / workflow_run / delivery id the run screen
 *  keys on, and ``{task}``/``{wf}``/``{event}`` is the parent. Lets a
 *  run-launch card deep-link WHILE
 *  the run is still in flight (before its blocking result returns) — either via
 *  the id the server re-streams onto the chip, or via the live child session the
 *  client already sees streaming. Returns undefined for any other id shape
 *  (e.g. a ``::sub::`` delegation, which is a DelegationCard, not a run). */
export function runTargetForChildSession(sid?: string): RunLaunchTarget | undefined {
  if (!sid) return undefined;
  const parts = sid.split(':');
  const kind: RunLaunchTarget['kind'] | undefined =
    parts[0] === 'scheduler' ? 'task'
      : parts[0] === 'workflow' ? 'workflow'
        : parts[0] === 'event' ? 'event'
          : undefined;
  if (!kind || parts.length < 3 || !parts[1] || !parts[2]) return undefined;
  return { kind, parentId: parts[1], runId: parts[2], status: 'running' };
}

/** The ``/runs/{id}`` route (path + query) for a run-launch target, or
 *  undefined if it has no run id yet. One builder so every caller (chat's
 *  push, the run screen's detached open) routes identically. */
export function runRoutePath(target: RunLaunchTarget): string | undefined {
  if (!target.runId) return undefined;
  const params = new URLSearchParams({ kind: target.kind });
  if (target.parentId) params.set('parentId', target.parentId);
  if (target.name) params.set('name', target.name);
  return `runs/${encodeURIComponent(target.runId)}?${params.toString()}`;
}

/** If this tool call launched a scheduled task / workflow run, the target to
 *  deep-link into — else undefined. ``runId`` is absent while the tool is
 *  still running (it arrives in the result), so the card renders as a
 *  non-clickable "running" card until then, mirroring DelegationCard. */
export function runLaunchTarget(t?: ToolInfo): RunLaunchTarget | undefined {
  // Reopened normalized transcripts do not expose tool args/results. The
  // server resolves those historical envelopes once, validates the target
  // against canonical run tables and the current ACL, then sends only this
  // identifier-only link. Prefer it over every legacy inference path.
  const canonical = t?.run_target;
  if (
    canonical
    && (canonical.kind === 'task' || canonical.kind === 'workflow' || canonical.kind === 'event')
    && typeof canonical.run_id === 'string'
    && canonical.run_id.length > 0
  ) {
    return {
      kind: canonical.kind,
      runId: canonical.run_id,
      parentId: typeof canonical.parent_id === 'string' && canonical.parent_id
        ? canonical.parent_id
        : undefined,
      status: t?.status ? String(t.status) : undefined,
    };
  }
  // Unwrap the deferred-tool dispatcher so a run-now invoked via
  // ``tool_search_call_tool`` is matched by its REAL tool name, exactly like a
  // direct call — the run card then appears on every screen regardless of how
  // the agent reached the tool.
  const eff = effectiveTool(t);
  const name = eff?.tool_name || '';
  if (!eff || !name) return undefined;
  // A tool-level failure (timeout / bad id) carries the error TEXT in
  // ``result`` (non-JSON), not a run row — let it fall through to the generic
  // ToolCard, which surfaces the error, instead of a stuck "running…" card.
  if (eff.tool_call_error) return undefined;
  const match = RUN_LAUNCH_SUFFIXES.find(
    (m) => name === m.suffix || name.endsWith('_' + m.suffix),
  );
  if (!match) return undefined;
  const res = parseToolResult(eff.result);
  const args = eff.tool_args;
  // The run id arrives in the result only when the (blocking) run-now tool
  // finishes. While it runs, recover it from the spawned child session id —
  // ``scheduler:{task}:{run}`` / ``workflow:{wf}:{run}:{node}`` — which the
  // server re-streams onto the in-flight chip, so the card is clickable
  // mid-run (matching the DelegationCard affordance).
  const fromSid = runTargetForChildSession(
    eff.child_session_id || (res?.session_id as string) || undefined,
  );
  const runId =
    match.kind === 'event'
      ? (res?.delivery_id || res?.id || fromSid?.runId || undefined)
      : (res?.id || res?.run_id || fromSid?.runId || undefined);
  // Prefer a resolved parent ID (the tool result, or the linked child session
  // id) over the raw ``id_or_name`` argument: a workflow run-now is usually
  // invoked by NAME, but the run screen routes its parent by id — so falling
  // back to the name would point the parent-open link at a non-existent id.
  const parentId =
    (match.kind === 'task'
      ? res?.task_id || fromSid?.parentId || args.task_id
      : match.kind === 'workflow'
        ? res?.workflow_id || fromSid?.parentId || args.id_or_name
        : res?.event_id || fromSid?.parentId || args.id_or_slug)
    || undefined;
  return {
    kind: match.kind,
    runId: runId ? String(runId) : undefined,
    parentId: parentId ? String(parentId) : undefined,
    name: res?.name ? String(res.name) : undefined,
    status: res?.status ? String(res.status) : 'running',
  };
}

// ── Friendly tool presentation ───────────────────────────────────────
// Raw tool names ("vault_write_note", "shell_shell_exec", the unwrapped
// "read_note") are an implementation detail. The chip shows a human verb
// instead — and memory-vault operations get first-class, on-brand copy
// ("Recalling", "Memorizing", "Forgetting", …). The raw name + args stay
// available in the expanded card body for debugging (see ToolCard).

export interface ToolDisplay {
  /** The user-facing verb shown on the chip ("Recalling", "Running command"). */
  title: string;
  /** Optional secondary detail after the title — the note title, file path,
   *  or query the tool is acting on. */
  detail?: string;
  /** Feather icon name for the chip. */
  icon: string;
  /** True for memory-vault operations — drives the "open in Memory" link
   *  affordance and the chip's accent tint. */
  isMemory: boolean;
}

/** Whether a dispatcher ``server`` arg names the memory vault. */
function isMemoryServer(s?: string): boolean {
  if (!s) return false;
  const x = s.toLowerCase();
  return x === 'vault' || x.startsWith('vault') || x.includes('memory');
}

/** Reduce a tool name to its bare operation by stripping the MCP server
 *  prefix, so the upfront-prefixed ``vault_read_note`` and the
 *  dispatcher-unwrapped ``read_note`` map to the same op. */
function memoryOp(name: string): string {
  return name
    .toLowerCase()
    .replace(/^vault[_-]gate[_-]/, '')
    .replace(/^vaultgate[_-]/, '')
    .replace(/^vault[_-]/, '')
    .replace(/^memory[_-]search[_-]/, '');
}

// Memory op → friendly verb + icon. Keyed by the bare op (see ``memoryOp``);
// a few ops carry aliases (obsidian-MCP raw name vs the vault-gate name).
const MEMORY_VERBS: Record<string, { title: string; icon: string }> = {
  read_note: { title: 'Recalling', icon: 'book-open' },
  read_multiple_notes: { title: 'Recalling', icon: 'book-open' },
  get_frontmatter: { title: 'Reading memory details', icon: 'info' },
  write_note: { title: 'Memorizing', icon: 'edit-3' },
  patch_note: { title: 'Updating memory', icon: 'edit-3' },
  update_frontmatter: { title: 'Updating memory', icon: 'edit-3' },
  update_user_memory: { title: 'Updating memory', icon: 'edit-3' },
  validate_note: { title: 'Checking memory', icon: 'check-circle' },
  delete_note: { title: 'Forgetting', icon: 'trash-2' },
  move_note: { title: 'Reorganizing memory', icon: 'shuffle' },
  rename_note: { title: 'Renaming memory', icon: 'shuffle' },
  search_notes: { title: 'Searching memory', icon: 'search' },
  search: { title: 'Searching memory', icon: 'search' },
  list_notes: { title: 'Browsing memory', icon: 'list' },
  list_all_tags: { title: 'Memory tags', icon: 'tag' },
  manage_tags: { title: 'Tagging memory', icon: 'tag' },
  get_backlinks: { title: 'Tracing memory links', icon: 'link-2' },
  backlinks: { title: 'Tracing memory links', icon: 'link-2' },
  get_vault_stats: { title: 'Memory stats', icon: 'bar-chart-2' },
  stats: { title: 'Memory stats', icon: 'bar-chart-2' },
  gate: { title: 'Auditing memory', icon: 'shield' },
  doctor: { title: 'Healing memory', icon: 'activity' },
  dream: { title: 'Memory maintenance', icon: 'moon' },
  init: { title: 'Setting up memory', icon: 'database' },
  regenerate_derived: { title: 'Rebuilding memory index', icon: 'refresh-cw' },
};

/** Whether a tool call is a memory-vault operation (by server or name). */
export function isMemoryTool(t?: ToolInfo): boolean {
  const eff = effectiveTool(t);
  if (!eff) return false;
  const name = eff.tool_name.toLowerCase();
  return (
    isMemoryServer(eff.server)
    || name === 'update_user_memory'
    || /(^|[_-])(vault|note)(s)?([_-]|$)/.test(name)
    || memoryOp(eff.tool_name) in MEMORY_VERBS
  );
}

// General (non-memory) tools: a small verb map keyed by a substring of the
// bare op, plus a Title-Case fallback. Keeps common tools readable without
// an exhaustive registry. Order matters — first match wins.
const GENERAL_VERBS: { test: RegExp; title: string; icon: string }[] = [
  { test: /(^|_)(bash|shell|exec|run_command|terminal)/, title: 'Running command', icon: 'terminal' },
  { test: /(web[_-]?search|search_web)/, title: 'Searching the web', icon: 'globe' },
  { test: /(fetch|http|browse|navigate|open_url|web)/, title: 'Browsing the web', icon: 'globe' },
  { test: /(read_file|read_multiple_files|^read$|cat_file|view_file)/, title: 'Reading file', icon: 'file-text' },
  { test: /(write_file|^write$|str_replace|edit_file|^edit$|apply_patch|create_file)/, title: 'Editing file', icon: 'edit-3' },
  { test: /(list_dir|list_files|^ls$|glob|find_files)/, title: 'Listing files', icon: 'folder' },
  { test: /(grep|ripgrep|search_code|search_files)/, title: 'Searching files', icon: 'search' },
  // Attaching a file is its own act, and the chip is the only place the user
  // sees it happen: labelling ``send_file_to_user`` "Sending message" read as
  // if the agent had written to someone, right as it delivered a picture into
  // the transcript. Keep it ahead of the generic messaging rule below.
  { test: /send_file/, title: 'Attaching file', icon: 'paperclip' },
  { test: /(send_message|messaging|notify|email)/, title: 'Sending message', icon: 'send' },
  { test: /(image|media|generate|render|draw)/, title: 'Generating media', icon: 'image' },
];

/** Title-Case a snake/kebab tool name as a last-resort label. */
function titleCase(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Tool';
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Extract the most relevant arg value to show as the chip's detail line. */
function detailFromArgs(op: string, args: Record<string, any>): string | undefined {
  // Memory: the note this op targets (shown by basename, sans .md).
  for (const k of ['new_path', 'path', 'note_path', 'filepath', 'filename']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return noteTitle(v);
  }
  // Searches / queries.
  for (const k of ['query', 'q', 'pattern', 'search', 'text']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return `“${v.length > 48 ? v.slice(0, 48) + '…' : v}”`;
  }
  // The agent's own-memory update carries a free-text task.
  if (op === 'update_user_memory') {
    const v = args.task ?? args.instruction;
    if (typeof v === 'string' && v.trim()) return v.length > 48 ? v.slice(0, 48) + '…' : v;
  }
  return undefined;
}

/** Friendly label + icon for a tool chip. Memory-vault ops get bespoke
 *  verbs; everything else gets a common-verb match or a Title-Case fallback. */
export function toolDisplay(t?: ToolInfo): ToolDisplay {
  const eff = effectiveTool(t);
  if (!eff || !eff.tool_name) return { title: 'Tool', icon: 'tool', isMemory: false };
  const args = eff.tool_args || {};
  const memory = isMemoryTool(t);
  if (memory) {
    const op = memoryOp(eff.tool_name);
    const verb = MEMORY_VERBS[op] || { title: 'Memory', icon: 'database' };
    return {
      title: verb.title,
      detail: detailFromArgs(op, args),
      icon: verb.icon,
      isMemory: true,
    };
  }
  const lower = eff.tool_name.toLowerCase();
  const match = GENERAL_VERBS.find((g) => g.test.test(lower));
  if (match) {
    return { title: match.title, detail: detailFromArgs('', args), icon: match.icon, isMemory: false };
  }
  // Fallback: humanize the raw name, noting the MCP server when dispatched.
  const base = titleCase(eff.tool_name);
  return {
    title: eff.server ? `${base} · ${titleCase(eff.server)}` : base,
    icon: 'tool',
    isMemory: false,
  };
}

/** The basename of a note path without its ``.md`` extension — the label
 *  shown for a memory op and the link target's display. */
function noteTitle(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(/\.md$/i, '');
}

// ── Memory-vault navigation target ───────────────────────────────────
// A memory tool chip deep-links into the Memory tab: a single-note op opens
// that note's markdown screen (the same destination as clicking its graph
// node); a search / list / maintenance op opens the memory graph. Mirrors
// the DelegationCard / RunLaunchCard navigable-chip pattern.

export type MemoryTarget =
  | { kind: 'note'; path: string; title: string }
  | { kind: 'graph' };

export function memoryTarget(t?: ToolInfo): MemoryTarget | undefined {
  if (!isMemoryTool(t)) return undefined;
  const eff = effectiveTool(t)!;
  const args = eff.tool_args || {};
  // Prefer the post-move path so a rename links to the note's new home.
  for (const k of ['new_path', 'path', 'note_path', 'filepath', 'filename']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return noteTargetFor(v.trim());
  }
  // read_multiple_notes takes an array; link to the first if present.
  const paths = args.paths;
  if (Array.isArray(paths) && typeof paths[0] === 'string' && paths[0].trim()) {
    return noteTargetFor(paths[0].trim());
  }
  // No specific note (search / list / stats / maintenance) — open the graph.
  return { kind: 'graph' };
}

/** Build a note target, normalizing the vault-relative path to match the
 *  graph node id / note route (which always carry the ``.md`` extension —
 *  see the server's ``/api/vault/graph`` ``rel`` and ``/api/vault/notes``).
 *  The model occasionally drops the extension; append it so the deep link
 *  still resolves. */
function noteTargetFor(raw: string): MemoryTarget {
  const last = raw.split('/').pop() || raw;
  const path = last.includes('.') ? raw : `${raw}.md`;
  return { kind: 'note', path, title: noteTitle(path) };
}

/** Friendly, phase-aware label + detail for a compaction card. ``running``
 *  shows the in-progress copy; ``done`` summarises the fold (turns folded and,
 *  when known, the context freed); ``error`` reports the skip. Mirrors
 *  ``toolDisplay`` in spirit so the compaction card reads like a tool chip. */
export function compactionDisplay(info: CompactionInfo): { title: string; detail?: string } {
  if (info.phase === 'running') return { title: 'Compacting conversation…' };
  if (info.phase === 'error') return { title: 'Compaction skipped' };
  const folded = info.foldedRuns ?? 0;
  // A manual /compact on a conversation too short to fold reports done with
  // zero folded runs — surface it as an explicit "nothing to do" so the
  // command never looks like it silently failed.
  if (folded === 0) return { title: 'Already compact — nothing to fold' };
  const freed = (info.tokensBefore ?? 0) - (info.tokensAfter ?? 0);
  const bits: string[] = [];
  bits.push(`${folded} turn${folded === 1 ? '' : 's'} folded`);
  if (freed > 0) bits.push(`~${freed.toLocaleString()} tokens freed`);
  return { title: 'Compacted conversation', detail: bits.join(' · ') || undefined };
}

/** Who authored a message. ``human`` carries a network handle/display so the
 *  app shows the real sender (and multi-human sessions attribute correctly);
 *  ``agent`` marks an agent-self seed — the delegated task / scheduled mission
 *  / workflow node prompt the agent gave itself — rendered as a Mission block
 *  rather than a "You" bubble. Absent on legacy messages → falls back to role. */
export interface MessageAuthor {
  kind: 'human' | 'agent';
  handle?: string;
  display?: string;
}

/** In-place compaction (vision §2) rendered as a transcript entry. Live,
 *  it's driven by the ``session_compacted`` wire frame (running → done);
 *  on reopen it's rebuilt from the recap run's persisted stats. ``phase``
 *  drives the card's spinner/label; the counts populate the expanded body. */
export interface CompactionInfo {
  phase: 'running' | 'done' | 'error';
  /** Older turns folded into the recap. */
  foldedRuns?: number;
  /** Recent turns kept verbatim (recap + last N). */
  keptRuns?: number;
  /** Length of the recap paragraph the model produced. */
  summaryChars?: number;
  /** Estimated tokens of the folded turns / the recap that replaced them.
   *  ``tokensBefore - tokensAfter`` is roughly the context freed. */
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface ChatMessage {
  providerRunId?: string;
  sharedTurnId?: string;
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'compaction';
  text: string;
  timestamp: number;
  attachments?: Attachment[];
  /** Ordered rich response parts. Absent on stable/legacy gateways, in which
   * case renderers preserve the historical text-then-attachments order. */
  parts?: MessagePart[];
  toolInfo?: ToolInfo;
  /** Set on ``role: 'compaction'`` messages — the compaction card payload. */
  compactionInfo?: CompactionInfo;
  model?: string;
  /** Per-message authorship (see MessageAuthor). */
  author?: MessageAuthor;
  // True while the assistant bubble is being progressively populated
  // by ``delta`` frames. The trailing ``response`` clears the flag and
  // replaces ``text`` with the canonical clean version (strips the
  // attachment markers ``parse_response_markers`` extracted on the
  // server side). Used by MessageList to render a soft caret / cursor.
  streaming?: boolean;
  /** Durable v2 transcript ordering/status. Absent on legacy run rows. */
  ordinal?: number;
  durableStatus?: MessageStatus;
  completeness?: Completeness;
  /** Canonical operational-search anchor, distinct from legacy tool_call_id. */
  toolInvocationId?: string;
}

export interface ChatSession {
  /** An explicit access withdrawal clears every transcript projection. */
  accessRevoked?: boolean;
  sharedSnapshot?: import('./collaboration').SharedSnapshot;
  id: string;
  title: string;
  messages: ChatMessage[];
  isProcessing: boolean;
  /** Persisted session creation time (epoch seconds). Present after the
   *  authorized session summary has been hydrated; a brand-new local draft
   *  has no server timestamp yet. */
  createdAt?: number;
  /** Provider metadata exposed by ``GET /api/sessions``. These are display
   *  hints only; ``contextUsage.model`` remains authoritative for the model
   *  that actually served the current context window. */
  model?: string;
  framework?: string;
  statusText?: string;
  /** Driven by the transient ``reasoning`` wire frame: true while the agent
   *  is thinking with no visible output yet. Swaps the static status row for
   *  the animated <ReasoningIndicator/>. Cleared on the first streamed delta,
   *  the turn-final response, and on error (safety net). */
  isReasoning?: boolean;
  /** When this session was spawned by another (a delegated sub-agent, a
   *  scheduled-task firing, or a workflow AI node), the parent it belongs to —
   *  drives the "← parent" breadcrumb and lets the sidebar tag it. */
  parentSessionId?: string;
  /** What spawned this session: 'chat' (a normal conversation) | 'delegation'
   *  | 'scheduler' | 'workflow' | 'event'. Renders as an origin chip in the
   *  sidebar / breadcrumb where relevant. */
  origin?: 'chat' | 'delegation' | 'scheduler' | 'workflow' | 'event';
  /** Fine-grained origin label (the delegated model id, the task id, etc.). */
  originLabel?: string;
  /** Server-reported last-activity epoch (seconds). Preserved through
   *  hydration so the sidebar can sort sessions by recency; falls back to
   *  the newest message timestamp when absent. */
  lastActiveAt?: number;
  /** Sticky session — sorted to the top of the sidebar regardless of recency. */
  pinned?: boolean;
  /** Per-session composer draft (text). Survives session switches but
   *  not full app restarts. */
  draftInput?: string;
  /** Set to true by the delta/response reducer when a non-active
   *  session receives a new assistant message. Cleared when the user
   *  brings that session to focus. Drives the sidebar dot indicator. */
  hasUnread?: boolean;
  /** Optional LLM pin (e.g. "claude-opus-4-7"). When set, gets sent
   *  with the next ``session_open`` — composer picker mutates this
   *  + closes any open WS session so the next message lands on the
   *  newly-pinned model. ``undefined`` = let the router pick. */
  llmPin?: string;
  /** Optional system prompt for this session. Currently surfaced as
   *  the first user-tagged frame after session open, since the
   *  gateway has no first-class ``system_prompt`` field. */
  systemPrompt?: string;
  /** Live context-window composition for the always-visible /context panel.
   *  Set from the ``context_report`` frame (pushed each turn) and the
   *  ``GET /api/sessions/{id}/context`` fetch on activation/reconcile.
   *  Applies to every session kind — chat, sub-agent, scheduled firing,
   *  workflow AI node — since they are all ordinary sessions. */
  contextUsage?: SessionContext;
  /** Cursor/range metadata from the v2 messages-around endpoint. */
  messageWindow?: {
    revision: string;
    beforeCursor: string | null;
    afterCursor: string | null;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
  };
}

// ── System telemetry ──

// Mirror of the dict produced by openagent/gateway/api/system.py.
// Cross-platform: same shape on Windows, macOS, Linux. Values from
// psutil are byte counts (memory, disk, network); the UI converts
// to human units. Fields that the host doesn't expose surface as
// 0 or null rather than being omitted, so consumers can render a
// stable layout.
export interface SystemSnapshot {
  timestamp: number;
  host: SystemHost;
  cpu: SystemCpu;
  memory: SystemMemory;
  swap: SystemSwap;
  disks: SystemDisk[];
  network: SystemNetwork;
  processes: SystemProcess[];
}

export interface ClaudeStatus {
  binary_ok: boolean;
  binary_path: string | null;
  auth_ok: boolean;
  auth_email: string | null;
  auth_type: string | null;
}

export interface ClaudeInstallResult {
  binary_ok: boolean;
  binary_path?: string;
  auth_ok: boolean;
  auth_email?: string;
  auth_type?: string;
  error?: string;
}

export interface ClaudeAuthLoginResult {
  ok: boolean;
  pid?: number;
  detail?: string;
  error?: string;
}

export interface SystemHost {
  hostname: string;
  platform: string;          // 'Darwin' | 'Linux' | 'Windows'
  os: string;                // human-readable, e.g. 'macOS 15.2', 'Windows 11'
  release: string;
  arch: string;              // 'arm64', 'x86_64', ...
  uptime_seconds: number;
  boot_time: number;         // epoch seconds
  loadavg: [number, number, number];
  users: number;
  python_version: string;
  openagent_version: string;
}

export interface SystemCpu {
  model: string;
  cores_physical: number;
  cores_logical: number;
  freq_mhz: number;
  freq_min_mhz: number;
  freq_max_mhz: number;
  usage_pct: number;
  per_core_pct: number[];
  temp_c: number | null;     // null when sensors unavailable (typical on Windows/macOS)
}

export interface SystemMemory {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  free_bytes: number;
  cached_bytes: number | null;  // Linux-only
  percent: number;
}

export interface SystemSwap {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  percent: number;
}

export interface SystemDisk {
  mount: string;
  device: string;
  fs: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  percent: number;
}

export interface SystemNetwork {
  primary_iface: string;
  ipv4: string;
  ipv6: string;
  rx_bytes_total: number;
  tx_bytes_total: number;
  rx_bps: number;            // bytes/sec, computed across snapshots
  tx_bps: number;
  connections: number;
}

export interface SystemProcess {
  pid: number;
  name: string;
  user: string;
  cpu_pct: number;
  rss_bytes: number;
  threads: number;
  status: string;
}

// ── Connection ──
//
// The legacy {host, port, token} shape is gone. Connections are now
// addressed by ``handle@network`` and authenticated via a device cert
// minted by the network's coordinator. The Electron main process runs
// a ``openagent network loopback`` child for each active account; that
// child binds a localhost port that proxies HTTP/WS traffic onto the
// Iroh transport. The renderer keeps using ``fetch`` / ``WebSocket``
// against ``localhost:<sidecarPort>``.
//
// First-time onboarding only needs: a ticket string + (for user-role
// tickets) a chosen handle + a password. Coordinator NodeId, network
// name, network ID, and invite code are all packed into the ticket.

export interface ConnectionConfig {
  name: string;                  // display label (e.g. "Personal")
  network: string;               // network short name (e.g. "homelab")
  handle: string;                // user handle within that network
  agentHandle?: string;          // active agent (default: first registered)
  // Set by the Electron main process after it spawns the loopback
  // sidecar — the renderer never picks this; it just hits the URL.
  sidecarPort?: number;
  isLocal: boolean;              // hint: same-machine vs. remote agent
}

export interface SavedAccount extends ConnectionConfig {
  id: string;          // unique identifier
  createdAt: number;   // epoch ms
  inviteCode?: string; // oa1… ticket used when joining (stored for reference)
}

// Inputs the onboarding screen collects to add a new account. The
// renderer doesn't see coordinator NodeIds or network IDs — those
// come from the ticket and are pinned by the loopback child.
export interface JoinNetworkInput {
  ticket: string;     // pasted oa1… string from `openagent network invite`
  handle: string;     // user-chosen for role=user; ignored for role=device
  password: string;   // PAKE secret, sent over IPC+stdin only
  displayName?: string; // optional friendly label saved on the account row
}

// ── Config ──

// OpenAgent v0.12 vocabulary:
//   - provider row = (name, framework) pair with a surrogate integer id
//
// The server collapsed the legacy ``'agno'`` and ``'litellm'`` values
// into ``'api-based'`` in v0.14. The desktop normalises any stray
// ``'agno'`` payload at the read boundary in services/api.ts so the
// rest of the app only sees the canonical names below.
export type ModelFramework = 'api-based' | 'litellm';
// ``llm`` covers the existing text-generation rows; ``tts`` covers
// audio synthesis providers (ElevenLabs in v1). The LLM dispatcher
// filters to ``kind='llm'`` so a TTS row never gets handed a turn.
export type ProviderKind = 'llm' | 'tts' | 'stt';

export interface ProviderConfig {
  id: number;
  name: string;
  framework: ModelFramework;
  kind: ProviderKind;
  api_key_display: string;    // "****abcd" | "${VAR}" | "—"
  base_url: string | null;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  created_at?: number;
  updated_at?: number;
}

export interface ModelCatalogEntry {
  model_id: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
}

export interface DailyUsageEntry {
  date: string;
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface ModelsResponse {
  // v0.12: flat list — dict-by-name would collide when the same vendor
  // is registered under both frameworks.
  models: ProviderConfig[];
}

export interface UsageData {
  monthly_spend: number;
  monthly_budget: number;
  remaining: number | null;
  by_model: Record<string, number>;
}

/** One slice of the context-window composition (Claude-Code /context).
 *  ``key`` is a stable id ('system'|'tools'|'messages'|'summary'|'free')
 *  used to pick a color; ``pct`` is a share of the whole window (0..100). */
export interface SessionContextSection {
  key: string;
  label: string;
  tokens: number;
  pct: number;
}

/** Per-session context-window usage — the shape returned by
 *  ``GET /api/sessions/{id}/context``, carried on the ``command_result``'s
 *  ``context`` field, and pushed live as the ``context_report`` frame.
 *  One contract shared by the app panel, the CLI table, and chat channels.
 *  See server ``src/core/context_report.py``. Numeric fields default to 0
 *  (the server omits zero/None), so treat absent values as 0. */
/** A session's durable model pin, as the server stores it.
 *
 *  ``runtime_id: null`` means the session is unpinned and the router
 *  resolves the entry model normally. ``side`` is a legacy field the
 *  gateway still returns as null; it carries no meaning since v0.14. */
export interface SessionModelPin {
  session_id: string;
  runtime_id: string | null;
  side?: string | null;
}

export interface SessionContext {
  session_id: string;
  /** Runtime id of the model that owns this session, e.g. "anthropic:claude-opus-4-8". */
  model?: string;
  /** Bare model id for display. */
  model_label?: string;
  /** Total context window in tokens (the gauge denominator). */
  context_window: number;
  /** 'fallback' => the window is an estimate (model absent from the pricing catalog). */
  window_source?: 'openrouter' | 'fallback';
  /** Sum of non-free section tokens (the filled portion of the gauge). */
  used_tokens?: number;
  free_tokens?: number;
  used_pct?: number;
  /** Authoritative last-turn input tokens billed by the provider (0 if none yet). */
  measured_input_tokens?: number;
  sections: SessionContextSection[];
  /** Cumulative session cost in USD (null when pricing is unavailable). */
  cost_usd?: number | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  cache_read_tokens?: number;
  reasoning_tokens?: number;
  pricing_available?: boolean;
  turns?: number;
}

export interface McpServerConfig {
  name: string;
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  oauth?: boolean;
  args?: string[];
}

// ── DB-backed registries (mcps + models tables) ──
// Managed via /api/mcps and /api/models/db — the ``mcps`` and ``models``
// SQLite tables are the source of truth. The ``mcps`` table is seeded
// from any legacy yaml ``mcp:`` entries once on first boot.

export interface MCPEntry {
  name: string;
  kind: 'builtin' | 'custom' | 'default';
  builtin_name?: string | null;
  command?: string[] | null;
  args: string[];
  url?: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  oauth: boolean;
  enabled: boolean;
  source: string;
  created_at: number;
  updated_at: number;
}

// OpenAgent model-catalog vocabulary (v0.12+):
//   provider_id   = FK to providers.id — authoritative.
//   provider_name = the vendor (anthropic, openai, google, zai, …).
//                   Denormalised on the response for rendering.
//   framework     = inherited from the provider row ("api-based").
//                   Same reason: denormalised for the UI.
//   model         = bare vendor id (gpt-4o-mini, claude-sonnet-4-6, …).
//   runtime_id    = derived string used in session pins and entry-model
//                   resolution; computed server-side from
//                   (provider_name, model, framework).
export interface ModelEntry {
  id: number;
  provider_id: number;
  provider_name: string;
  framework: ModelFramework;
  // Capability discriminator. ``llm`` rows go through the router;
  // ``tts`` / ``stt`` rows are picked by the audio resolvers and
  // dispatched via LiteLLM.
  kind: ProviderKind;
  runtime_id: string;
  model: string;
  display_name?: string | null;
  input_cost_per_million?: number | null;
  output_cost_per_million?: number | null;
  tier_hint?: string | null;
  enabled: boolean;
  // The user's persistent "default router" hint: when true, this row is
  // the entry model that leads the turn — it answers directly or
  // delegates to the other enabled models. No classifier call is
  // involved; entry resolution is a lookup (per-session pin → first row
  // flagged here in catalog order → first enabled). Multiple rows may
  // carry the flag, but only the first enabled one leads; the rest are
  // ordered fallbacks for when it's disabled. The field name is a
  // leftover from the retired classifier router and is fixed by the
  // wire contract — it does not mean a classifier runs.
  is_classifier?: boolean;
  provider_enabled?: boolean;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

// ── Family + effort ──────────────────────────────────────────────────
//
// The picker used to be one flat list of every runtime id, which asks the
// reader to hold two unrelated questions at once: WHOSE subscription pays
// (the scarce thing — each has its own window, and the "% left" hint next to
// it is why) and HOW HARD the model should think. Grouping by family answers
// the first once per group; the effort label answers the second per row.
//
// Declared in the model's ``metadata`` when the operator has said so
// (``family`` / ``effort``); inferred from the runtime id otherwise, so a
// catalogue nobody has annotated still groups correctly.
export type ModelEffort = 'light' | 'standard' | 'high' | 'max';

const EFFORT_ORDER: ModelEffort[] = ['light', 'standard', 'high', 'max'];

export function modelEffortRank(effort: ModelEffort): number {
  const i = EFFORT_ORDER.indexOf(effort);
  return i < 0 ? EFFORT_ORDER.length : i;
}

/** Which subscription/pool pays for this row. */
export function modelFamily(m: { runtime_id: string; provider_name?: string; metadata?: Record<string, unknown> }): string {
  const declared = (m.metadata?.family as string | undefined)?.trim();
  if (declared) return declared;
  const id = (m.runtime_id || '').toLowerCase();
  if (id.includes('claude')) return 'Claude';
  if (id.includes('gpt') || id.startsWith('codex:')) return 'GPT';
  if (id.includes('qwen') || id.startsWith('windows-local:')) return 'Local';
  if (id.includes('deepseek')) return 'DeepSeek';
  return m.provider_name || 'Other';
}

/** How hard this row thinks, within its family. */
export function modelEffort(m: { runtime_id: string; metadata?: Record<string, unknown> }): ModelEffort {
  const declared = (m.metadata?.effort as string | undefined)?.trim().toLowerCase();
  if (declared && (EFFORT_ORDER as string[]).includes(declared)) return declared as ModelEffort;
  const id = (m.runtime_id || '').toLowerCase();
  // Ordered longest-match first: "sol-high" must not read as "sol".
  if (id.includes('-high') || id.includes('opus')) return 'high';
  if (id.includes('haiku') || id.includes('flash') || id.includes('spark') || id.includes('mini')) return 'light';
  if (id.includes('sonnet') || id.includes('luna') || id.includes('sol')) return 'standard';
  return 'standard';
}

export interface AvailableModel {
  id: string;
  display_name: string;
  runtime_id?: string;
  added?: boolean;
  // Inferred by ``discovery.py`` from the model id (``tts-1`` → tts,
  // ``whisper-1`` → stt). The Add Model flow forwards this to
  // /api/models so the row lands with the correct ``kind``.
  kind?: ProviderKind;
}

// Source-of-truth yaml fields. Providers, models, MCPs, and scheduled
// tasks are DB-backed and live in SQLite — reach them via their
// dedicated REST endpoints (``/api/providers``, ``/api/models``,
// ``/api/mcps``, ``/api/scheduled-tasks``), not through this shape.
export interface AgentConfig {
  name?: string;
  system_prompt?: string;
  dream_mode?: { enabled: boolean; time: string };
  auto_update?: { enabled: boolean; mode: string; check_interval: string };
  channels?: Record<string, any>;
  services?: Record<string, any>;
  memory?: { db_path?: string; vault_path?: string };
}

export interface AgentIdentity {
  name: string;
  /** User-defined persona layer, never OpenAgent's framework prompt. */
  system_prompt: string;
  revision: string;
  framework_prompt_mutable: false;
  restart_required?: boolean;
  effective?: 'next_turn';
  changed?: Array<'name' | 'system_prompt'>;
}

// ── REST API — vault, config ──

export interface VaultNote {
  path: string;
  title: string;
  tags: string[];
  modified: string;
  content?: string;
}

export interface GraphData {
  nodes: { id: string; label: string; tags: string[] }[];
  edges: { source: string; target: string }[];
}

// ── Vault search types ──

/** One match within a file from ``/api/vault/search/in-file``. */
export interface InFileMatch {
  line: number;
  col: number;
  text: string;
}

/** Result of ``GET /api/vault/search/in-file?path=…&q=…``. */
export interface InFileSearchResult {
  path: string;
  matches: InFileMatch[];
  count: number;
}

// ── Vault write / move / history / gate ──

// One validation finding surfaced by the gateway when a note is written.
// ``fixable`` notes can be auto-corrected by ``runVaultDoctor(true)``.
export interface VaultWarning {
  rule: string;
  severity: string;
  message: string;
  fixable?: boolean;
}

// Response of ``PUT /api/vault/notes/{path}`` — the write is validated
// and git-committed server-side, so the body carries any warnings plus
// the commit hash (``null`` when nothing changed).
export interface VaultWriteResult {
  ok: boolean;
  path: string;
  warnings: VaultWarning[];
  commit: string | null;
  // Set when the quality gate REJECTED the write (nothing was saved). The
  // editor surfaces ``errors`` so the user can fix and re-save.
  blocked?: boolean;
  errors?: VaultWarning[];
  // What the gate auto-fixed on the way in (e.g. scaffolded frontmatter).
  applied?: string[];
}

// One entry from the vault git log. ``provenance`` is a free-form map
// whose keys include origin / session / workflow / task / tool.
export interface VaultCommit {
  hash: string;
  subject: string;
  date: string;
  author: string;
  provenance: Record<string, string>;
}

// ``GET /api/vault/history`` envelope. ``path`` scopes the log to one
// note/folder; ``null`` for the vault-wide log.
export interface VaultHistory {
  commits: VaultCommit[];
  path: string | null;
}

// A file touched by a commit: ``status`` is the git short status
// (A/M/D/R), ``path`` the vault-relative note path.
export interface VaultCommitFile {
  status: string;
  path: string;
}

// ``GET /api/vault/commit?hash=`` — the changes a single commit
// introduced: metadata + the files it touched + the unified diff
// (capped server-side; ``diff_truncated`` flags when it was cut).
export interface VaultCommitDetail extends VaultCommit {
  full_hash: string;
  files: VaultCommitFile[];
  diff: string;
  diff_truncated: boolean;
}

// ``POST /api/vault/restore`` — non-destructive roll-back to a state.
export interface VaultRestoreResult {
  ok: boolean;
  commit: string | null;
  restored_from: string;
  changed: boolean;
  error?: string;
}

// ``POST /api/vault/reset`` — destructive reset; ``deleted`` is how many
// later commits were removed.
export interface VaultResetResult {
  ok?: boolean;
  head?: string;
  deleted?: number;
  error?: string;
}

// ``GET /api/vault/gate`` report — quality-gate violations grouped by
// rule. Loosely typed (``by_rule`` / ``stats``) where the shape is
// open-ended.
export interface VaultGateViolation {
  rule: string;
  severity: string;
  path: string;
  message: string;
  suggestion?: string;
}

export interface VaultGateReport {
  ok: boolean;
  error_count: number;
  warn_count: number;
  info_count: number;
  note_count: number;
  violations: VaultGateViolation[];
  by_rule: Record<string, VaultGateViolation[]>;
  stats: Record<string, unknown>;
}

export interface HealthResponse {
  status: 'ok';
  agent: string;
  version: string;
  connected_clients: number;
}

// ── Scheduled Tasks ──

export interface ScheduledTask {
  id: string;
  name: string;
  cron_expression: string;
  prompt: string;
  /** Optional per-task model pin (a runtime_id such as
   *  ``anthropic:claude-opus-4-8``). Null/absent → the firing runs on the
   *  agent's default/router model, like a chat turn with no session pin. */
  model?: string | null;
  enabled: boolean;
  last_run: number | null;
  next_run: number | null;
  created_at: number;
  updated_at: number;
  run_once: boolean;
  run_at?: number;
  run_at_iso?: string;
  last_run_iso?: string;
  next_run_iso?: string;
  created_at_iso?: string;
  updated_at_iso?: string;
  /** True when a firing of this task is in flight right now (``running`` or
   *  mid-``cancelling``). Drives the tile's Run-now ↔ Stop control. Only set
   *  on list / get responses; create/update responses omit it (default false). */
  running?: boolean;
}

export interface CreateScheduledTaskInput {
  name: string;
  cron_expression: string;
  prompt: string;
  /** Optional runtime_id to pin the firing's model. Omit for the default. */
  model?: string | null;
  enabled?: boolean;
}

export type UpdateScheduledTaskInput = Partial<
  Pick<ScheduledTask, 'name' | 'cron_expression' | 'prompt' | 'model' | 'enabled'>
>;

// One row in a scheduled task's execution history — the analogue of
// ``WorkflowRun`` for cron tasks. Persisted server-side in the
// ``task_runs`` table and served newest-first by
// ``GET /api/scheduled-tasks/{id}/runs``. A task firing has no block
// graph, so there is no trace: just the agent's output preview (or the
// error that aborted it). No 'cancelled' state — a task run either
// completes, fails, or is reaped to 'failed' on restart.
export type TaskRunStatus = 'running' | 'success' | 'failed';

export interface TaskRun {
  id: string;
  task_id: string;
  trigger: string; // 'schedule' for a cron fire, 'manual' for a hand-run, …
  status: TaskRunStatus;
  started_at: number;
  finished_at: number | null;
  output: string | null;
  error: string | null;
  started_at_iso?: string;
  finished_at_iso?: string | null;
  /** The durable child session this firing ran as — lets the run screen open
   *  it as a full chat session (transcript + composer) instead of a static
   *  output preview. */
  session_id?: string | null;
}

// ── Events (webhook channel) ──
//
// An Event is an inbound trigger: a name, a webhook ``type`` preset, a
// user-friendly input schema, and a per-event secret, bound to one of three
// actions — run a workflow, fire a scheduled task, or start a chat prompt
// (a durable child session surfaced from the event delivery's run screen).
// Reachable from outside via POST /hooks/{slug} and from inside
// the mesh via POST /api/events/{id}/trigger. The secret is returned in clear
// exactly once (on create / rotate); reads carry only ``secret_hint``.

export type EventActionKind = 'workflow' | 'scheduled_task' | 'prompt';
export type EventType = 'generic' | 'generic-hmac' | 'github' | 'stripe' | 'slack';

/** One field descriptor in an event's user-friendly input schema. */
export interface EventInputField {
  name: string;
  type?: string;          // 'string' | 'number' | 'boolean' | 'object' | …
  required?: boolean;
  description?: string;
  path?: string;          // dot-path into the payload, e.g. "pusher.name"
}

export interface AgentEvent {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  type: EventType;
  enabled: boolean;
  /** Last 4 chars of the secret, for a ``whsec_…abcd`` display. The secret
   *  itself is only ever returned inline on create / rotate. */
  secret_hint?: string | null;
  input_schema: EventInputField[];
  action_kind: EventActionKind;
  /** workflow id or scheduled-task id; null for action_kind='prompt'. */
  action_ref?: string | null;
  /** For action_kind='prompt' — may reference {{payload.field}}. */
  prompt_template?: string | null;
  model?: string | null;
  /** When true, prompt-event deliveries whose payload carries the same value
   *  at ``session_binding_path`` reuse the same internal OpenAgent event-run
   *  session instead of creating one per delivery. */
  session_binding_enabled?: boolean;
  /** Dot-path into the delivery payload, e.g. ``id`` or ``ticket.id``. */
  session_binding_path?: string | null;
  rate_limit_per_min: number;
  max_payload_bytes: number;
  last_triggered_at?: number | null;
  created_at: number;
  updated_at: number;
  /** The relative hook path (``/hooks/{slug}``). Always present. */
  webhook_path: string;
  /** The absolute hook URL when ``channels.webhook.public_url`` is set;
   *  null when the listener isn't publicly configured yet. */
  webhook_url?: string | null;
  /** Returned ONCE, inline, on create + rotate-secret. Never on a read. */
  secret?: string;
}

export interface CreateEventInput {
  name: string;
  action_kind: EventActionKind;
  action_ref?: string | null;
  prompt_template?: string | null;
  type?: EventType;
  description?: string | null;
  input_schema?: EventInputField[];
  model?: string | null;
  session_binding_enabled?: boolean;
  session_binding_path?: string | null;
  enabled?: boolean;
}

export type UpdateEventInput = Partial<
  Pick<
    AgentEvent,
    | 'name' | 'description' | 'type' | 'enabled' | 'action_kind'
    | 'action_ref' | 'prompt_template' | 'model' | 'input_schema'
    | 'session_binding_enabled' | 'session_binding_path'
  >
>;

export type EventDeliveryStatus =
  // 'cancelled': the delivery was interrupted, not failed — most often a
  // barge-in, where a newer delivery for the same bound session superseded
  // the one in flight (vision §2 calls interrupt/barge-in first-class). The
  // server stopped writing these as 'failed' with an empty error in v0.17.x;
  // keep it distinct here so the Recent feed does not count an interrupt as a
  // fault (see the failed+rejected filter in EventDeliveryHistoryContent).
  | 'received' | 'running' | 'success' | 'failed' | 'rejected' | 'cancelled';

/** One row in an event's delivery history — the analogue of a workflow run /
 *  task run. Surfaced in the sidebar Recent feed under the 'event' filter. */
export interface EventDelivery {
  id: string;
  event_id: string;
  source: string;             // 'webhook' | 'peer' | 'manual' | 'agent'
  external_id?: string | null;
  status: EventDeliveryStatus;
  payload_json: string;
  started_at: number;
  finished_at?: number | null;
  output?: string | null;
  error?: string | null;
  /** Exactly one is set, linking the produced unit of work. */
  session_id?: string | null;
  workflow_run_id?: string | null;
  task_run_id?: string | null;
}

/** A webhook ``type`` preset, from GET /api/event-types. */
export interface EventTypeSpec {
  key: EventType;
  label: string;
  description: string;
  signed: boolean;
  docs?: string | null;
}

// ── Workflows (n8n-style multi-block pipelines) ──

// A workflow is a DAG of blocks (nodes) connected by edges. The
// ``graph`` payload round-trips through the AI's workflow-manager
// MCP, the REST API, and the React-Flow / SVG editor unchanged.
//
// Triggering is declared *inside the graph* via trigger-* blocks
// (trigger-manual, trigger-schedule, trigger-ai). A workflow has no
// row-level trigger field — any workflow can be fired manually, by
// the AI, or on a schedule at any time, depending on what blocks it
// carries. Multiple trigger-schedule blocks fire independently.

export type WorkflowRunStatus = 'running' | 'success' | 'failed' | 'cancelled';

export type BlockCategory = 'triggers' | 'ai' | 'tools' | 'flow' | 'utility';

export type BlockType =
  | 'trigger-manual'
  | 'trigger-schedule'
  | 'trigger-ai'
  | 'trigger-event'
  | 'mcp-tool'
  | 'ai-prompt'
  | 'if'
  | 'loop'
  | 'wait'
  | 'parallel'
  | 'merge'
  | 'set-variable'
  | 'http-request';

export interface WorkflowNode {
  id: string;
  type: BlockType;
  label?: string;
  position: { x: number; y: number };
  // Per-block config. Shape depends on ``type`` — see BlockTypeSpec.config_schema.
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;  // 'out' by default; 'true'|'false' for if, etc.
  targetHandle?: string;  // 'in' by default
  label?: string | null;
}

export interface WorkflowGraph {
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: Record<string, unknown>;
}

// One schedule per ``trigger-schedule`` block, keyed by node_id. The
// scheduler loop polls this shape; the UI's list row + history drawer
// surface ``next_run_at_iso`` / ``last_run_at_iso``.
export interface WorkflowSchedule {
  id: string;
  workflow_id: string;
  node_id: string;
  cron_expression: string;
  next_run_at: number;
  last_run_at: number | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  next_run_at_iso?: string | null;
  last_run_at_iso?: string | null;
  created_at_iso?: string;
  updated_at_iso?: string;
}

export interface WorkflowTask {
  id: string;
  name: string;
  description?: string | null;
  graph: WorkflowGraph;
  enabled: boolean;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
  last_run_at_iso?: string | null;
  created_at_iso?: string;
  updated_at_iso?: string;
  // Derived server-side from graph nodes — e.g. ``['trigger-manual',
  // 'trigger-schedule']`` when the workflow carries both kinds. Used
  // by the list badge + AI's ``has_trigger_type`` filter.
  trigger_types: string[];
  // Per-block schedule state (one row per ``trigger-schedule`` block).
  schedules: WorkflowSchedule[];
  // Optional cap on overlapping runs of this workflow. ``null`` means
  // unlimited (default) — concurrent runs all execute. ``1`` fully
  // serializes. ``N>1`` admits up to N simultaneous runs; the rest
  // queue on the executor's per-workflow semaphore.
  max_concurrent_runs?: number | null;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  variables?: Record<string, unknown>;
  max_concurrent_runs?: number | null;
}

export type UpdateWorkflowInput = Partial<{
  name: string;
  description: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: Record<string, unknown>;
  enabled: boolean;
  max_concurrent_runs: number | null;
}>;

// Per-block trace entry appended to workflow_runs.trace_json after
// each block finishes. Shared between the UI's RunHistoryContent and
// the workflow-manager MCP's get_workflow_run tool.
export interface WorkflowTraceEntry {
  /** Stable v2 attempt-level anchor; legacy gateways omit it. */
  id?: string;
  /** Compatibility alias emitted by early beta gateways. */
  trace_step_id?: string;
  node_id: string;
  type: BlockType;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string | null;
  /** For an ai-prompt node, the durable child session it ran as — the run
   *  screen renders a DelegationCard that deep-links into the node's full
   *  conversation. */
  child_session_id?: string;
  tool_invocation_ids?: string[];
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  trigger: 'manual' | 'schedule' | 'ai' | 'api';
  status: WorkflowRunStatus;
  started_at: number;
  finished_at: number | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error: string | null;
  trace: WorkflowTraceEntry[];
  started_at_iso?: string;
  finished_at_iso?: string | null;
}

// Block type catalog — one entry per BlockType. Served by
// ``GET /api/workflow-block-types`` and consumed by the editor's
// palette + properties panel.
export interface BlockTypeFieldSpec {
  type: 'string' | 'integer' | 'number' | 'object' | 'array' | 'boolean';
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  description?: string;
  items?: BlockTypeFieldSpec;
}

export interface BlockTypeSpec {
  type: BlockType;
  category: BlockCategory;
  description: string;
  config_schema: Record<string, BlockTypeFieldSpec>;
  source_handles: string[];
  target_handles: string[];
  output_shape: string;
}

// One MCP + its tools as seen by the editor's tool picker. Served by
// ``GET /api/mcp-tools``.
export interface MCPToolParameter {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
}

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  parameters_schema?: Record<string, unknown>;
}

export interface MCPToolkitDescriptor {
  mcp_name: string;
  tools: MCPToolDescriptor[];
}

// Stats surface for the run-history view + list row sparklines.
export interface WorkflowRunSummary {
  id: string;
  status: WorkflowRunStatus;
  started_at: number;
  finished_at: number | null;
  duration_s: number | null;
  started_at_iso?: string | null;
  finished_at_iso?: string | null;
}

export interface WorkflowStats {
  total_runs: number;
  success_count: number;
  failed_count: number;
  cancelled_count: number;
  running_count: number;
  success_rate: number;
  avg_duration_s: number | null;
  last: WorkflowRunSummary[];
}

// ── Budgets (/api/budgets) ──
//
// A budget is a spend cap on a scope, measured over a window. Whether a
// cap is actually ENFORCED depends on its shape: only `global`/`provider`/
// `model` scopes over an `hour`/`day`/`month` window can exclude a model
// from routing. A `task` scope or a `per_run` window is alert-only — the
// server reports that per rule as `enforced`, and the UI must not imply a
// hard cap where there is none.

export type BudgetScopeKind = 'global' | 'provider' | 'model' | 'task';
export type BudgetWindow = 'hour' | 'day' | 'month' | 'per_run';
export type BudgetMetric = 'cost_usd' | 'tokens';

export interface BudgetRule {
  id: string;
  scope_kind: BudgetScopeKind;
  /** Display form: the scope value, or '*' for a global rule. */
  scope: string;
  /** Raw value ('' for global). Send this back on writes. */
  scope_value: string;
  metric: BudgetMetric;
  window: BudgetWindow;
  amount: number;
  alert_thresholds: number[] | null;
  webhook_url: string | null;
  enabled: boolean;
  /** 'user' for rules created here, 'yaml' for seeded ones. */
  source?: string;
}

/** A rule plus its live meter, from `/api/budgets/usage`. */
export interface BudgetUsage extends BudgetRule {
  /** Spend so far in the current window. `null` for `per_run` (no window
   *  to sum over) or when the aggregation failed — see `error`. */
  spend: number | null;
  /** spend / amount, or `null` when spend is unavailable. */
  ratio: number | null;
  over: boolean;
  remaining: number | null;
  window_start: number | null;
  window_end: number | null;
  /** False for `task` scopes and `per_run` windows: the rule alerts but
   *  cannot stop a turn. */
  enforced: boolean;
  /** A `cost_usd` cap on a scope that prices at $0 can never trip. */
  cost_metric_ineffective?: boolean;
  warning?: string;
  error?: string;
}

export interface CreateBudgetInput {
  scope_kind: BudgetScopeKind;
  scope_value?: string;
  metric: BudgetMetric;
  window: BudgetWindow;
  amount: number;
  alert_thresholds?: number[];
  webhook_url?: string | null;
  enabled?: boolean;
}

export type UpdateBudgetInput = Partial<CreateBudgetInput>;

// ── Event log (/api/logs) ──

/** One line of `events.jsonl`. `ts`, `event` and `level` are always
 *  present; everything else is per-event payload the writer passed to
 *  `elog(...)`, so it is deliberately open. */
export interface LogEntry {
  ts: number;
  event: string;
  level: string;
  [key: string]: unknown;
}

// ── Quality report (/api/quality) ──
//
// The correctness meter beside the spend meter: where budgets answer "how
// much did we spend", this answers "were the answers any good". Derived
// from the event log alone (quality.score, router.cost_recorded,
// recall.metric), so it is read-only and always renderable — a window with
// no data returns zeros and nulls, never an error.

export interface QualityReport {
  window_seconds: number;
  /** False when the quality monitor is off: the sections are all zero and
   *  the UI must say "not running" rather than "quality is 0". */
  enabled?: boolean;
  quality: {
    judged: number;
    avg_score: number | null;
    verdicts: { good: number; warn: number; bad: number };
    fabrication_flagged: number;
  };
  usage: {
    turns: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
  recall: {
    turns: number;
    used_rate: number | null;
    hit_rate: number | null;
    avg_top_score: number | null;
  };
}

// ── Slash-command registry (/api/commands) ──

/** One entry of the gateway's introspectable command registry. The server
 *  exposes this precisely so a rich client does not hardcode the list and
 *  drift from it — a command added server-side shows up here without an
 *  app release. */
export interface GatewayCommandSpec {
  name: string;
  description: string;
  help_text: string;
  /** False for aliases the menu should not repeat (`reset`, `queue`). */
  menu_visible: boolean;
  help_visible: boolean;
  /** When set, the argument is picked from a list rather than typed —
   *  `'models'` opens the composer's model picker. */
  arg_source: string | null;
}

// ── Skills (/api/skills) ──
//
// The agent's file-backed skill library: one folder per skill, a SKILL.md
// with YAML frontmatter, optional bundled files beside it. Two flags carry
// real meaning rather than decoration:
//
//   `agent_authored` — the agent wrote it via its own tools. That is the
//   boundary the skill-curator respects: seed and hub skills are off-limits
//   to consolidation, so it can never merge or retire curated content.
//
//   `archived` — retired WITHOUT deleting. The file stays on disk, and the
//   skill drops out of the index injected into the system prompt.

export interface SkillSummary {
  name: string;
  description: string;
  category: string;
  path: string;
  created_by: string | null;
  status: string | null;
  agent_authored: boolean;
  archived: boolean;
  from_hub: boolean;
}

export interface SkillDetail {
  ok: boolean;
  name: string;
  description: string;
  category: string;
  path: string;
  /** SKILL.md with the frontmatter stripped — what the agent actually reads. */
  body: string;
  /** The raw file, frontmatter included. */
  content: string;
  bundled_files: string[];
}

export interface SkillWriteResult {
  ok: boolean;
  action?: string;
  name: string;
  path?: string;
  /** Always false: a write lands on disk, but the skills index inside the
   *  cached system prompt is a frozen snapshot. The agent picks the change
   *  up on the next boot/reload, not mid-session — the UI must say so. */
  index_refreshed?: boolean;
  error?: string;
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  category?: string;
  body: string;
}

// ── Serving accounts (/api/accounts) ──
//
// Which subscription account is actually paying for a provider's traffic,
// and how much of its window is left. A model row says WHICH model answers;
// this says WHOSE account it runs on.
//
// `quota` is null whenever the upstream does not report one — and that is
// the common case, not an edge case. A Codex proxy returns a real
// used-percentage against a real window; a Claude proxy returns only
// "limited / not limited", because Anthropic never tells it more: it learns
// an account is spent by receiving a 429. The UI must render that absence as
// "not reported" and never as 0% used, which is the number an operator would
// plan around.

export interface AccountQuota {
  plan?: string;
  active_limit?: string;
  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_s?: number;
  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_s?: number;
  credits_balance?: number;
}

export interface ServingAccount {
  id: string;
  name: string;
  priority?: number;
  plan?: string;
  managed?: boolean;
  /** Rate-limited right now; `limited_until_ms` says until when. */
  limited?: boolean;
  limited_until_ms?: number;
  /** Credential expiry (proxy accounts). */
  expires_at_ms?: number;
  has_refresh_token?: boolean;
  /** Pool accounts only: terminal auth failure, never auto-recovers. */
  dead?: boolean;
  status?: string;
  cooldown_remaining_s?: number | null;
  request_count?: number;
  quota: AccountQuota | null;
  /** 'proxy' = read from a sub-proxy's health; 'pool' = OpenAgent's own
   *  rotation pool, which tracks health but is never told a quota. */
  source?: 'proxy' | 'pool';
}

export interface ProviderAccounts {
  provider: string;
  framework?: string;
  base_url?: string;
  enabled: boolean;
  reachable: boolean;
  accounts: ServingAccount[];
  metrics: Record<string, number> | null;
  /** Why there are no accounts: unreachable, not a proxy, no accounts. */
  error?: string | null;
}
