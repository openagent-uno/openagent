/**
 * MessageList — shared message-display layer.
 *
 * Renders a session's transcript with the same look on both Chat and
 * Voice tabs: user prompts as soft rounded surfaces, assistant replies as
 * full-width prose, tool calls as inline expandable cards. Consecutive rows
 * from one speaker share a single author header. The status row ("Thinking…")
 * trails the last message while ``isProcessing``.
 *
 * Both screens share this so a stylistic change to message bubbles
 * lands uniformly. Pass ``maxItems`` to compact the view (Voice tab
 * tail-shows the last few turns); omit for the full transcript.
 */

import { Fragment, memo, useEffect, useState, useMemo, type ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import {
  toolPhase,
  runLaunchTarget,
  effectiveTool,
  isDelegationTool,
  delegationTitle,
  delegationLabel,
  toolDisplay,
  memoryTarget,
  compactionDisplay,
  type Attachment,
  type ChatMessage,
  type CompactionInfo,
  type MessageAuthor,
  type MemoryTarget,
  type RunLaunchTarget,
  type ToolInfo,
} from '../../common/types';
import type { MessagePart } from '../../common/ui-views';
import { attachmentKey } from '../../common/attachments';
import { messageHeaderVisibility, messageTurnTimeline } from '../../common/message-groups';
import {
  compactToolFallback,
  legacyToolInfoFromText,
  toolCardHasExpandableDetails,
  toolMessageRenderKey,
} from '../../common/tool-presentation';
import AttachmentBlock from './Attachments';
import Markdown from './Markdown';
import DelegationCard from './DelegationCard';
import RunLaunchCard from './RunLaunchCard';
import ReasoningIndicator from './ReasoningIndicator';
import { colors, font, radius } from '../theme';
import UIViewSurface from './ui/UIViewSurface';

// How many trailing messages to render before "Load earlier". Caps the
// DOM + per-delta reconciliation on long transcripts to a fixed window.
const TRANSCRIPT_WINDOW = 60;

export interface MessageListProps {
  messages: ChatMessage[];
  isProcessing?: boolean;
  statusText?: string;
  /** When true, the status row shows the animated <ReasoningIndicator/>
   *  instead of the static status dot + text. Driven by the session's
   *  ``isReasoning`` flag (the transient ``reasoning`` wire frame). */
  isReasoning?: boolean;
  /** Slice the tail when set (Voice tab uses ~6). Omit for full history. */
  maxItems?: number;
  /** Fired by the per-bubble Regenerate button on the last (non-streaming)
   *  assistant message. Omit to hide the button entirely. */
  onRegenerate?: () => void;
  /** Fired by the per-bubble Edit button on a user message. Omit to hide. */
  onEditUser?: (msgId: string, newText: string) => void;
  /** Fired when a delegation card is pressed — navigates into the child
   *  session. Omit to render delegation cards as non-clickable. */
  onOpenChild?: (childSessionId: string, meta?: { title?: string; model?: string }) => void;
  /** Fired when a run-launch card (scheduled task / workflow run) is pressed —
   *  opens that run's execution screen. Omit to render such cards as
   *  non-clickable. */
  onOpenRun?: (target: RunLaunchTarget) => void;
  /** Fired when a memory-vault tool chip's "open" link is pressed — deep-links
   *  into the Memory tab (a single note's markdown screen, or the graph). Omit
   *  to render memory chips without the link affordance. */
  onOpenMemory?: (target: MemoryTarget) => void;
  /** The current user's handle/display, used as the fallback "You" label
   *  when a user message carries no explicit author. */
  currentUserHandle?: string;
  /** Stable v2 anchor selected from operational search. */
  anchorMessageId?: string;
  anchorToolInvocationId?: string;
  /** Native ScrollView owner uses the measured anchor offset to center it. */
  onAnchorLayout?: (y: number) => void;
  /** Canonical v2 transcript pagination. Local DOM windowing is exhausted
   * before this asks the server for the preceding page. */
  hasMoreBefore?: boolean;
  onLoadEarlier?: () => Promise<void>;
}

function MessageListBase({
  messages, isProcessing, statusText, isReasoning, maxItems, onRegenerate, onEditUser,
  onOpenChild, onOpenRun, onOpenMemory, currentUserHandle,
  anchorMessageId, anchorToolInvocationId, onAnchorLayout,
  hasMoreBefore, onLoadEarlier,
}: MessageListProps) {
  // Windowing: render only the last `shown` messages. With bottom-pinned
  // scroll the tail is what the user sees; a long transcript otherwise
  // materializes thousands of deeply-nested DOM nodes and re-maps + diffs
  // ALL of them on every streaming delta. "Load earlier" widens the
  // window. The Voice tab passes maxItems and keeps its own tail-slice.
  const [shown, setShown] = useState(TRANSCRIPT_WINDOW);
  const capped = maxItems != null;
  const visible = useMemo(
    () => (capped
      ? messages.slice(-maxItems!)
      : (shown >= messages.length ? messages : messages.slice(-shown))),
    [messages, capped, maxItems, shown],
  );
  const hiddenCount = capped ? 0 : Math.max(0, messages.length - visible.length);
  const headerVisibility = useMemo(
    () => messageHeaderVisibility(visible),
    [visible],
  );
  const turnTimeline = useMemo(
    () => messageTurnTimeline(visible),
    [visible],
  );
  const resolvedAnchorMessageId = useMemo(() => {
    if (anchorMessageId) return anchorMessageId;
    if (!anchorToolInvocationId) return undefined;
    return messages.find((message) => (
      message.toolInvocationId === anchorToolInvocationId
      || message.toolInfo?.tool_invocation_id === anchorToolInvocationId
    ))?.id;
  }, [anchorMessageId, anchorToolInvocationId, messages]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const canLoadEarlier = !capped && (hiddenCount > 0 || (!!hasMoreBefore && !!onLoadEarlier));
  const loadEarlier = async () => {
    if (loadingEarlier) return;
    if (hiddenCount > 0) {
      setShown((n) => n + TRANSCRIPT_WINDOW);
      return;
    }
    if (!onLoadEarlier || !hasMoreBefore) return;
    setLoadingEarlier(true);
    try {
      await onLoadEarlier();
      setShown((n) => n + TRANSCRIPT_WINDOW);
    } finally {
      setLoadingEarlier(false);
    }
  };
  useEffect(() => {
    if (!resolvedAnchorMessageId || capped) return;
    const index = messages.findIndex((message) => message.id === resolvedAnchorMessageId);
    if (index < 0) return;
    setShown((current) => Math.max(current, messages.length - index));
  }, [resolvedAnchorMessageId, capped, messages]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resolvedAnchorMessageId || typeof document === 'undefined') return;
    const timer = setTimeout(() => {
      const element = document.getElementById(`message-anchor-${encodeURIComponent(resolvedAnchorMessageId)}`);
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      element?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [resolvedAnchorMessageId, visible]);
  // Identify the last assistant message — Regenerate only attaches to
  // it, not to every assistant bubble in the transcript.
  const lastAssistantId = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const m = visible[i];
      if (m.role === 'assistant' && !m.streaming) return m.id;
    }
    return null;
  }, [visible]);
  const renderMessage = (msg: ChatMessage, index: number) => {
    const isAnchor = msg.id === resolvedAnchorMessageId;
    const turnMeta = turnTimeline[index];
    const turnTimestamp = turnMeta?.timestamp;
    const showAuthorHeader = (headerVisibility[index] ?? true)
      || !!turnMeta?.showDayDivider;
    const renderKey = msg.role === 'tool'
      ? toolMessageRenderKey(msg.id, msg.toolInfo, msg.toolInvocationId)
      : msg.id;
    const wrap = (node: ReactNode) => {
      const content = (
        <>
          {turnMeta?.showDayDivider && turnTimestamp != null
            ? <DayDivider timestamp={turnTimestamp} />
            : null}
          {node}
        </>
      );
      // Search highlighting needs one measurable wrapper, but wrapping every
      // ordinary row changed the stable chat layout and web DOM. Keep normal
      // messages structurally identical to main.
      if (!isAnchor) return <Fragment key={renderKey}>{content}</Fragment>;
      return (
        <View
          key={renderKey}
          nativeID={`message-anchor-${encodeURIComponent(msg.id)}`}
          style={styles.anchorMessage}
          onLayout={onAnchorLayout
            ? (event) => onAnchorLayout(event.nativeEvent.layout.y)
            : undefined}
          accessible
          accessibilityLabel="Search result message"
          {...(Platform.OS === 'web' ? ({ tabIndex: -1 } as any) : {})}
        >
          {content}
        </View>
      );
    };
    if (msg.role === 'compaction') {
      // In-place compaction (vision §2) renders as a tool-style card:
      // a live "Compacting…" spinner that resolves to "Compacted
      // conversation", with the run/token stats in the expanded body.
      return wrap(<CompactionCard info={msg.compactionInfo} />);
    }
    if (msg.role === 'tool') {
      // A delegation renders as a card (deep-links into the sub-agent's
      // child session, OpenCode-style) instead of an inline tool chip —
      // even while it's still RUNNING (the card is non-clickable until the
      // child_session_id arrives at completion), so the parent never shows
      // the raw delegate-tool prompt or the sub-agent's own work inline.
      if (isDelegationTool(msg.toolInfo)) {
        const eff = effectiveTool(msg.toolInfo)!;
        return wrap(
          <DelegationCard
            childSessionId={eff.child_session_id}
            title={delegationTitle(msg.toolInfo)}
            model={eff.child_model}
            label={delegationLabel(msg.toolInfo)}
            phase={toolPhase(msg.toolInfo!)}
            onOpen={onOpenChild}
          />,
        );
      }
      // A run-now of a scheduled task / workflow renders as a card that
      // deep-links into that run's execution screen (not an inline tool chip).
      const runTarget = runLaunchTarget(msg.toolInfo);
      if (runTarget) {
        return wrap(<RunLaunchCard target={runTarget} onOpen={onOpenRun} />);
      }
      return wrap(
        <ToolCard
          toolInfo={msg.toolInfo}
          fallbackText={msg.text}
          onOpenMemory={onOpenMemory}
          toolInvocationId={msg.toolInvocationId}
          durableStatus={msg.durableStatus}
        />,
      );
    }
    if (msg.role === 'user') {
      // An agent-self seed (a delegated task / scheduled mission / workflow
      // node prompt the agent gave itself) renders as a Mission block,
      // not a "You" bubble.
      if (msg.author?.kind === 'agent') {
        return wrap(
          <SelfPromptBlock
            text={msg.text}
            label={msg.author.display}
            timestamp={turnTimestamp}
          />,
        );
      }
      return wrap(
        <UserMessage
          id={msg.id} text={msg.text} attachments={msg.attachments}
          parts={msg.parts}
          author={msg.author} fallbackLabel={currentUserHandle}
          showHeader={showAuthorHeader}
          timestamp={turnTimestamp}
          onEdit={onEditUser}
        />,
      );
    }
    return wrap(
      <AssistantMessage
        text={msg.text} model={msg.model} attachments={msg.attachments}
        parts={msg.parts}
        streaming={msg.streaming} author={msg.author}
        showHeader={showAuthorHeader}
        timestamp={turnTimestamp}
        onRegenerate={msg.id === lastAssistantId && !isProcessing ? onRegenerate : undefined}
      />,
    );
  };
  return (
    <>
      {canLoadEarlier && (
        <TouchableOpacity
          style={styles.loadEarlier}
          onPress={() => { void loadEarlier(); }}
          disabled={loadingEarlier}
          accessibilityLabel="Load earlier messages"
          // @ts-ignore — web hover/press affordance
          {...(Platform.OS === 'web' ? { className: 'oa-side-row oa-press' } : {})}
        >
          {loadingEarlier
            ? <ActivityIndicator size="small" color={colors.textMuted} />
            : <Feather name="chevron-up" size={12} color={colors.textMuted} />}
          <Text style={styles.loadEarlierText}>
            {loadingEarlier
              ? 'Loading earlier…'
              : hiddenCount > 0 ? `Load earlier (${hiddenCount})` : 'Load earlier'}
          </Text>
        </TouchableOpacity>
      )}
      {visible.map(renderMessage)}
      {(isProcessing || isReasoning) && (() => {
        // The animated indicator is the DEFAULT "agent is working" state —
        // shown whenever we're processing without a specific tool line to
        // display (the generic "Thinking…" placeholder). It does NOT depend
        // on the server's ``reasoning`` frame (older/remote agents don't
        // send it); that frame just reinforces ``isReasoning``. Only a real
        // tool-status line (e.g. "Using bash…") falls through to the text row.
        const isGenericThinking = !statusText || /^thinking/i.test(statusText.trim());
        const showIndicator = isReasoning || isGenericThinking;
        return (
          <View style={styles.statusRow}>
            {showIndicator ? (
              <ReasoningIndicator />
            ) : (
              <>
                <View
                  style={styles.statusDot}
                  // @ts-ignore — web-only className for the pulse keyframe
                  {...(Platform.OS === 'web' ? { className: 'oa-pulse' } : {})}
                />
                <Text style={styles.statusText}>{statusText}</Text>
              </>
            )}
          </View>
        );
      })()}
    </>
  );
}

