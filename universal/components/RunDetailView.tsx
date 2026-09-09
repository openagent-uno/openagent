/**
 * RunDetailView — chat-styled detail for ONE execution.
 *
 * Opened from the sidebar's Recent feed (``/runs/{id}``). Where the
 * Scheduled / Workflows history screens list a parent's firings as compact
 * cards, this reads like the Chat transcript: an editorial single column
 * with a run header banner, the agent's output rendered as full-width
 * Markdown prose (``AssistantBlock``), and — for workflows — the block
 * trace as inline expandable step cards. The styling deliberately mirrors
 * ``MessageList`` so a run and a conversation feel like the same surface.
 *
 * Tasks have no single-run endpoint, so a task firing is fetched by
 * pulling the recent window and narrowing to the requested id; workflow
 * runs come straight from ``GET /api/workflow-runs/{id}``.
 */

import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, font, radius } from '../theme';
import {
  getWorkflowRun, getScheduledRunDetail, getEventDelivery,
  fetchSessionRuns, runMsgToChat, getSessionContext,
  listSessionMessages, getToolInvocationDetail,
} from '../services/api';
import { runRoutePath } from '../../common/types';
import {
  normalizeLegacyRunDates,
  type WithNormalizedRunDates,
} from '../../common/run-date-normalization';
import { openDetached } from '../services/windows';
import { useChat } from '../stores/chat';
import { sessionReadGuard } from '../stores/sessionReadAccess';
import { useConnection } from '../stores/connection';
import { useAutoScroll } from '../hooks/useAutoScroll';
import Markdown from './Markdown';
import MessageList from './MessageList';
import SharedPresence, { useSharedView } from './SharedPresence';
import MessageComposer from './MessageComposer';
import type {
  BlockType,
  ChatMessage,
  EventDelivery,
  TaskRun,
  WorkflowRun,
  WorkflowTraceEntry,
} from '../../common/types';

// The full transcript of a run-backed child session (a scheduled firing, an
// ai-prompt node), rendered inline with MessageList right under the run header
// — the run screen IS the session, no redirect. Nested delegations within it
// still link onward to their own child sessions in a detached chat window; a
// nested run-now opens its own run screen in a detached window.
//
// The fetch self-heals rather than showing a one-shot empty state: it keeps
// polling while the run is ``live`` (so the transcript fills in as the agent
// works), and retries a few times if the very first read comes back empty
// (covering the brief window after a firing finishes but before its runs JSON
// has flushed). A genuine fetch failure surfaces as an error with Retry — not
// silently as "no transcript".
const EMPTY_RETRY_MAX = 4;      // ~6s of retries for a just-finished flush race
const LIVE_POLL_MAX = 150;      // ~5min ceiling so a stuck run can't poll forever
const POLL_MS = 2000;

function sameChatStart(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  if (!a || !b) return false;
  return a.role === b.role
    && a.text === b.text
    && (a.author?.kind ?? '') === (b.author?.kind ?? '')
    && (a.author?.handle ?? '') === (b.author?.handle ?? '');
}