// Memoized so a parent re-render (e.g. chat.tsx re-rendering for an
// unrelated reason) doesn't re-map the transcript unless `messages` (or
// another prop) actually changed.
const MessageList = memo(MessageListBase);
export default MessageList;

// ── Atoms ────────────────────────────────────────────────────────────

const UserMessage = memo(function UserMessage({
  id, text, attachments, parts, author, fallbackLabel, showHeader, timestamp, onEdit,
}: {
  id: string;
  text: string;
  attachments?: Attachment[];
  parts?: MessagePart[];
  author?: MessageAuthor;
  fallbackLabel?: string;
  showHeader: boolean;
  timestamp?: number;
  onEdit?: (id: string, newText: string) => void;
}) {
  const label = author?.display || author?.handle || fallbackLabel || 'You';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const actions = !editing ? (
    <View style={[styles.msgActions, !showHeader && styles.continuationActions]}>
      <CopyButton text={text} />
      {onEdit && (
        <TouchableOpacity
          style={styles.msgActionBtn}
          // @ts-ignore — web hover/press affordance
          {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
          onPress={() => { setDraft(text); setEditing(true); }}
          accessibilityLabel="Edit message"
        >
          <Feather name="edit-2" size={11} color={colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  ) : null;
  return (
    <View
      style={[styles.userBlock, !showHeader && styles.userContinuation]}
      testID="oa-user-message"
      // @ts-ignore
      {...(Platform.OS === 'web' ? { className: 'oa-msg-in oa-row-hover' } : {})}
    >
      <View style={[styles.userBody, !showHeader && styles.continuationBody]}>
        {showHeader ? (
          <View style={styles.userHead} testID="oa-human-message-header">
            <Text style={styles.userLabel}>{label}</Text>
            {actions}
            <TurnTime timestamp={timestamp} flushToTranscriptEdge />
          </View>
        ) : actions}
        {editing ? (
          <>
            <View style={styles.editBox}>
              <Text
                // @ts-ignore — pass-through to underlying div as a textarea wrapper
                style={styles.editPlaceholder}
              >
                {Platform.OS === 'web' ? (
                  // @ts-ignore — RNW lets us drop in a real textarea inline
                  <textarea
                    value={draft}
                    onChange={(e: any) => setDraft(e.target.value)}
                    rows={Math.max(2, draft.split('\n').length)}
                    autoFocus
                    style={{
                      width: '100%', background: 'transparent', border: 'none',
                      color: colors.text, fontSize: 14, lineHeight: 1.5,
                      fontFamily: font.sans, padding: 0, resize: 'vertical',
                      outline: 'none', minHeight: 60,
                    } as any}
                  />
                ) : draft}
              </Text>
            </View>
            <View style={styles.editActionsRow}>
              <TouchableOpacity
                style={styles.editCancelBtn}
                // @ts-ignore — web press affordance
                {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
                onPress={() => { setEditing(false); setDraft(text); }}
              >
                <Text style={styles.editCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.editSendBtn}
                // @ts-ignore — web press affordance
                {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
                onPress={() => {
                  const trimmed = draft.trim();
                  if (!trimmed) return;
                  setEditing(false);
                  onEdit?.(id, trimmed);
                }}
              >
                <Text style={styles.editSendText}>Send</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          parts?.length ? <OrderedParts parts={parts} assistant={false} />
            : text ? <Text style={styles.userText} selectable>{text}</Text> : null
        )}
        {!editing && !parts?.length && <AttachmentBlock attachments={attachments} />}
      </View>
    </View>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  text, model, attachments, parts, streaming, author, showHeader, timestamp, onRegenerate,
}: {
  text: string;
  model?: string;
  attachments?: Attachment[];
  parts?: MessagePart[];
  streaming?: boolean;
  author?: MessageAuthor;
  showHeader: boolean;
  timestamp?: number;
  onRegenerate?: () => void;
}) {
  const label = author?.display || 'OpenAgent';
  const actions = !streaming ? (
    <View style={[styles.msgActions, !showHeader && styles.continuationActions]}>
      <CopyButton text={text} />
      {onRegenerate && (
        <TouchableOpacity
          style={styles.msgActionBtn}
          // @ts-ignore — web hover/press affordance
          {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
          onPress={onRegenerate}
          accessibilityLabel="Regenerate response"
        >
          <Feather name="refresh-cw" size={11} color={colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  ) : null;
  return (
    <View
      style={[styles.assistantBlock, !showHeader && styles.assistantContinuation]}
      testID="oa-assistant-message"
      // @ts-ignore
      {...(Platform.OS === 'web' ? { className: 'oa-msg-in oa-row-hover' } : {})}
    >
      {showHeader ? (
        <View style={styles.assistantHead} testID="oa-agent-message-header">
          <Text style={styles.assistantLabel} testID="oa-agent-message-label">{label}</Text>
          {model && <Text style={styles.modelText}>· {model}</Text>}
          <View style={styles.headerSpacer} />
          {actions}
          <TurnTime timestamp={timestamp} />
        </View>
      ) : actions}
      <View style={[styles.assistantBody, !showHeader && styles.continuationBody]}>
        {parts?.length ? <OrderedParts parts={parts} assistant /> : (
          <>
            <Markdown text={text} streaming={streaming} />
            <AttachmentBlock attachments={attachments} downloadable />
          </>
        )}
      </View>
    </View>
  );
});

const OrderedParts = memo(function OrderedParts({
  parts,
  assistant,
}: {
  parts: MessagePart[];
  assistant: boolean;
}) {
  return (
    <Fragment>
      {parts.map((part, index) => {
        if (part.kind === 'text') {
          return assistant
            ? <Markdown key={`text-${index}`} text={part.text} />
            : <Text key={`text-${index}`} style={styles.userText} selectable>{part.text}</Text>;
        }
        if (part.kind === 'attachment') {
          return (
            <AttachmentBlock
              key={`attachment-${attachmentKey(part.attachment)}-${index}`}
              attachments={[part.attachment]}
              downloadable={assistant}
            />
          );
        }
        return (
          <UIViewSurface
            key={`ui-${part.view_id}-${index}`}
            viewId={part.view_id}
            revision={part.revision}
            mode="inline"
          />
        );
      })}
    </Fragment>
  );
});

// Generic copy-to-clipboard button used by both user + assistant headers.
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
      style={styles.msgActionBtn}
      // @ts-ignore — web hover/press affordance
      {...(Platform.OS === 'web' ? { className: 'oa-icon-btn' } : {})}
      onPress={doCopy}
      accessibilityLabel={copied ? 'Copied' : 'Copy message'}
    >
      <Feather
        name={copied ? 'check' : 'copy'}
        size={11}
        color={copied ? colors.success : colors.textMuted}
      />
    </TouchableOpacity>
  );
}

// The agent-authored seed of a child session — the task/mission/role prompt
// the agent gave itself. Rendered distinctly so it reads as "the agent set
// itself this task", not as a human "You" message.
const SelfPromptBlock = memo(function SelfPromptBlock({
  text, label, timestamp,
}: { text: string; label?: string; timestamp?: number }) {
  return (
    <View
      style={styles.selfPromptBlock}
      // @ts-ignore
      {...(Platform.OS === 'web' ? { className: 'oa-msg-in' } : {})}
    >
      <View style={styles.selfPromptRule} />
      <View style={styles.userBody}>
        <View style={styles.userHead}>
          <Feather name="target" size={11} color={colors.accent} />
          <Text style={styles.selfPromptLabel}>{(label || 'Mission').toUpperCase()}</Text>
          <TurnTime timestamp={timestamp} />
        </View>
        <Markdown text={text} />
      </View>
    </View>
  );
});

function TurnTime({
  timestamp,
  flushToTranscriptEdge = false,
}: {
  timestamp?: number;
  flushToTranscriptEdge?: boolean;
}) {
  if (timestamp == null) return null;
  const label = new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Text
      style={[styles.turnTime, flushToTranscriptEdge && styles.turnTimeFlushRight]}
      testID="oa-message-turn-time"
    >
      {label}
    </Text>
  );
}

function DayDivider({ timestamp }: { timestamp: number }) {
  const label = new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return (
    <View
      style={styles.dayDivider}
      testID="oa-message-day-divider"
      accessibilityLabel={`Messages from ${label}`}
    >
      <Text style={styles.dayDividerText}>{label}</Text>
    </View>
  );
}

const ToolCard = memo(function ToolCard({
  toolInfo, fallbackText, onOpenMemory, toolInvocationId, durableStatus,
}: {
  toolInfo?: ToolInfo;
  fallbackText: string;
  onOpenMemory?: (target: MemoryTarget) => void;
  toolInvocationId?: string;
  durableStatus?: ChatMessage['durableStatus'];
}) {
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo<ToolInfo | undefined>(() => {
    if (toolInfo) return toolInfo;
    return legacyToolInfoFromText(fallbackText);
  }, [toolInfo, fallbackText]);

  const info = parsed;

  if (!info) {
    const isRunning = durableStatus === 'streaming';
    const isError = durableStatus === 'failed';
    const isStopped = durableStatus === 'cancelled' || durableStatus === 'interrupted';
    const statusColor = isError ? colors.error : isRunning ? colors.warning : isStopped ? colors.textMuted : colors.success;
    const statusLabel = isRunning ? 'running' : isError ? 'error' : isStopped ? 'stopped' : 'done';
    return (
      <View
        style={[styles.toolCard, isError && styles.toolCardError]}
        accessibilityLabel={toolInvocationId ? `Tool usage ${statusLabel}` : undefined}
        // @ts-ignore — web animation class only
        {...(Platform.OS === 'web' ? { className: 'oa-msg-in' } : {})}
      >
        <View style={styles.toolCardHeader}>
          <View style={[styles.toolStatusDot, { backgroundColor: statusColor }]} />
          <Feather name="tool" size={12} color={colors.textMuted} />
          <View style={styles.toolCardTitleWrap}>
            <Text style={styles.toolCardName} numberOfLines={1}>
              {compactToolFallback(fallbackText)}
            </Text>
          </View>
          <Text style={[styles.toolStatusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>
    );
  }

  // Phase derived locally from the wire tool-execution fields.
  // ``tool_call_error`` takes precedence; otherwise a populated
  // ``result`` flips us to "completed" and bare frames render as
  // "running".
  const phase = toolPhase(info);
  const isRunning = phase === 'running';
  const isError = phase === 'error';
  const isStopped = phase === 'stopped';
  const statusColor = isError
    ? colors.error
    : isRunning
      ? colors.warning
      : isStopped
        ? colors.textMuted
        : colors.success;
  const statusLabel = isRunning ? 'running' : isError ? 'error' : isStopped ? 'stopped' : 'done';
  // On error frames the message rides in ``result`` (the durable
  // carrier — stored ToolExecution rows don't keep the error text).
  const errorText = isError && typeof info.result === 'string'
    ? info.result
    : undefined;

  // Friendly, user-facing label/icon — the raw tool name + args remain in the
  // expanded body for debugging. Memory-vault ops additionally deep-link into
  // the Memory tab via the "open" affordance.
  const display = toolDisplay(info);
  const memTarget = display.isMemory ? memoryTarget(info) : undefined;
  const canOpenMemory = !!(memTarget && onOpenMemory);
  // The real tool the chip stands for (unwrapped from the dispatcher) — shown
  // in the debug body so the friendly title never hides what actually ran.
  const eff = effectiveTool(info);
  const rawName = eff?.tool_name || info.tool_name;
  const dispatched = info.tool_name === 'tool_search_call_tool';
  const executionHost = info.execution_host;
  const executionHostLabel = executionHost?.kind === 'client'
    ? `This computer${executionHost.device_label ? ` · ${executionHost.device_label}` : ''}`
    : executionHost?.kind === 'server' ? executionHost.device_label || 'OpenAgent server' : null;
  const hasArgs = !!(info.tool_args && Object.keys(info.tool_args).length > 0);
  const hasResult = !isError && info.result != null && info.result !== '';
  const canExpand = toolCardHasExpandableDetails(info);

  return (
    <TouchableOpacity
      activeOpacity={canExpand ? 0.85 : 1}
      onPress={() => { if (canExpand) setExpanded(!expanded); }}
      style={[
        styles.toolCard,
        display.isMemory && styles.toolCardMemory,
        isError && styles.toolCardError,
      ]}
      // @ts-ignore
      {...(Platform.OS === 'web' ? { className: 'oa-msg-in oa-card-hover' } : {})}
    >
      <View style={styles.toolCardHeader}>
        <View style={[styles.toolStatusDot, { backgroundColor: statusColor }]} />
        <Feather
          name={display.icon as any}
          size={12}
          color={display.isMemory ? colors.accent : colors.textMuted}
        />
        <View style={styles.toolCardTitleWrap}>
          <Text style={styles.toolCardName} numberOfLines={1}>
            {display.title}
            {display.detail ? (
              <Text style={styles.toolCardDetail}>{`  ${display.detail}`}</Text>
            ) : null}
          </Text>
        </View>
        {canOpenMemory && (
          <TouchableOpacity
            // Separate touch target so opening the note doesn't also toggle the
            // debug body. Stop propagation on web; RN's onPress doesn't bubble.
            onPress={(e) => {
              // @ts-ignore — web SyntheticEvent
              e?.stopPropagation?.();
              onOpenMemory!(memTarget!);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.toolOpenLink}
            accessibilityRole="link"
            accessibilityLabel={
              memTarget!.kind === 'note'
                ? `Open ${memTarget!.title} in Memory`
                : 'Open Memory'
            }
            // @ts-ignore — web hover affordance
            {...(Platform.OS === 'web' ? { className: 'oa-press' } : {})}
          >
            <Feather name="external-link" size={11} color={colors.accent} />
            <Text style={styles.toolOpenLinkText}>Open</Text>
          </TouchableOpacity>
        )}
        {executionHostLabel && (
          <View style={styles.toolHostBadge}>
            <Feather
              name={executionHost?.kind === 'client' ? 'monitor' : 'server'}
              size={9}
              color={executionHost?.kind === 'client' ? colors.accent : colors.textMuted}
            />
            <Text style={styles.toolHostText} numberOfLines={1}>{executionHostLabel}</Text>
          </View>
        )}
        <Text style={[styles.toolStatusText, { color: statusColor }]}>{statusLabel}</Text>
        {canExpand && (
          <Feather name={expanded ? 'chevron-down' : 'chevron-right'} size={12} color={colors.textMuted} />
        )}
      </View>

      {expanded && canExpand && (
        <View style={styles.toolCardBody}>
          <Text style={styles.toolSectionTitle}>Tool</Text>
          <View style={styles.toolCodeBlock}>
            <Text style={styles.toolCodeText}>
              <Text style={{ color: colors.primary }}>{rawName}</Text>
              {dispatched && (
                <Text style={{ color: colors.textMuted }}>
                  {`  (via tool_search_call_tool${eff?.server ? ` → ${eff.server}` : ''})`}
                </Text>
              )}
            </Text>
          </View>
          {executionHost && (
            <>
              <Text style={styles.toolSectionTitle}>Execution host</Text>
              <View style={styles.toolCodeBlock}>
                <Text style={styles.toolCodeText}>
                  {executionHost.kind === 'client'
                    ? `${executionHost.device_label} · client ${executionHost.client_instance_id}`
                    : executionHost.device_label}
                </Text>
              </View>
            </>
          )}
          {hasArgs && (
            <>
              <Text style={styles.toolSectionTitle}>Parameters</Text>
              <View style={styles.toolCodeBlock}>
                {Object.entries(info.tool_args || {}).map(([k, v]) => (
                  <Text key={k} style={styles.toolCodeText}>
                    <Text style={{ color: colors.primary }}>{k}</Text>
                    <Text style={{ color: colors.textMuted }}>: </Text>
                    {typeof v === 'string' ? v : JSON.stringify(v)}
                  </Text>
                ))}
              </View>
            </>
          )}
          {hasResult && (
            <>
              <Text style={styles.toolSectionTitle}>Result</Text>
              <View style={styles.toolCodeBlock}>
                <Text style={styles.toolCodeText} numberOfLines={10}>
                  {typeof info.result === 'string' ? info.result : JSON.stringify(info.result)}
                </Text>
              </View>
            </>
          )}
          {errorText && (
            <>
              <Text style={[styles.toolSectionTitle, { color: colors.error }]}>Error</Text>
              <View style={[styles.toolCodeBlock, { borderColor: colors.errorBorder }]}>
                <Text style={[styles.toolCodeText, { color: colors.error }]}>
                  {errorText}
                </Text>
              </View>
            </>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
});

// Right-hand phase label for the compaction card, mirroring ToolCard's
// running/done/error status word.
const COMPACTION_STATUS_LABEL: Record<CompactionInfo['phase'], string> = {
  running: 'compacting',
  done: 'done',
  error: 'skipped',
};

// In-place compaction (vision §2) rendered as a tool-style card: a live
// "Compacting conversation…" spinner that resolves to "Compacted
// conversation", with the run/token stats in the expandable body — the
// same card whether driven by the live ``session_compacted`` frame or
// rebuilt from a recap run on reopen.
const CompactionCard = memo(function CompactionCard({ info }: { info?: CompactionInfo }) {
  const [expanded, setExpanded] = useState(false);
  const phase = info?.phase ?? 'done';
  const display = compactionDisplay(info ?? { phase });
  const statusColor = phase === 'error'
    ? colors.error
    : phase === 'running' ? colors.warning : colors.success;
  const freed = (info?.tokensBefore ?? 0) - (info?.tokensAfter ?? 0);
  // Only offer the expander when we actually carry numbers — a live
  // "running" frame (or a legacy recap row) may have none.
  const rows: [string, string][] = [];
  if (info?.foldedRuns) rows.push(['Turns folded', String(info.foldedRuns)]);
  if (info?.keptRuns) rows.push(['Turns kept', String(info.keptRuns)]);
  if (info?.tokensBefore) rows.push(['Tokens before', info.tokensBefore.toLocaleString()]);
  if (info?.tokensAfter) rows.push(['Tokens after', info.tokensAfter.toLocaleString()]);
  if (freed > 0) rows.push(['Context freed', `~${freed.toLocaleString()} tokens`]);
  if (info?.summaryChars) rows.push(['Recap size', `${info.summaryChars.toLocaleString()} chars`]);
  const canExpand = rows.length > 0;

  return (
    <TouchableOpacity
      activeOpacity={canExpand ? 0.85 : 1}
      onPress={() => { if (canExpand) setExpanded(!expanded); }}
      style={[styles.toolCard, styles.compactionCard]}
      // @ts-ignore — web hover affordance
      {...(Platform.OS === 'web' ? { className: 'oa-msg-in oa-card-hover' } : {})}
    >
      <View style={styles.toolCardHeader}>
        <View
          style={[styles.toolStatusDot, { backgroundColor: statusColor }]}
          // @ts-ignore — web-only pulse while the fold runs
          {...(Platform.OS === 'web' && phase === 'running' ? { className: 'oa-pulse' } : {})}
        />
        <Feather name="archive" size={12} color={colors.accent} />
        <View style={styles.toolCardTitleWrap}>
          <Text style={styles.toolCardName} numberOfLines={1}>
            {display.title}
            {display.detail ? (
              <Text style={styles.toolCardDetail}>{`  ${display.detail}`}</Text>
            ) : null}
          </Text>
        </View>
        <Text style={[styles.toolStatusText, { color: statusColor }]}>
          {COMPACTION_STATUS_LABEL[phase]}
        </Text>
        {canExpand && (
          <Feather name={expanded ? 'chevron-down' : 'chevron-right'} size={12} color={colors.textMuted} />
        )}
      </View>

      {expanded && canExpand && (
        <View style={styles.toolCardBody}>
          <Text style={styles.toolSectionTitle}>Compaction</Text>
          <View style={styles.toolCodeBlock}>
            {rows.map(([k, v]) => (
              <Text key={k} style={styles.toolCodeText}>
                <Text style={{ color: colors.primary }}>{k}</Text>
                <Text style={{ color: colors.textMuted }}>: </Text>
                {v}
              </Text>
            ))}
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  anchorMessage: {
    backgroundColor: colors.hover,
    borderRadius: radius.md,
  },
  // "Load earlier" — widens the rendered transcript window.
  loadEarlier: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 8, marginVertical: 4, alignSelf: 'center',
    paddingHorizontal: 12, borderRadius: radius.sm,
  },
  loadEarlierText: {
    fontSize: 11, color: colors.textMuted, fontFamily: font.mono,
  },
  dayDivider: {
    alignSelf: 'center',
    paddingHorizontal: 10, paddingVertical: 4,
    marginTop: 12, marginBottom: 6,
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  dayDividerText: {
    color: colors.textMuted, fontFamily: font.mono,
    fontSize: 9.5, lineHeight: 13,
  },
  // User
  userBlock: {
    position: 'relative',
    paddingVertical: 10, paddingHorizontal: 12,
    marginVertical: 4,
    borderRadius: radius.md,
    backgroundColor: colors.hover,
  },
  userContinuation: { paddingTop: 8 },
  userBody: { flex: 1, paddingVertical: 2 },
  userHead: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 4,
  },
  userLabel: {
    flex: 1,
    fontSize: 10, fontWeight: '600', color: colors.primary,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  turnTime: {
    color: colors.textMuted, fontFamily: font.mono,
    fontSize: 9.5, lineHeight: 13,
    marginLeft: 8,
  },
  // User bubbles inset their content by 12px. Let only the timestamp reach the
  // shared transcript edge so human, agent and mission times form one column.
  turnTimeFlushRight: { marginRight: -12 },
  userText: {
    fontSize: 14, lineHeight: 22, color: colors.text,
    fontWeight: '400',
  },
  // Agent-self seed prompt (Mission / Role / Task) — an accent-ruled quote.
  selfPromptBlock: {
    flexDirection: 'row', alignItems: 'stretch',
    paddingVertical: 10, paddingLeft: 2,
  },
  selfPromptRule: {
    width: 2, backgroundColor: colors.accent,
    borderRadius: 1, marginRight: 12, opacity: 0.85,
  },
  selfPromptLabel: {
    flex: 1,
    fontSize: 10, fontWeight: '600', color: colors.accent,
    textTransform: 'uppercase', letterSpacing: 0.8, marginLeft: 6,
  },

  // Hover action buttons (Copy / Edit / Regenerate) — live in the first
  // message header, or at the top-right of a grouped continuation. Web-only
  // hover-reveal is layered on via ``.oa-row-hover`` (see theme.ts).
  msgActions: {
    flexDirection: 'row', gap: 2, marginLeft: 'auto',
    // @ts-ignore — web-only opacity for hover-reveal; native always-shown
    ...(Platform.OS === 'web' ? { opacity: 0, transition: 'opacity 0.16s' as any } : {}),
  },
  continuationActions: Platform.OS === 'web'
    ? {
        position: 'absolute', top: 4, right: 4, zIndex: 1,
      }
    : {
        alignSelf: 'flex-end', marginBottom: 2,
      },
  continuationBody: Platform.OS === 'web' ? { paddingRight: 52 } : {},
  msgActionBtn: {
    width: 22, height: 22, borderRadius: radius.xs,
    alignItems: 'center', justifyContent: 'center',
  },

  // Inline-edit affordance on user messages.
  editBox: {
    borderWidth: 1, borderColor: colors.primary,
    backgroundColor: colors.surface,
    borderRadius: radius.sm, padding: 10,
    marginBottom: 8,
  },
  editPlaceholder: { color: colors.text, fontSize: 14 },
  editActionsRow: {
    flexDirection: 'row', gap: 8, justifyContent: 'flex-end',
    marginBottom: 6,
  },
  editCancelBtn: {
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: radius.sm,
  },
  editCancelText: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  editSendBtn: {
    paddingHorizontal: 14, paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.text,
  },
  editSendText: { fontSize: 12, color: colors.textInverse, fontWeight: '600' },

  // Assistant
  assistantBlock: { position: 'relative', paddingVertical: 10 },
  assistantContinuation: { paddingTop: 2 },
  assistantHead: {
    flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 6,
  },
  headerSpacer: { flex: 1 },
  assistantLabel: {
    fontSize: 10, fontWeight: '600', color: colors.primary,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  modelText: {
    fontSize: 10, color: colors.textMuted, marginLeft: 4,
    fontFamily: font.mono,
  },
  assistantBody: {},

  // Status row ("Thinking…")
  statusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10,
  },
  statusDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: colors.primary,
  },
  statusText: {
    color: colors.textMuted, fontSize: 13, fontStyle: 'italic',
    fontFamily: font.mono,
  },

  // Tool rows + cards
  toolRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 6, paddingHorizontal: 10,
    marginVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  toolIndicator: {
    width: 3, height: 14, borderRadius: 1,
    backgroundColor: colors.primary, opacity: 0.5,
  },
  toolRowText: {
    fontSize: 12, color: colors.textSecondary, flex: 1,
    fontFamily: font.mono,
  },
  toolCard: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderLight,
    marginVertical: 4, overflow: 'hidden',
  },
  toolCardError: { borderColor: colors.errorBorder },
  // Memory-vault chips get a faint accent left border so "the agent is using
  // its memory" reads at a glance, distinct from generic tool chips.
  toolCardMemory: {
    borderLeftWidth: 2, borderLeftColor: colors.accent,
  },
  // Compaction card — same accent left border as memory chips so a
  // system-level "the agent folded context" event reads distinctly from
  // a plain tool chip.
  compactionCard: {
    borderLeftWidth: 2, borderLeftColor: colors.accent,
  },
  toolCardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  toolStatusDot: { width: 6, height: 6, borderRadius: 3 },
  toolCardTitleWrap: { flex: 1, minWidth: 0 },
  toolHostBadge: {
    maxWidth: 180, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
    borderWidth: 1, borderColor: colors.border,
  },
  toolHostText: { maxWidth: 150, fontSize: 9, color: colors.textMuted, fontFamily: font.mono },
  toolCardName: {
    fontSize: 12, fontWeight: '600', color: colors.text,
  },
  toolCardDetail: {
    fontSize: 12, fontWeight: '400', color: colors.textMuted,
    fontFamily: font.mono,
  },
  // "Open in Memory" link — navigates to the note's markdown screen / graph.
  toolOpenLink: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 2, paddingHorizontal: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  toolOpenLinkText: {
    fontSize: 10, fontWeight: '600', color: colors.accent,
    letterSpacing: 0.3,
  },
  toolStatusText: {
    fontSize: 10, fontWeight: '500', letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  toolCardBody: {
    paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2,
    borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
  toolSectionTitle: {
    fontSize: 10, fontWeight: '600', color: colors.textMuted,
    marginTop: 8, marginBottom: 4,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  toolCodeBlock: {
    backgroundColor: colors.codeBg, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.codeBorder,
    padding: 8,
  },
  toolCodeText: {
    fontSize: 11, color: colors.codeText,
    fontFamily: font.mono, lineHeight: 16,
  },
});