export function SessionTranscript({ sessionId, live, messageId, toolInvocationId }: {
  sessionId: string;
  /** The owning run is still in flight — keep polling so the transcript grows. */
  live?: boolean;
  messageId?: string;
  toolInvocationId?: string;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The run IS a session: while it's in flight the server broadcasts its deltas
  // tagged with this sid, and the app's normal frame routing accumulates them
  // into the chat store — exactly like an interactive session. Prefer that live
  // copy so the transcript renders token-by-token; the polled DB read below is
  // the seed for a completed run that isn't in the store (or an older server).
  const liveSession = useChat((s) => s.sessions.find((x) => x.id === sessionId));
  useSharedView('session', sessionId);
  const liveMessages = liveSession?.messages;
  const liveProcessing = liveSession?.isProcessing;
  const accessRevoked = liveSession?.accessRevoked;
  const hasLive = !!liveMessages?.length;
  const mergeMessageWindow = useChat((s) => s.mergeMessageWindow);

  useEffect(() => {
    if (!messageId) return;
    const controller = new AbortController();
    const current = sessionReadGuard(sessionId);
    void (async () => {
      try {
        const [page, tool] = await Promise.all([
          listSessionMessages(sessionId, { around: messageId, before: 30, after: 30 }, controller.signal),
          toolInvocationId
            ? getToolInvocationDetail(toolInvocationId, controller.signal)
            : Promise.resolve(undefined),
        ]);
        if (current() && !controller.signal.aborted && page.anchor_found !== false) {
          mergeMessageWindow(page, tool);
        }
      } catch {
        // The enclosing run remains useful even when a stale anchor vanished.
      }
    })();
    return () => controller.abort();
  }, [mergeMessageWindow, messageId, sessionId, toolInvocationId]);

  // Hard reset only when the session itself changes (or on an explicit Retry).
  // A ``live`` flip (running → done) must NOT blank the already-loaded
  // transcript — the poll effect below just refetches in place.
  useEffect(() => {
    setMessages(null);
    setError(null);
  }, [sessionId, reloadKey, accessRevoked]);

  useEffect(() => {
    // Once the live store copy has content the DB poll is pure waste — the
    // broadcast stream drives the transcript. Poll only as the seed/fallback
    // (a completed run not in the store, or a server without live streaming).
    if (hasLive || accessRevoked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const tick = async () => {
      const current = sessionReadGuard(sessionId);
      try {
        const raw = await fetchSessionRuns(sessionId);
        if (cancelled || !current()) return;
        const mapped = raw.map(runMsgToChat);
        setMessages(mapped);
        setError(null);
        attempts += 1;
        // Keep going while the run is live (transcript still growing) or while
        // it's empty and we haven't exhausted the post-finish retry budget.
        const keepPolling = live
          ? attempts < LIVE_POLL_MAX
          : mapped.length === 0 && attempts < EMPTY_RETRY_MAX;
        if (keepPolling) timer = setTimeout(tick, POLL_MS);
      } catch (e: any) {
        if (cancelled || !current()) return;
        setError(e?.message ?? String(e));
        setMessages((m) => m ?? []);  // leave the loading state either way
        attempts += 1;
        // Same ceiling as the success path so a persistently-failing fetch on
        // a live run can't re-poll forever (LIVE_POLL_MAX ~ 5min).
        const keepRetrying = live ? attempts < LIVE_POLL_MAX : attempts < EMPTY_RETRY_MAX;
        if (keepRetrying) timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sessionId, live, reloadKey, hasLive, accessRevoked]);

  // Prefer the live streamed copy whenever it has content; otherwise fall back
  // to the polled DB transcript. A live run with no deltas yet shows the
  // streaming indicator rather than a stale "no transcript".
  const liveAlreadyIncludesHistory = hasLive
    && !!messages?.length
    && sameChatStart(liveMessages?.[0], messages[0]);
  const display = hasLive
    ? (messages?.length && !liveAlreadyIncludesHistory
      ? [...messages, ...(liveMessages ?? [])]
      : liveMessages)
    : messages;
  // The run-status poll (``live``) drives the streaming indicator — a detached
  // child's broadcast stub never flips the store's ``isProcessing``, and
  // keeping that false is what lets ``reconcileSession`` snap to the canonical
  // transcript on turn_complete.
  const streaming = !!live || !!liveProcessing;

  if (accessRevoked) return <EmptyNote text="This session is no longer available." />;

  if (display == null && !error) {
    return (
      <ActivityIndicator size="small" color={colors.textMuted} style={{ marginVertical: 12 }} />
    );
  }
  if (error && (display == null || display.length === 0) && !streaming) {
    return (
      <TouchableOpacity onPress={() => setReloadKey((k) => k + 1)} style={styles.transcriptRetry}>
        <Feather name="refresh-cw" size={11} color={colors.textMuted} />
        <Text style={styles.transcriptRetryText}>Couldn't load the transcript — tap to retry</Text>
      </TouchableOpacity>
    );
  }
  if (!display || display.length === 0) {
    return streaming
      ? <EmptyNote text="Waiting for the run to produce output…" />
      : <EmptyNote text="This run produced no transcript." />;
  }
  return (
    <><SharedPresence kind="session" id={sessionId} /><MessageList
      messages={display}
      isProcessing={streaming}
      anchorMessageId={messageId}
      anchorToolInvocationId={toolInvocationId}
      onOpenChild={(id) => openDetached(router, `chat?session=${encodeURIComponent(id)}`)}
      onOpenRun={(target) => {
        const path = runRoutePath(target);
        if (path) openDetached(router, path);
      }}
    /></>
  );
}

type IconName = keyof typeof Feather.glyphMap;
type RunKind = 'workflow' | 'task' | 'event';
type NormalizedEventDelivery = WithNormalizedRunDates<EventDelivery>;

const STATUS_COLOR: Record<string, string> = {
  running: colors.warning,
  received: colors.warning,
  success: colors.success,
  failed: colors.error,
  rejected: colors.error,
  cancelled: colors.textMuted,
  skipped: colors.textMuted,
};

// ── Workflow node presentation ───────────────────────────────────────
// Each block type gets a friendly icon + human label so the trace reads
// like plain English ("Tool call", "Condition", "Wait") instead of the
// raw engine ``type`` string ("mcp-tool", "if", "wait"). Keeps the run
// screen legible to someone who never opened the workflow editor.
const NODE_META: Record<BlockType, { icon: IconName; label: string }> = {
  'trigger-manual': { icon: 'play', label: 'Manual start' },
  'trigger-schedule': { icon: 'clock', label: 'Scheduled start' },
  'trigger-ai': { icon: 'zap', label: 'AI start' },
  'trigger-event': { icon: 'zap', label: 'Event start' },
  'mcp-tool': { icon: 'tool', label: 'Tool call' },
  'ai-prompt': { icon: 'cpu', label: 'AI node' },
  'if': { icon: 'git-merge', label: 'Condition' },
  'loop': { icon: 'repeat', label: 'Loop' },
  'wait': { icon: 'pause-circle', label: 'Wait' },
  'parallel': { icon: 'git-branch', label: 'Parallel' },
  'merge': { icon: 'git-pull-request', label: 'Merge' },
  'set-variable': { icon: 'edit-3', label: 'Set variable' },
  'http-request': { icon: 'globe', label: 'HTTP request' },
};

function nodeMeta(type: string): { icon: IconName; label: string } {
  return NODE_META[type as BlockType] ?? { icon: 'box', label: type };
}

function eventSessionId(delivery: EventDelivery | null): string | undefined {
  return delivery ? `event:${delivery.event_id}:${delivery.id}` : undefined;
}

// Only nodes whose input/output is genuinely worth reading are expandable;
// everything else (triggers, waits, flow control, set-variable) collapses to
// a single clean summary row. A node that errored is always expandable so the
// failure is never hidden behind a non-clickable card.
const EXPANDABLE_TYPES = new Set<BlockType>(['mcp-tool', 'http-request']);

function isExpandable(entry: WorkflowTraceEntry): boolean {
  return EXPANDABLE_TYPES.has(entry.type) || !!entry.error;
}

/** Compact, single-line stringification for a summary chip. */
function shortVal(v: unknown, max = 48): string {
  let s: string;
  if (v == null) s = String(v);
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// A one-line, human "what this step did", derived from the resolved input /
// output the engine records (executor writes ``input = resolved_config`` and a
// per-type ``output``). Returns undefined when there's nothing meaningful to
// show, so the summary row simply doesn't render.
function nodeSummary(entry: WorkflowTraceEntry): string | undefined {
  const inp = (entry.input ?? {}) as Record<string, any>;
  const out = (entry.output ?? {}) as Record<string, any>;
  switch (entry.type) {
    case 'mcp-tool': {
      const tool = inp.tool_name || inp.mcp_name;
      return tool ? String(tool) : undefined;
    }
    case 'http-request': {
      const method = String(inp.method || 'GET').toUpperCase();
      return inp.url ? `${method} ${shortVal(inp.url, 56)}` : undefined;
    }
    case 'set-variable': {
      const key = out.key ?? inp.key;
      if (!key) return undefined;
      return 'value' in out ? `${key} = ${shortVal(out.value)}` : String(key);
    }
    case 'wait': {
      if (inp.mode === 'until' && inp.until_iso) return `until ${shortVal(inp.until_iso, 40)}`;
      if (inp.seconds != null) return `${inp.seconds}s`;
      if (out.waited_ms != null) {
        const s = out.waited_ms / 1000;
        return `${s.toFixed(s >= 10 ? 0 : 1)}s`;
      }
      return undefined;
    }
    case 'if': {
      return out.branch ? `→ ${out.branch} branch` : undefined;
    }
    case 'loop': {
      const n = out.iterations;
      return n != null ? `${n} iteration${n === 1 ? '' : 's'}` : undefined;
    }
    case 'merge': {
      return inp.strategy ? `strategy: ${inp.strategy}` : undefined;
    }
    case 'trigger-schedule': {
      return inp.cron_expression ? shortVal(inp.cron_expression, 36) : undefined;
    }
    default:
      return undefined;
  }
}

const webFade = Platform.OS === 'web' ? { className: 'oa-fade-in' } : {};

export function RunDetailView({
  kind,
  parentId,
  runId,
  name,
  traceStepId,
  messageId,
  toolInvocationId,
  targetSessionId,
}: {
  kind: RunKind;
  parentId: string;
  runId: string;
  /** Parent workflow / task name, shown in the header banner. */
  name?: string;
  traceStepId?: string;
  messageId?: string;
  toolInvocationId?: string;
  targetSessionId?: string;
}) {
  const [wfRun, setWfRun] = useState<WorkflowRun | null>(null);
  const [taskRun, setTaskRun] = useState<TaskRun | null>(null);
  const [delivery, setDelivery] = useState<NormalizedEventDelivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Open the owning workflow / scheduled task / event — same destination (and
  // detached-window behaviour) as tapping its tile in the list screens.
  const PARENT_SECTION: Record<RunKind, string> = {
    workflow: 'workflows',
    task: 'tasks',
    event: 'events',
  };
  const openParent = () => {
    const id = kind === 'event'
      ? (delivery?.event_id || parentId)
      : kind === 'workflow'
        ? (wfRun?.workflow_id || parentId)
        : (taskRun?.task_id || parentId);
    if (!id) return;
    openDetached(router, `${PARENT_SECTION[kind]}/${id}`);
  };

  // Re-poll the run summary while the firing is still in flight, so the header
  // status pill settles, the duration finalises, and — for workflows — steps
  // that start after mount (and their inline per-step transcripts) appear. The
  // SessionTranscript bodies key their own ``live`` flag off the status this
  // refreshes, so without it a run opened mid-flight would stay frozen.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let gotData = false;
    setLoading(true);
    setError(null);
    setWfRun(null);
    setTaskRun(null);
    setDelivery(null);
    const load = async () => {
      try {
        let status: string | undefined;
        if (kind === 'workflow') {
          const run = normalizeLegacyRunDates(await getWorkflowRun(runId));
          if (cancelled) return;
          setWfRun(run);
          gotData = !!run;
          status = run?.status;
        } else if (kind === 'event') {
          // An event delivery IS the run: one inbound trigger, its payload,
          // and the unit of work it produced (a child session for a chat
          // prompt; a workflow / task run otherwise).
          const d = normalizeLegacyRunDates(await getEventDelivery(runId));
          if (cancelled) return;
          setDelivery(d);
          gotData = !!d;
          if (!d) { setError('This delivery could not be found.'); return; }
          status = d.status;
        } else {
          // Exact resolver: an old search hit remains addressable even after
          // it falls outside the parent's recent-run window.
          const detail = await getScheduledRunDetail(runId);
          if (cancelled) return;
          // Some compatibility gateways include *_iso mirrors on this
          // canonical response too. Passing the complete wire object lets the
          // shared boundary prefer them without widening the public type.
          const dates = normalizeLegacyRunDates(detail);
          const found: TaskRun = {
            id: detail.id,
            task_id: detail.task_id,
            trigger: detail.trigger || 'schedule',
            status: detail.status === 'success'
              ? 'success' : detail.status === 'running' ? 'running' : 'failed',
            started_at: dates.started_at,
            finished_at: dates.finished_at,
            output: detail.output_summary_safe || null,
            error: detail.error_safe || null,
            started_at_iso: dates.started_at_iso,
            finished_at_iso: dates.finished_at_iso,
            session_id: detail.session_id || null,
          };
          setTaskRun(found);
          gotData = true;
          status = found.status;
        }
        setError(null);
        polls += 1;
        // ``received`` is the event-delivery analogue of ``running``: the
        // dispatch hasn't started the bound action yet, so keep polling.
        const live = status === 'running' || status === 'received';
        if (live && polls < LIVE_POLL_MAX && !cancelled) {
          timer = setTimeout(load, POLL_MS);
        }
      } catch (e: any) {
        if (cancelled) return;
        // Fail hard only before the first successful read; a transient failure
        // mid-poll keeps the last good snapshot and retries.
        if (!gotData) setError(e?.message ?? String(e));
        else if (polls < LIVE_POLL_MAX) timer = setTimeout(load, POLL_MS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [kind, parentId, runId]);

  // Track deps for auto-scroll: the run status (live vs done), workflow
  // trace length/statuses, and the task's session message count all drive
  // content growth that should keep us pinned to the bottom.
  // MUST be called before ANY early return — hooks must run on every render.
  const scrollTrackDeps = [
    wfRun?.status,
    wfRun?.trace.length,
    wfRun?.trace.map((e) => e.status).join(','),
    taskRun?.status,
    taskRun?.session_id,
    delivery?.status,
    delivery?.session_id,
  ];
  const {
    scrollRef,
    onScroll,
    onContentSizeChange,
    isPinned,
    scrollToBottom,
  } = useAutoScroll({ trackDeps: scrollTrackDeps });
  const scrolledTraceAnchor = useRef<string | null>(null);
  useEffect(() => {
    scrolledTraceAnchor.current = null;
  }, [runId, traceStepId]);
  const onTraceAnchorLayout = useCallback((y: number) => {
    if (!traceStepId || scrolledTraceAnchor.current === traceStepId) return;
    scrolledTraceAnchor.current = traceStepId;
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 72), animated: false });
    }, 80);
  }, [scrollRef, traceStepId]);

  const fallbackEventSessionId = eventSessionId(delivery);
  const hasLiveEventSession = useChat((s) =>
    !!fallbackEventSessionId && s.sessions.some((x) => x.id === fallbackEventSessionId),
  );

  if (loading) {
    return (
      <View style={styles.statusPane}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.statusPane}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  const run = wfRun ?? taskRun ?? delivery;
  if (!run) return null;
  // An event delivery carries ``source`` (webhook / peer / manual / agent)
  // where a run carries ``trigger`` — same slot in the header.
  const triggerText = delivery ? delivery.source : (run as WorkflowRun | TaskRun).trigger;
  const KIND_META: Record<RunKind, { icon: IconName; label: string }> = {
    workflow: { icon: 'git-branch', label: 'Workflow' },
    task: { icon: 'clock', label: 'Scheduled task' },
    event: { icon: 'zap', label: 'Event' },
  };
  // The session that owns this run. Its context and related-session metadata
  // live in the shared right navigation drawer; the transcript/composer still
  // use this id directly.
  const ownerSessionId =
    targetSessionId
    ?? taskRun?.session_id
    ?? delivery?.session_id
    ?? (hasLiveEventSession ? fallbackEventSessionId : undefined);
  const ownerLive = (taskRun ?? delivery)
    ? run.status === 'running' || run.status === 'received'
    : false;

  return (
    <View style={styles.root}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.messagesContent}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={100}
        // Always show the scrollbar so the user sees there's
        // scrollable content even when the transcript is short.
        // @ts-ignore — RN Web prop, no-op on native
        persistentScrollbar
      >
        <View style={styles.messagesInner}>
          <RunHeader
            name={name}
            kindIcon={KIND_META[kind].icon}
            kindLabel={KIND_META[kind].label}
            status={run.status}
            trigger={triggerText}
            startedIso={run.started_at_iso}
            startedAt={run.started_at}
            finishedAt={run.finished_at ?? null}
            onPress={openParent}
          />
          {wfRun ? (
            <WorkflowBody
              run={wfRun}
              traceStepId={traceStepId}
              toolInvocationId={toolInvocationId}
              onAnchorLayout={onTraceAnchorLayout}
            />
          ) : taskRun ? (
            <TaskBody
              run={{ ...taskRun, session_id: targetSessionId || taskRun.session_id }}
              messageId={messageId}
              toolInvocationId={toolInvocationId}
            />
          ) : delivery ? (
            <DeliveryBody
              delivery={delivery}
              sessionId={ownerSessionId}
              messageId={messageId}
              toolInvocationId={toolInvocationId}
              onOpenRun={(rid, k) =>
              router.push(`/runs/${encodeURIComponent(rid)}?kind=${k}` as any)} />
          ) : null}
        </View>
      </ScrollView>
      {/* Jump-to-bottom pill: shown when the user has scrolled away from the
          bottom. Same position and style as the chat screen's pill so it
          reads as a consistent affordance across all screens. */}
      {!isPinned && (
        <TouchableOpacity
          style={[styles.jumpToBottom, ownerSessionId && styles.jumpToBottomWithComposer]}
          onPress={() => scrollToBottom(true)}
          accessibilityLabel="Jump to bottom"
          // @ts-ignore
          {...(Platform.OS === 'web' ? { className: 'oa-hover-lift oa-fade-in' } : {})}
        >
          <Feather name="chevron-down" size={14} color={colors.text} />
        </TouchableOpacity>
      )}
      {ownerSessionId ? (
        <RunSessionComposer sessionId={ownerSessionId} live={ownerLive} />
      ) : null}
    </View>
  );
}

function RunSessionComposer({ sessionId, live }: { sessionId: string; live?: boolean }) {
  const ws = useConnection((s) => s.ws);
  const session = useChat((s) => s.sessions.find((x) => x.id === sessionId));
  const addUserMessage = useChat((s) => s.addUserMessage);
  const [input, setInput] = useState('');

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !ws) return;
    addUserMessage(sessionId, text);
    ws.sendMessage(text, sessionId, {
      llmPin: session?.llmPin,
      systemPrompt: session?.systemPrompt,
    });
    setInput('');
  }, [addUserMessage, input, session?.llmPin, session?.systemPrompt, sessionId, ws]);

  const handleStop = useCallback(() => {
    if (!ws) return;
    ws.sendInterrupt(sessionId, 'manual');
  }, [sessionId, ws]);

  return (
    <MessageComposer
      input={input}
      onInputChange={setInput}
      onSend={handleSend}
      processing={!!live || !!session?.isProcessing}
      onStop={handleStop}
      placeholder="Message this run..."
    />
  );
}

// ── Header banner ────────────────────────────────────────────────────

function RunHeader({
  name,
  kindIcon,
  kindLabel,
  status,
  trigger,
  startedIso,
  startedAt,
  finishedAt,
  onPress,
}: {
  name?: string;
  kindIcon: IconName;
  kindLabel: string;
  status: string;
  trigger: string;
  startedIso?: string;
  startedAt: number;
  finishedAt: number | null;
  onPress: () => void;
}) {
  const color = STATUS_COLOR[status] ?? colors.textMuted;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={styles.runHeader}
      accessibilityRole="button"
      accessibilityLabel={`Open ${kindLabel.toLowerCase()} ${name || ''}`.trim()}
      // @ts-ignore web hover + entrance
      {...(Platform.OS === 'web' ? { className: 'oa-fade-in oa-row-hover' } : {})}
    >
      <View style={styles.runHeaderTop}>
        <Feather name={kindIcon} size={14} color={colors.textSecondary} />
        <Text style={styles.runTitle} numberOfLines={1}>
          {name || 'Run'}
        </Text>
        <View style={[styles.statusPill, { borderColor: color }]}>
          <View style={[styles.statusDot, { backgroundColor: color }]} />
          <Text style={[styles.statusPillText, { color }]}>{status}</Text>
        </View>
        <Feather name="chevron-right" size={16} color={colors.textMuted} />
      </View>
      <View style={styles.metaRow}>
        <MetaItem icon={kindIcon} text={kindLabel} />
        <MetaItem icon="zap" text={trigger} />
        {startedIso ? <MetaItem icon="calendar" text={formatWhen(startedIso)} /> : null}
        <MetaItem icon="clock" text={formatDuration(startedAt, finishedAt, status)} />
      </View>
    </TouchableOpacity>
  );
}

function MetaItem({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.metaItem}>
      <Feather name={icon} size={11} color={colors.textMuted} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

// ── Task firing body ─────────────────────────────────────────────────

// ── Event delivery body ──────────────────────────────────────────────
// The event analogue of ``TaskBody``: the delivered payload, then the unit
// of work it produced — a full child-session transcript for a chat-prompt
// event (same surface as a scheduled firing), or a link into the workflow /
// scheduled run for the other two action kinds.
function DeliveryBody({
  delivery,
  sessionId,
  messageId,
  toolInvocationId,
  onOpenRun,
}: {
  delivery: EventDelivery;
  sessionId?: string | null;
  messageId?: string;
  toolInvocationId?: string;
  onOpenRun: (runId: string, kind: 'workflow' | 'task') => void;
}) {
  const live = delivery.status === 'running' || delivery.status === 'received';
  let payload = delivery.payload_json;
  try {
    payload = JSON.stringify(JSON.parse(delivery.payload_json), null, 2);
  } catch {
    /* keep the raw string */
  }

  return (
    <>
      <AssistantBlock label="Payload" text={'```json\n' + (payload || '{}') + '\n```'} />

      {delivery.workflow_run_id ? (
        <RunLink
          icon="git-branch"
          label="Open the workflow run this event started"
          onPress={() => onOpenRun(delivery.workflow_run_id!, 'workflow')}
        />
      ) : null}
      {delivery.task_run_id ? (
        <RunLink
          icon="clock"
          label="Open the scheduled run this event started"
          onPress={() => onOpenRun(delivery.task_run_id!, 'task')}
        />
      ) : null}

      {sessionId ? (
        <SessionTranscript
          sessionId={sessionId}
          live={live}
          messageId={messageId}
          toolInvocationId={toolInvocationId}
        />
      ) : !delivery.error && !delivery.workflow_run_id && !delivery.task_run_id ? (
        <EmptyNote text="This delivery produced no output." />
      ) : null}

      {delivery.error ? <ErrorBlock text={delivery.error} /> : null}
    </>
  );
}

function RunLink({
  icon, label, onPress,
}: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.runLink}
      accessibilityRole="button"
      accessibilityLabel={label}
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-row-hover' } : {})}
    >
      <Feather name={icon} size={14} color={colors.primary} />
      <Text style={styles.runLinkText}>{label}</Text>
      <View style={{ flex: 1 }} />
      <Feather name="chevron-right" size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

function TaskBody({ run, messageId, toolInvocationId }: {
  run: TaskRun;
  messageId?: string;
  toolInvocationId?: string;
}) {
  // A durable firing renders as its full child-session transcript (same
  // surface as a chat). Legacy firings (no session) keep the output preview.
  if (run.session_id) {
    // The context panel is floated at the RunDetailView root (top-right), not
    // inline here, so it stays fixed while the transcript scrolls.
    return (
      <>
        <SessionTranscript
          sessionId={run.session_id}
          live={run.status === 'running'}
          messageId={messageId}
          toolInvocationId={toolInvocationId}
        />
        {run.error ? <ErrorBlock text={run.error} /> : null}
      </>
    );
  }
  return (
    <>
      {run.output ? (
        <AssistantBlock label="Output" text={run.output} />
      ) : !run.error ? (
        <EmptyNote text="This run produced no output." />
      ) : null}
      {run.error ? <ErrorBlock text={run.error} /> : null}
    </>
  );
}

// ── Workflow run body ────────────────────────────────────────────────

function WorkflowBody({ run, traceStepId, toolInvocationId, onAnchorLayout }: {
  run: WorkflowRun;
  traceStepId?: string;
  toolInvocationId?: string;
  onAnchorLayout?: (y: number) => void;
}) {
  const router = useRouter();
  const result = useMemo(() => {
    if (!run.outputs || Object.keys(run.outputs).length === 0) return null;
    return safeJson(run.outputs);
  }, [run.outputs]);

  // A tiny at-a-glance tally next to the "Steps" label — total plus any
  // failed / still-running counts, so the run's health reads without
  // scanning every card.
  const total = run.trace.length;
  const failed = run.trace.filter((e) => e.status === 'failed').length;
  const running = run.trace.filter((e) => e.status === 'running').length;
  const tally = [
    `${total} step${total === 1 ? '' : 's'}`,
    failed ? `${failed} failed` : null,
    running ? `${running} running` : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <View style={styles.stepsHead}>
        <Text style={styles.sectionLabel}>Steps</Text>
        {total > 0 ? <Text style={styles.stepsTally}>{tally}</Text> : null}
      </View>
      {run.trace.length === 0 ? (
        <EmptyNote text="No steps were recorded for this run." />
      ) : (
        // An ai-prompt node ran as its own durable child session → render it
        // through the same StepRow shell as every other node (AiNodeCard), so
        // it reads as part of the same family — but tapping it deep-links into
        // that node's full conversation (where the session-details drawer
        // shows its context-window usage) instead of expanding inline. Every other
        // node type has no session to open, so it stays a StepCard.
        run.trace.map((entry, i) => {
          const stableId = entry.id || entry.trace_step_id || `${entry.node_id}-${i}`;
          const anchored = !!traceStepId && stableId === traceStepId;
          return (
          <View
            key={stableId}
            nativeID={`workflow-step-${encodeURIComponent(stableId)}`}
            style={anchored ? styles.anchorStep : undefined}
            onLayout={anchored
              ? (event) => onAnchorLayout?.(event.nativeEvent.layout.y)
              : undefined}
          >
            {entry.child_session_id ? (
              <AiNodeCard
                entry={entry}
                onOpen={(id) => openDetached(router, `chat?session=${encodeURIComponent(id)}`)}
              />
            ) : (
              <StepCard entry={entry} forceExpanded={anchored || (
                !!toolInvocationId && entry.tool_invocation_ids?.includes(toolInvocationId)
              )} />
            )}
          </View>
          );
        })
      )}
      {run.error ? <ErrorBlock text={run.error} /> : null}
      {result ? (
        <AssistantBlock label="Result" text={'```json\n' + result + '\n```'} />
      ) : null}
    </>
  );
}

// The shared visual shell for one workflow node — a colored status rail down
// the left, an icon chip for the node kind, a friendly label + node id, a
// one-line human summary, and a compact status pill with the duration. Both
// the generic StepCard and the AI-node card render through this so every step
// (tool call, wait, condition, AI node…) reads as the same family of card.
// ``trailing`` is the right-edge affordance (an expand chevron, a navigate
// chevron, or nothing); ``children`` is the optional expanded body.
function StepRow({
  icon, label, nodeId, summary, status, statusColor, duration, trailing, children,
}: {
  icon: IconName;
  label: string;
  nodeId: string;
  summary?: string;
  status: string;
  statusColor: string;
  duration: string;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={styles.stepRow}>
      <View style={[styles.stepAccent, { backgroundColor: statusColor }]} />
      <View style={styles.stepMain}>
        <View style={styles.stepHeader}>
          <View style={styles.stepIconChip}>
            <Feather name={icon} size={13} color={colors.textSecondary} />
          </View>
          <View style={styles.stepTexts}>
            <View style={styles.stepTitleRow}>
              <Text style={styles.stepLabel} numberOfLines={1}>{label}</Text>
              <Text style={styles.stepNodeTag} numberOfLines={1}>{nodeId}</Text>
            </View>
            {summary ? (
              <Text style={styles.stepSummary} numberOfLines={1}>{summary}</Text>
            ) : null}
          </View>
          <View style={styles.stepRight}>
            <View style={[styles.stepPill, { borderColor: statusColor }]}>
              <View style={[styles.stepPillDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.stepPillText, { color: statusColor }]}>{status}</Text>
            </View>
            <Text style={styles.stepDuration}>{duration}</Text>
          </View>
          {trailing}
        </View>
        {children}
      </View>
    </View>
  );
}

function StepCard({ entry, forceExpanded }: { entry: WorkflowTraceEntry; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(!!forceExpanded);
  useEffect(() => {
    if (forceExpanded) setExpanded(true);
  }, [forceExpanded]);
  const meta = nodeMeta(entry.type);
  const color = STATUS_COLOR[entry.status] ?? colors.textMuted;
  const summary = nodeSummary(entry);
  const expandable = isExpandable(entry);
  const hasError = !!entry.error;

  const row = (
    <StepRow
      icon={meta.icon}
      label={meta.label}
      nodeId={entry.node_id}
      summary={summary}
      status={entry.status}
      statusColor={color}
      duration={formatDuration(entry.started_at, entry.finished_at, entry.status)}
      trailing={expandable ? (
        <Feather
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={14}
          color={colors.textMuted}
          style={styles.stepChevron}
        />
      ) : null}
    >
      {expandable && expanded ? (
        <View style={styles.stepBody}>
          {entry.input != null ? (
            <CodeSection label="input" value={safeJson(entry.input)} />
          ) : null}
          {entry.output != null ? (
            <CodeSection label="output" value={safeJson(entry.output)} />
          ) : null}
          {entry.error ? (
            <CodeSection label="error" value={entry.error} tone="error" />
          ) : null}
        </View>
      ) : null}
    </StepRow>
  );

  // Simple nodes are a plain, non-clickable card; only substantial ones
  // (tool calls, HTTP requests, anything that errored) get the tap-to-expand
  // affordance.
  if (!expandable) {
    return (
      <View style={[styles.stepCard, hasError && styles.stepCardError]} {...(webFade as any)}>
        {row}
      </View>
    );
  }
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => setExpanded((v) => !v)}
      style={[styles.stepCard, hasError && styles.stepCardError]}
      accessibilityRole="button"
      accessibilityLabel={`${meta.label} ${entry.node_id}, ${entry.status}. Tap to ${expanded ? 'collapse' : 'expand'}.`}
      {...(webFade as any)}
    >
      {row}
    </TouchableOpacity>
  );
}

// An ai-prompt node ran as its own durable child session. It renders through
// the SAME StepRow shell as every other node (so it visually belongs to the
// same family — friendly "AI node" label on top, node id, status pill) but,
// instead of expanding in place, tapping it deep-links into that node's full
// conversation. Its summary line shows the model it ran on: the pinned
// ``model_override`` immediately, upgraded to the model the child session
// actually used (the router may have chosen it) once that session's context
// report resolves.
function AiNodeCard({
  entry, onOpen,
}: {
  entry: WorkflowTraceEntry;
  onOpen: (childSessionId: string) => void;
}) {
  const sid = entry.child_session_id;
  const meta = nodeMeta('ai-prompt');
  const color = STATUS_COLOR[entry.status] ?? colors.textMuted;
  const pinned = (entry.input as Record<string, any> | undefined)?.model_override as
    | string
    | undefined;
  const [model, setModel] = useState<string | undefined>(pinned || undefined);

  useEffect(() => {
    if (!sid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const live = entry.status === 'running';
    const tick = async () => {
      try {
        const rep = await getSessionContext(sid);
        if (cancelled) return;
        const m = rep?.model_label || rep?.model;
        if (m) { setModel(m); return; }  // resolved — stop polling
      } catch { /* ignore transient fetch errors */ }
      attempts += 1;
      // A live node's session may not have a model resolved on the first read;
      // retry a few times. A finished node reads once (twice at most).
      if (!cancelled && attempts < (live ? 6 : 2)) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sid, entry.status]);

  const clickable = !!sid;
  const row = (
    <StepRow
      icon={meta.icon}
      label={meta.label}
      nodeId={entry.node_id}
      summary={model}
      status={entry.status}
      statusColor={color}
      duration={formatDuration(entry.started_at, entry.finished_at, entry.status)}
      trailing={clickable ? (
        <Feather name="chevron-right" size={16} color={colors.textMuted} style={styles.stepChevron} />
      ) : null}
    />
  );

  if (!clickable) {
    // No session yet (a node that failed before minting one) — a plain,
    // non-clickable card, same as a simple step.
    return <View style={styles.stepCard} {...(webFade as any)}>{row}</View>;
  }
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onOpen(sid!)}
      style={[styles.stepCard, styles.stepCardAi]}
      accessibilityRole="button"
      accessibilityLabel={`Open AI node ${entry.node_id} conversation`}
      {...(Platform.OS === 'web' ? { className: 'oa-fade-in oa-row-hover oa-card-hover' } : {})}
    >
      {row}
    </TouchableOpacity>
  );
}

function CodeSection({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'error';
}) {
  return (
    <>
      <Text
        style={[styles.sectionTitle, tone === 'error' && { color: colors.error }]}
      >
        {label}
      </Text>
      <View
        style={[styles.codeBlock, tone === 'error' && { borderColor: colors.errorBorder }]}
      >
        <Text
          style={[styles.codeText, tone === 'error' && { color: colors.error }]}
        >
          {value}
        </Text>
      </View>
    </>
  );
}

// ── Chat-like atoms ──────────────────────────────────────────────────

function AssistantBlock({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.assistantBlock} {...(webFade as any)}>
      <View style={styles.assistantHead}>
        <View style={styles.assistantDot} />
        <Text style={styles.assistantLabel}>{label}</Text>
        <CopyButton text={text} />
      </View>
      <View style={styles.assistantBody}>
        <Markdown text={text} />
      </View>
    </View>
  );
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <View style={styles.errorBlock} {...(webFade as any)}>
      <View style={styles.assistantHead}>
        <Feather name="alert-triangle" size={12} color={colors.error} />
        <Text style={[styles.assistantLabel, { color: colors.error }]}>Error</Text>
        <CopyButton text={text} />
      </View>
      <Text style={styles.errorBody} selectable>
        {text}
      </Text>
    </View>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <Text style={styles.emptyNote}>{text}</Text>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };
  return (
    <TouchableOpacity
      style={styles.copyBtn}
      onPress={doCopy}
      accessibilityLabel={copied ? 'Copied' : 'Copy'}
    >
      <Feather
        name={copied ? 'check' : 'copy'}
        size={11}
        color={copied ? colors.success : colors.textMuted}
      />
    </TouchableOpacity>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function formatDuration(
  startedAt: number,
  finishedAt: number | null,
  status: string,
): string {
  if (finishedAt != null && startedAt) {
    return (finishedAt - startedAt).toFixed(2) + 's';
  }
  return status === 'running' || status === 'received' ? '…' : '—';
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const styles = StyleSheet.create({
  anchorStep: {
    backgroundColor: colors.hover,
    borderRadius: radius.md,
  },
  runLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  runLinkText: { color: colors.text, fontSize: 13, fontWeight: '500' },
  root: { flex: 1 },
  scroll: { flex: 1 },
  jumpToBottom: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 5,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 3,
  },
  jumpToBottomWithComposer: { bottom: 88 },
  messagesContent: { paddingVertical: 12, paddingBottom: 12 },
  messagesInner: {
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 20,
  },
  statusPane: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  errorText: { fontSize: 12, color: colors.error, textAlign: 'center' },

  // Header banner
  runHeader: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 18,
  },
  runHeaderTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    fontFamily: font.sans,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusPillText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: font.mono,
  },

  // Section label ("Steps") + at-a-glance tally
  stepsHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  stepsTally: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: font.mono,
  },

  // Workflow step card
  stepCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: 8,
    overflow: 'hidden',
  },
  stepCardError: { borderColor: colors.errorBorder },
  // AI node cards navigate (rather than expand) — a slightly stronger border
  // hints they lead somewhere, reinforced by the web hover affordance.
  stepCardAi: { borderColor: colors.border },
  // Row = colored status rail + main content column.
  stepRow: { flexDirection: 'row', alignItems: 'stretch' },
  stepAccent: { width: 3 },
  stepMain: { flex: 1, minWidth: 0 },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  stepIconChip: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: colors.mutedSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepTexts: { flex: 1, minWidth: 0, gap: 2 },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  stepLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
  },
  stepNodeTag: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: font.mono,
  },
  stepSummary: {
    fontSize: 11.5,
    color: colors.textSecondary,
    fontFamily: font.mono,
  },
  stepRight: { alignItems: 'flex-end', gap: 3 },
  stepPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  stepPillDot: { width: 5, height: 5, borderRadius: 3 },
  stepPillText: {
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  stepDuration: {
    fontSize: 9.5,
    color: colors.textMuted,
    fontFamily: font.mono,
  },
  stepChevron: { marginLeft: 2 },
  stepBody: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 2,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    marginTop: 8,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  codeBlock: {
    backgroundColor: colors.codeBg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.codeBorder,
    padding: 8,
  },
  codeText: {
    fontSize: 11,
    color: colors.codeText,
    fontFamily: font.mono,
    lineHeight: 16,
  },

  // Assistant-style output block (mirrors MessageList)
  assistantBlock: { paddingVertical: 10, marginTop: 6 },
  assistantHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  assistantDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
    // @ts-ignore web: gradient background
    ...(Platform.OS === 'web'
      ? { backgroundImage: 'linear-gradient(135deg, #d94841, #f3a33a)' }
      : {}),
  },
  assistantLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  assistantBody: {},
  copyBtn: {
    width: 22,
    height: 22,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },

  // Error block
  errorBlock: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: 12,
  },
  errorBody: {
    fontSize: 11,
    color: colors.error,
    fontFamily: font.mono,
    lineHeight: 16,
  },

  emptyNote: {
    fontSize: 12,
    color: colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  transcriptRetry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  transcriptRetryText: {
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: font.mono,
  },
});
