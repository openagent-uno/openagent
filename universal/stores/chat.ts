/**
 * Chat state: multiple sessions, messages, processing status.
 */

import { create } from 'zustand';
import { resetSessionReadAccess, sessionIsRevoked, sessionReadGuard } from './sessionReadAccess';
import { mergeSharedTranscript } from '../../common/shared-transcript';
import {
  toolPhase,
  toolDisplay,
  isSubAgentSessionId,
  isHiddenChildSession,
  subAgentParentId,
  runLaunchTarget,
  runTargetForChildSession,
  type Attachment,
  type ChatMessage,
  type ChatSession,
  type CompactionInfo,
  type ServerMessage,
  type SessionContext,
  type ToolInfo,
} from '../../common/types';
import type { SessionEntry } from '../services/api';
import type { SessionMessage, SessionMessagePage, ToolInvocationDetail } from '../../common/unified-history';
import { normalizeAttachmentRefs, normalizeMessageContent } from '../../common/ui-views';
import { attachmentKey } from '../../common/attachments';
import { isAutomaticSessionTitle, sessionTitleFromPrompt } from '../../common/session-title';
import {
  toolInfoFromInvocationDetail,
  toolInfoFromSummary,
} from '../../common/tool-presentation';
import {
  deleteSession as deleteSessionApi,
  fetchSessionRuns,
  getSessionContext,
  listSessionMessages,
  runMsgToChat,
  updateSessionMetadata,
} from '../services/api';

export type SessionHistoryMode = 'unknown' | 'legacy' | 'v2';
const SESSION_MESSAGE_PAGE_SIZE = 60;
const earlierPageLoads = new Map<string, Promise<void>>();

let nextMsgId = 1;
const genId = () => `msg-${nextMsgId++}-${Date.now()}`;

function canonicalMessageToChat(message: SessionMessage): ChatMessage {
  // Feed the server payload straight through the canonical normalizer so
  // additive CAS metadata is never lost while projecting history into chat.
  const attachments = normalizedAttachments(message.attachments);
  const parsedTimestamp = Date.parse(message.created_at);
  return {
    id: message.id,
    providerRunId: message.run_id || undefined,
    role: message.role,
    text: message.text,
    // Never manufacture a current time for an old/malformed row. The shared
    // transcript renderer intentionally hides metadata when no real timestamp
    // exists.
    timestamp: Number.isFinite(parsedTimestamp) && parsedTimestamp > 0 ? parsedTimestamp : 0,
    ordinal: message.ordinal,
    durableStatus: message.status,
    completeness: message.completeness,
    toolInvocationId: message.tool_invocation_id || undefined,
    toolInfo: message.role === 'tool'
      ? toolInfoFromSummary(message.tool_summary, message.tool_invocation_id || undefined)
      : undefined,
    streaming: message.status === 'streaming',
    author: {
      kind: message.author.kind === 'user' ? 'human' : 'agent',
      handle: message.author.handle || undefined,
      display: message.author.display || undefined,
    },
    attachments,
    parts: normalizeMessageContent(message.parts, message.artifacts, message.text, attachments ?? []),
  };
}

function normalizedAttachments(raw: unknown): Attachment[] | undefined {
  const attachments = normalizeAttachmentRefs(raw);
  return attachments.length ? attachments : undefined;
}

type LoadedTranscript =
  | { kind: 'v2'; page: SessionMessagePage }
  | { kind: 'legacy'; messages: ChatMessage[] };

async function loadSessionTranscript(
  sessionId: string,
  mode: SessionHistoryMode,
): Promise<LoadedTranscript> {
  if (mode === 'v2') {
    return {
      kind: 'v2',
      page: await listSessionMessages(sessionId, { limit: SESSION_MESSAGE_PAGE_SIZE }),
    };
  }
  const raw = await fetchSessionRuns(sessionId);
  return { kind: 'legacy', messages: (raw || []).map(runMsgToChat) };
}

function transcriptPatch(
  loaded: LoadedTranscript,
  previous: readonly ChatMessage[],
  sharedSnapshot?: ChatSession['sharedSnapshot'],
): Pick<ChatSession, 'messages' | 'messageWindow'> {
  if (loaded.kind === 'legacy') {
    return {
      messages: sharedSnapshot ? mergeSharedTranscript(loaded.messages, sharedSnapshot)
        : preserveToolMetadataAcrossReplay([...previous], loaded.messages),
      messageWindow: undefined,
    };
  }
  const priorById = new Map(previous.map((message) => [message.id, message]));
  const projected = loaded.page.messages.map((wire) => {
    const message = canonicalMessageToChat(wire);
    const prior = priorById.get(message.id);
    return prior?.toolInfo && !message.toolInfo
      ? { ...message, toolInfo: prior.toolInfo }
      : message;
  });
  // Live optimistic rows use local ids while canonical transcript rows use
  // durable database ids.  Merge the same call by tool_call_id as well, or a
  // post-turn reconcile can erase the trusted execution host even though the
  // user just observed it on the live frame.
  const messages = preserveToolMetadataAcrossReplay([...previous], projected);
  return {
    messages: sharedSnapshot ? mergeSharedTranscript(messages, sharedSnapshot) : messages,
    messageWindow: {
      revision: loaded.page.revision,
      beforeCursor: loaded.page.before_cursor,
      afterCursor: loaded.page.after_cursor,
      hasMoreBefore: loaded.page.has_more_before,
      hasMoreAfter: loaded.page.has_more_after,
    },
  };
}

// When each session last heard anything at all from the server. Used by
// ``settleStaleTurns`` to tell a turn that is still running apart from one
// that died with the agent — see that action for why the timestamp, and not
// the session listing, is the signal that can answer the question.
const lastFrameAt = new Map<string, number>();
function noteFrame(sessionId: string | undefined): void {
  if (sessionId) lastFrameAt.set(sessionId, Date.now());
}

// Infer a child session's label/origin from its id shape, so a stub created
// before any origin-bearing metadata loads (a deep-link, or a live stream
// frame for an unknown session) is tagged correctly — and stays HIDDEN from
// the sidebar (isHiddenChildSession keys off origin). Used by both the
// setActiveSession deep-link path and the handleServerMessage live-stub path
// so they never drift (a scheduler/workflow firing now streams live frames, so
// its stub must be tagged just like a sub-agent's).
function childStubFor(id: string): Partial<ChatSession> {
  if (isSubAgentSessionId(id)) {
    return { title: 'Sub-agent', origin: 'delegation', parentSessionId: subAgentParentId(id) };
  }
  if (id.startsWith('scheduler:')) return { title: 'Scheduled run', origin: 'scheduler' };
  if (id.startsWith('workflow:')) return { title: 'Workflow run', origin: 'workflow' };
  if (id.startsWith('event:')) return { title: 'Event delivery', origin: 'event' };
  return { title: 'New Chat' };
}

// A detached child run (scheduled firing / workflow node) now broadcasts its
// live frames to EVERY client, each of which lazy-creates a hidden stub for it.
// Those stubs are navigable only from a run screen (which falls back to a DB
// fetch if the stub is gone), so an unbounded pile-up would just leak memory.
// Keep the most-recent N hidden stubs (plus whatever's active); drop the oldest.
const MAX_HIDDEN_STUBS = 40;
function capHiddenStubs(sessions: ChatSession[], activeId: string | null): ChatSession[] {
  const hidden = sessions.filter((s) => isHiddenChildSession(s) && s.id !== activeId);
  if (hidden.length <= MAX_HIDDEN_STUBS) return sessions;
  const drop = new Set(hidden.slice(0, hidden.length - MAX_HIDDEN_STUBS).map((s) => s.id));
  return sessions.filter((s) => !drop.has(s.id));
}

// Flip a RUN-LAUNCH card clickable while its run is still in flight. A
// scheduled/workflow run-now executes in the scheduler loop — a different
// process context than the chat turn that called it — so the server can't
// re-stream the child id onto the in-flight chip the way a (same-context)
// delegation does. But that run DOES broadcast its live frames to every
// client, so the moment we first see a ``scheduler:…``/``workflow:…`` child
// session, we link it back to the matching running run-now chip (by parent
// task/workflow id), giving the card a deep-link target mid-run. No-op for a
// ``::sub::`` delegation (handled server-side) or an autonomous cron fire (no
// in-chat chip to match).
function linkRunNowChip(sessions: ChatSession[], childSid: string): ChatSession[] {
  const target = runTargetForChildSession(childSid);
  if (!target) return sessions;  // not a run-now child (e.g. a sub-agent)
  // Collect every still-in-flight, as-yet-unlinked run-now chip of this kind (a
  // chip that already resolved a runId — from its result or a prior link — has
  // ``t.runId`` set, so it's skipped). We can't just require
  // ``t.parentId === target.parentId``: mid-run a chip's parentId is the tool's
  // ``id_or_name`` argument, and for a WORKFLOW that's usually the NAME, while
  // the child session id embeds the workflow ID — so an equality test never
  // fires for a name-invoked run-now and its card stays unclickable until the
  // run ends. So prefer an exact parentId match (run-now by id — every
  // scheduled task), and otherwise fall back to the UNIQUE in-flight chip of
  // this kind (the name-invoked case). More than one candidate with no exact
  // match is ambiguous — leave it unlinked rather than bind the wrong card.
  const candidates: { si: number; mi: number; exact: boolean }[] = [];
  sessions.forEach((ses, si) => {
    ses.messages.forEach((m, mi) => {
      if (m.role !== 'tool' || !m.toolInfo) return;
      const t = runLaunchTarget(m.toolInfo);
      if (!t || t.kind !== target.kind || t.runId) return;
      candidates.push({ si, mi, exact: t.parentId === target.parentId });
    });
  });
  const exact = candidates.filter((c) => c.exact);
  const pick = exact.length > 0
    ? exact[exact.length - 1]              // most-recent exact id match
    : candidates.length === 1
      ? candidates[0]                      // unique in-flight chip (name-invoked)
      : null;                              // ambiguous (or none) — don't mislink
  if (!pick) return sessions;
  return sessions.map((ses, si) => {
    if (si !== pick.si) return ses;
    const next = [...ses.messages];
    const m = next[pick.mi];
    next[pick.mi] = { ...m, toolInfo: { ...m.toolInfo!, child_session_id: childSid } };
    return { ...ses, messages: next };
  });
}

// Map the child-session linkage the server stamps in metadata onto a
// ChatSession (sidebar origin chip + parent breadcrumb).
function sessionMetaFromEntry(e: SessionEntry): Partial<ChatSession> {
  const origin = (e.origin || 'chat') as ChatSession['origin'];
  return {
    parentSessionId: e.parent_session_id || undefined,
    origin,
    originLabel: e.kind || undefined,
    createdAt: e.created_at ?? undefined,
    model: e.model ?? undefined,
    framework: e.framework ?? undefined,
  };
}

// Token-streaming throttle: coalesce all deltas that land within one
// animation frame into a single store mutation. Without this, a model
// streaming at 200 tok/s triggers ~200 set() calls per second — each
// schedules a re-render of every subscriber. With it we cap mutations
// at ~60/s which is plenty for visual feedback and stays well below
// MessageList memo's effective re-render budget.
const pendingDeltas = new Map<string, string>();
let flushScheduled = false;
function scheduleDeltaFlush(
  apply: (next: Map<string, string>) => void,
) {
  if (flushScheduled) return;
  flushScheduled = true;
  const runFlush = () => {
    flushScheduled = false;
    if (pendingDeltas.size === 0) return;
    const snapshot = new Map(pendingDeltas);
    pendingDeltas.clear();
    apply(snapshot);
  };
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(runFlush);
  } else {
    setTimeout(runFlush, 16);
  }
}

function sameLiveStart(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  if (!a || !b) return false;
  return a.role === b.role
    && a.text === b.text
    && (a.author?.kind ?? '') === (b.author?.kind ?? '')
    && (a.author?.handle ?? '') === (b.author?.handle ?? '');
}

function liveStartFromFrames(frames: ServerMessage[]): {
  text: string;
  author?: ChatMessage['author'];
} | null {
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    if (frame.type !== 'text_final' && frame.type !== 'seed') continue;
    const text = typeof frame.text === 'string' ? frame.text.trim() : '';
    if (!text) continue;
    return {
      text,
      author: frame.type === 'seed' ? frame.author : undefined,
    };
  }
  return null;
}

function liveSnapshotAlreadyCompletedLocally(
  session: ChatSession,
  frames: ServerMessage[],
): boolean {
  const start = liveStartFromFrames(frames);
  if (!start) return false;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (
      msg.role !== 'user'
      || msg.text.trim() !== start.text
      || (msg.author?.kind ?? '') !== (start.author?.kind ?? '')
      || (msg.author?.handle ?? '') !== (start.author?.handle ?? '')
    ) {
      continue;
    }
    const suffix = session.messages.slice(i + 1);
    return suffix.some((m) =>
      m.role === 'assistant' && !m.streaming && m.text.trim().length > 0,
    );
  }
  return false;
}

function liveSnapshotHasReplayContent(frames: ServerMessage[]): boolean {
  return frames.some((frame) => {
    if (!frame || typeof frame !== 'object') return false;
    if (frame.type === 'context_report' || frame.type === 'reasoning') return false;
    return !!frame.type;
  });
}

function clearLiveFlags(session: ChatSession, contextReport?: SessionContext): ChatSession {
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
    ),
    isProcessing: false,
    isReasoning: false,
    statusText: undefined,
    contextUsage: contextReport || session.contextUsage,
  };
}

type ToolPhase = ReturnType<typeof toolPhase>;

const TOOL_PHASE_PRECEDENCE: Record<ToolPhase, number> = {
  running: 0,
  completed: 1,
  stopped: 2,
  error: 3,
};

/**
 * Merge a later wire frame without letting an out-of-order, weaker lifecycle
 * state reopen a terminal tool call. Metadata is still additive (for example
 * a late started frame may carry args or execution_host), while error/stopped
 * states remain sticky and may correct an earlier optimistic completion.
 */
function mergeToolLifecycle(existing: ToolInfo, incoming: ToolInfo): ToolInfo {
  const existingPhase = toolPhase(existing);
  const incomingPhase = toolPhase(incoming);
  const merged: ToolInfo = { ...existing, ...incoming };

  if (TOOL_PHASE_PRECEDENCE[incomingPhase] >= TOOL_PHASE_PRECEDENCE[existingPhase]) {
    return merged;
  }

  // These three fields determine toolPhase and the terminal card copy. When
  // the stronger frame omitted one of them, remove the weaker frame's value
  // instead of accidentally manufacturing a contradictory hybrid state.
  for (const key of ['status', 'tool_call_error', 'result'] as const) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      merged[key] = existing[key];
    } else {
      delete merged[key];
    }
  }
  return merged;
}

export function appendOrPatchTool(messages: ChatMessage[], toolInfo: ToolInfo): ChatMessage[] {
  const phase = toolPhase(toolInfo);
  const msgs = [...messages];
  const callId = toolInfo.tool_call_id;
  const childSid = toolInfo.child_session_id;
  // Provider tool-call ids identify an invocation inside a model turn; they
  // are not guaranteed to be unique for the lifetime of a long session.  A
  // new turn may therefore legitimately reuse an old id. Restrict live-frame
  // reconciliation to the open/current turn (everything after its latest
  // user/seed message) so idempotency can never rewrite durable history.
  let currentTurnStart = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'user') continue;
    currentTurnStart = i + 1;
    break;
  }
  const matches = (existing: ToolInfo): boolean => {
    if (callId && existing.tool_call_id) return existing.tool_call_id === callId;
    if (childSid && existing.child_session_id) return existing.child_session_id === childSid;
    return existing.tool_name === toolInfo.tool_name;
  };

  // tool_call_id is the stable identity of one invocation. Patch it for every
  // phase, not just running -> terminal: a gateway retry, reconnect, or an
  // older server that emits both completed and error must still render one
  // card. If an earlier client update already left duplicates in memory,
  // collapse them at the first subsequent frame while keeping the original
  // row/id (and therefore the invocation's place in transcript order).
  if (callId) {
    const indexes: number[] = [];
    for (let i = currentTurnStart; i < msgs.length; i += 1) {
      if (msgs[i].toolInfo?.tool_call_id === callId) indexes.push(i);
    }
    if (indexes.length > 0) {
      const keep = indexes[0];
      let merged = msgs[keep].toolInfo!;
      for (let i = 1; i < indexes.length; i += 1) {
        merged = mergeToolLifecycle(merged, msgs[indexes[i]].toolInfo!);
      }
      merged = mergeToolLifecycle(merged, toolInfo);
      const duplicates = new Set(indexes.slice(1));
      return msgs
        .filter((_, index) => !duplicates.has(index))
        .map((message, index) => (
          index === keep ? { ...message, toolInfo: merged } : message
        ));
    }
  }

  // child_session_id is also a stable identity when a legacy frame omitted a
  // call id. Treat it idempotently, but do not deduplicate by tool name alone:
  // same-name invocations may legitimately execute concurrently.
  if (!callId && childSid) {
    for (let i = msgs.length - 1; i >= currentTurnStart; i--) {
      const existing = msgs[i].toolInfo;
      if (existing?.child_session_id !== childSid) continue;
      msgs[i] = { ...msgs[i], toolInfo: mergeToolLifecycle(existing, toolInfo) };
      return msgs;
    }
  }

  for (let i = msgs.length - 1; i >= currentTurnStart; i--) {
    const existing = msgs[i].toolInfo;
    if (!existing) continue;
    if (phase !== 'running' && matches(existing) && toolPhase(existing) === 'running') {
      // Completion/error frames may be intentionally sparse. Preserve the
      // identity and execution boundary learned from the started frame while
      // letting every field the terminal frame does carry win.
      msgs[i] = { ...msgs[i], toolInfo: mergeToolLifecycle(existing, toolInfo) };
      return msgs;
    }
  }

  const d = toolDisplay(toolInfo);
  msgs.push({
    id: genId(),
    role: 'tool',
    text: phase === 'running'
      ? (d.detail ? `${d.title} ${d.detail}` : d.title)
      : phase === 'error'
        ? `✗ ${toolInfo.tool_name} failed`
        : phase === 'stopped'
          ? `${toolInfo.tool_name} stopped`
        : `✓ ${toolInfo.tool_name} done`,
    timestamp: Date.now(),
    toolInfo,
  });
  return msgs;
}

/**
 * A reconnect snapshot is authoritative for ordering and current values, but
 * older servers and in-flight channel buffers can carry a deliberately sparse
 * terminal tool frame.  Retain trusted metadata already observed on the live
 * frame (most importantly execution_host) while letting every replayed field
 * win.  Match exact call identities first; only use the tool name when the
 * replay itself has no stronger identifier.
 */
export function preserveToolMetadataAcrossReplay(
  previous: ChatMessage[],
  replay: ChatMessage[],
  options: { preserveMessageIds?: boolean } = {},
): ChatMessage[] {
  const claimed = new Set<number>();

  return replay.map((message) => {
    const incoming = message.toolInfo;
    if (!incoming) return message;

    let match = -1;
    for (let i = 0; i < previous.length; i += 1) {
      if (claimed.has(i)) continue;
      const prior = previous[i].toolInfo;
      if (!prior) continue;
      if (incoming.tool_call_id) {
        if (prior.tool_call_id === incoming.tool_call_id) {
          match = i;
          break;
        }
        continue;
      }
      if (incoming.child_session_id) {
        if (prior.child_session_id === incoming.child_session_id) {
          match = i;
          break;
        }
        continue;
      }
      if (prior.tool_name === incoming.tool_name) {
        match = i;
        break;
      }
    }

    if (match < 0) return message;
    claimed.add(match);
    return {
      ...message,
      ...(options.preserveMessageIds ? { id: previous[match].id } : {}),
      toolInfo: { ...previous[match].toolInfo!, ...incoming },
    };
  });
}

function liveMessagesFromFrames(
  frames: ServerMessage[],
  active: boolean,
): {
  messages: ChatMessage[];
  isProcessing: boolean;
  isReasoning?: boolean;
  statusText?: string;
} {
  let messages: ChatMessage[] = [];
  let isProcessing = active;
  let isReasoning = false;
  let statusText: string | undefined;

  const pushUser = (text: string, attachments?: Attachment[], author?: ChatMessage['author']) => {
    if (!text && !attachments?.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'user'
        && last.text === text
        && attachmentSignature(last.attachments) === attachmentSignature(attachments)
        && (last.author?.kind ?? '') === (author?.kind ?? '')) {
      return;
    }
    messages.push({
      id: genId(),
      role: 'user',
      text,
      timestamp: Date.now(),
      attachments: attachments && attachments.length ? attachments : undefined,
      author,
    });
  };

  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    if (frame.type === 'text_final') {
      pushUser(frame.text || '', normalizedAttachments(frame.attachments), undefined);
      isProcessing = true;
      continue;
    }
    if (frame.type === 'seed') {
      pushUser(frame.text || '', undefined, frame.author);
      isProcessing = true;
      continue;
    }
    if (frame.type === 'reasoning') {
      isReasoning = !!frame.active;
      continue;
    }
    if (frame.type === 'session_compacted') {
      const info: CompactionInfo = {
        phase: frame.phase || 'done',
        foldedRuns: frame.folded_runs,
        keptRuns: frame.kept_runs_count,
        summaryChars: frame.summary_chars,
        tokensBefore: frame.tokens_before,
        tokensAfter: frame.tokens_after,
      };
      messages.push({
        id: genId(),
        role: 'compaction',
        text: '',
        timestamp: Date.now(),
        compactionInfo: info,
      });
      continue;
    }
    if (frame.type === 'status') {
      const text = frame.text || '';
      let toolInfo: ToolInfo | undefined;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.tool_name) toolInfo = parsed as ToolInfo;
      } catch { /* plain text */ }
      if (toolInfo) {
        messages = appendOrPatchTool(messages, toolInfo);
      } else if (text.startsWith('Using ')) {
        messages.push({ id: genId(), role: 'tool', text, timestamp: Date.now() });
      } else if (text) {
        statusText = text;
      }
      isReasoning = false;
      continue;
    }
    if (frame.type === 'delta') {
      const delta = frame.text || '';
      if (!delta) continue;
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + delta };
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: delta,
          timestamp: Date.now(),
          streaming: true,
        });
      }
      statusText = undefined;
      isReasoning = false;
      continue;
    }
    if (frame.type === 'response') {
      const attachments = normalizedAttachments(frame.attachments);
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = {
          ...last,
          text: frame.text,
          attachments,
          parts: normalizeMessageContent(frame.parts, frame.artifacts, frame.text, attachments ?? []),
          model: frame.model,
          streaming: false,
        };
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: frame.text,
          timestamp: Date.now(),
          attachments,
          parts: normalizeMessageContent(frame.parts, frame.artifacts, frame.text, attachments ?? []),
          model: frame.model,
        });
      }
      isProcessing = false;
      isReasoning = false;
      statusText = undefined;
      continue;
    }
    if (frame.type === 'error') {
      messages.push({
        id: genId(),
        role: 'assistant',
        text: `Error: ${frame.text}`,
        timestamp: Date.now(),
      });
      isProcessing = false;
      isReasoning = false;
      statusText = undefined;
      continue;
    }
    if (frame.type === 'turn_complete') {
      messages = messages.map((m) =>
        m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
      );
      isProcessing = false;
      isReasoning = false;
      statusText = undefined;
    }
  }

  return { messages, isProcessing, isReasoning, statusText };
}

function attachmentSignature(attachments?: Attachment[]): string {
  return (attachments ?? []).map((item) => `${item.type}:${attachmentKey(item)}:${item.filename}`).join('|');
}

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  /** True once either the first v2 summary page or the legacy flat session
   * list has resolved. */
  sessionsHydrated: boolean;
  /** Chooses canonical paged messages for v2 agents and preserves the old
   * runs endpoint only as a compatibility path for legacy agents. */
  sessionHistoryMode: SessionHistoryMode;

  createSession: () => string;
  setActiveSession: (id: string) => void;
  removeSession: (id: string) => void;
  /** Rename a session optimistically, rolling back if durable persistence fails. */
  renameSession: (id: string, title: string) => Promise<void>;
  /** Apply a server-confirmed title without writing it back. */
  applySessionTitle: (id: string, title: string) => void;
  /** Populate local sessions from the server's persisted list. */
  hydrateFromServer: (entries: SessionEntry[]) => void;
  /** Mark hydration as done even when the server returned no sessions. */
  markHydrated: () => void;
  setSessionHistoryMode: (mode: SessionHistoryMode) => void;
  /** Merge a stable-ID v2 transcript window without replacing live tail rows. */
  mergeMessageWindow: (page: SessionMessagePage, tool?: ToolInvocationDetail) => void;
  /** Fetch the previous canonical message page for the focused v2 session. */
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  addUserMessage: (sessionId: string, text: string, attachments?: Attachment[]) => void;
  /** Replace a previous user message in place (Edit & retry).
   *  Truncates everything after the edited message so the new turn
   *  starts from a clean tail. Returns true when the id was found. */
  editUserMessage: (sessionId: string, messageId: string, newText: string) => boolean;
  /** Persist composer text per-session so switching sessions doesn't
   *  lose work. */
  setDraftInput: (sessionId: string, text: string) => void;
  /** Toggle the sticky-pin flag (sidebar surfaces pinned sessions first). */
  togglePinned: (sessionId: string) => void;
  /** Per-session LLM override. Stored on the session row and applied
   *  on the next ``session_open`` — chat.tsx is responsible for
   *  forcing a reopen (close + clear opened-cache) when this changes. */
  setLlmPin: (sessionId: string, model: string | undefined) => void;
  /** Per-session system prompt. Same gating as setLlmPin — the next
   *  outgoing turn is rebased on the new prompt. */
  setSystemPrompt: (sessionId: string, prompt: string) => void;
  handleServerMessage: (msg: ServerMessage) => void;
  /** Apply a server-owned snapshot of a turn that is still running after the
   *  client detached/reconnected. Replaces the live tail instead of replaying
   *  frames into the existing transcript, so reconnects stay idempotent. */
  applyLiveState: (sessionId: string, frames: ServerMessage[], active?: boolean) => void;
  /** Re-derive a session's transcript from the server (the database) after a
   *  turn completes, so the LIVE view becomes byte-identical to what a
   *  reopen/rehydration shows — same data, same source. The optimistic live
   *  rendering (deltas, tool chips) is only a transient preview; this snaps it
   *  to the authoritative `_expand_run_messages` output (real authorship,
   *  delegation cards with child_session_id, no missing/duplicated messages).
   *  No-op while the session is still processing (so it never clobbers a turn
   *  the user just started) or when the server returns nothing. */
  reconcileSession: (sessionId: string) => Promise<void>;
  /** Set a session's live context-window composition (from the
   *  ``context_report`` push frame or the ``/context`` command_result). */
  applyContextReport: (sessionId: string, report: SessionContext) => void;
  /** Pull ``GET /api/sessions/{id}/context`` and store it — used on session
   *  activation and after a turn completes (covers child/run sessions that
   *  don't get the push frame). */
  refreshContext: (sessionId: string) => void;
  /** Called on ``turn_complete`` to synchronously clear any stuck
   *  ``streaming: true`` / ``isProcessing: true`` state left behind when a
   *  gateway omits the ``response`` frame or when the RAF delta flush races
   *  past it. This unblocks ``reconcileSession`` and ensures the markdown
   *  renderer switches from plain-text fallback to full parsing. Safe to call
   *  redundantly — it is a no-op when nothing is stuck. */
  finaliseStreaming: (sessionId: string) => void;
  /** Settle any turn this client still believes is running but that the
   *  server, on reattaching at ``attachedAt``, said nothing about. Call it a
   *  few seconds after ``auth_ok``: the gateway replays a ``live_state``
   *  snapshot for every turn it still owns immediately after auth, so silence
   *  past that point means the turn is gone — the agent restarted
   *  (auto-update, deploy, crash) and no terminal frame is ever coming. */
  settleStaleTurns: (attachedAt: number) => void;
  /** Record how a turn ended when it did not simply succeed. The server now
   *  says so on ``turn_complete`` (reason + error); this puts it where the
   *  user is looking, instead of letting a failed turn end as quietly as a
   *  successful one. Only for a turn that produced no visible answer — when
   *  the assistant did reply, the reply IS the outcome and a banner under it
   *  would be noise. */
  noteTurnOutcome: (sessionId: string, reason: string, error?: string) => void;
  /** Remove a session row locally WITHOUT calling the delete API — used when
   *  the server broadcasts that a session was deleted elsewhere (another
   *  device, a prune), so it disappears from this sidebar in realtime. */
  dropSessionLocal: (sessionId: string) => void;
  clearAll: () => void;
  loadSession: (id: string, title: string, history: { role: string; content: string; tool_result?: string; tool_error?: string; tool_name?: string; tool_args?: Record<string, any> }[]) => string;
}

function sessionId(): string {
  return `session-${Date.now()}`;
}

export const useChat = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sessionsHydrated: false,
  sessionHistoryMode: 'unknown',

  createSession: () => {
    const id = sessionId();
    const session: ChatSession = {
      id,
      title: 'New Chat',
      messages: [],
      isProcessing: false,
      // An empty local session is not in durable history yet. Give it real
      // recency immediately so the v2 Sidebar overlay keeps it visible at the
      // top instead of sorting its timestamp-less row below the loaded page.
      lastActiveAt: Math.floor(Date.now() / 1000),
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: id,
    }));
    return id;
  },

  setActiveSession: (id) => {
    const state = get();
    const known = state.sessions.some((s) => s.id === id);
    // A sub-agent session is hidden from the flat list, so navigating into it
    // from a parent's delegation card lands on an id not in the store. Create
    // a local entry — tagged so the sidebar keeps hiding it — so its transcript
    // can render; its runs are fetched below like any focused-but-unloaded row.
    // Infer the label/origin from the id shape so a child opened straight from
    // a deep link is correct before any (origin-bearing) metadata loads.
    const stub = childStubFor(id);
    const sessions = known
      ? state.sessions
      : [...state.sessions, { id, messages: [], isProcessing: false, ...stub } as ChatSession];
    set({
      activeSessionId: id,
      // Bringing a session to focus clears its unread indicator.
      sessions: sessions.map((se) =>
        se.id === id && se.hasUnread ? { ...se, hasUnread: false } : se,
      ),
    });
    // Fetch run history from the server when switching to a hydrated
    // session that hasn't loaded its messages yet (e.g. from a previous run
    // that survived in the server's session store, or a just-created child
    // stub above). A lazy-created child has sessionsHydrated already true.
    if (state.sessionsHydrated) {
      const ses = sessions.find((s) => s.id === id);
      if (ses && ses.messages.length === 0) {
        const current = sessionReadGuard(id);
        loadSessionTranscript(id, state.sessionHistoryMode)
          .then((loaded) => {
            if (!current()) return;
            const hasMessages = loaded.kind === 'v2'
              ? loaded.page.messages.length > 0
              : loaded.messages.length > 0;
            if (!hasMessages) return;
            set((s) => ({
              sessions: s.sessions.map((se) =>
                se.id !== id || (se.messages.length > 0 && !se.sharedSnapshot)
                  ? se
                  : { ...se, ...transcriptPatch(loaded, se.messages, se.sharedSnapshot) },
              ),
            }));
          })
          .catch(() => {});
      }
    }
    // Load the context-window composition for the newly-focused session so
    // the panel paints immediately (before the next turn pushes a fresh one).
    // Covers chat, sub-agent, scheduled-firing and workflow-AI-node sessions.
    get().refreshContext(id);
  },

  removeSession: (id) => set((s) => {
    // Best-effort delete on the server (fire-and-forget).
    deleteSessionApi(id).catch(() => {});
    const sessions = s.sessions.filter((ses) => ses.id !== id);
    let activeSessionId = s.activeSessionId;
    if (s.activeSessionId === id) {
      activeSessionId = sessions[0]?.id ?? null;
    }
    return { sessions, activeSessionId };
  }),

  renameSession: async (id, rawTitle) => {
    const title = rawTitle.trim().slice(0, 200);
    if (!title) throw new Error('A conversation name is required.');
    const previousTitle = get().sessions.find((session) => session.id === id)?.title;
    set((s) => ({
      sessions: s.sessions.map((se) =>
        se.id !== id ? se : { ...se, title },
      ),
    }));
    try {
      await updateSessionMetadata(id, { title });
    } catch (error) {
      // Do not undo a newer rename that completed while this request was in
      // flight. Roll back only the optimistic value owned by this attempt.
      set((s) => ({
        sessions: s.sessions.map((se) =>
          se.id !== id || se.title !== title
            ? se
            : { ...se, title: previousTitle || 'New Chat' },
        ),
      }));
      throw error;
    }
  },

  applySessionTitle: (id, title) => set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === id ? { ...session, title } : session,
    ),
  })),

  hydrateFromServer: (entries) => {
    if (!entries || entries.length === 0) return;
    const existing = get().sessions;
    const existingIds = new Set(existing.map((s) => s.id));
    // Metadata (parent/origin link, title, recency) keyed by id, so an
    // event-driven re-hydrate can refresh links on sessions already in the
    // store — used to attach a child to its parent once the server announces
    // it — WITHOUT clobbering live messages / isProcessing / draftInput.
    const metaById = new Map<string, Partial<ChatSession>>();
    const imported: ChatSession[] = [];
    for (const e of entries) {
      const sid = e.session_id;
      if (!sid) continue;
      const meta = sessionMetaFromEntry(e);
      if (existingIds.has(sid)) {
        metaById.set(sid, {
          ...meta,
          // Carry the server title so a lazy-created sub-agent stub gets its
          // real name; applied only onto placeholder titles below so a
          // user-renamed chat is never clobbered.
          ...(e.title ? { title: e.title } : {}),
          lastActiveAt: e.last_active_at ?? e.created_at ?? undefined,
        });
        continue;
      }
      imported.push({
        id: sid,
        title: e.title || 'New Chat',
        messages: [],
        isProcessing: !!e._live,
        lastActiveAt: e.last_active_at ?? e.created_at ?? undefined,
        ...meta,
      });
    }
    if (imported.length === 0 && metaById.size === 0) return;
    const prevActive = get().activeSessionId;
    const autoSelectId = prevActive ?? imported[0]?.id ?? null;
    set((s) => ({
      sessions: [
        ...s.sessions.map((se) => {
          const meta = metaById.get(se.id);
          if (!meta) return se;
          // Merge metadata only; never touch messages/isProcessing/draftInput.
          // Backfill a real title only onto a placeholder stub, so a
          // user-renamed chat title is never overwritten by a re-hydrate.
          const { title: serverTitle, ...rest } = meta;
          const titlePatch = serverTitle && (se.title === 'Sub-agent' || se.title === 'New Chat')
            ? { title: serverTitle } : {};
          // Session-list metadata is not a turn-lifecycle authority. Its
          // `_live=false` can race a just-started turn (for example the title
          // PATCH that follows the first user message) before the server's
          // durable run projection catches up. Clearing the optimistic user
          // row/stream here made a chat roll back to its last completed turn
          // when the user navigated away and back. Terminal stream frames and
          // reconnect `live_state` are the only paths allowed to settle a
          // locally-open turn.
          return { ...se, ...rest, ...titlePatch };
        }),
        ...imported,
      ],
      sessionsHydrated: true,
      activeSessionId: autoSelectId,
    }));
    // Fetch only the newest canonical message page for the auto-selected
    // v2 session (legacy agents keep their old runs loader) — but ONLY when
    // it's a freshly
    // imported, message-less session. On a metadata-only re-hydrate (e.g.
    // triggered by a child-session ``resource_event``), refetching an active
    // session here would clobber its in-flight streaming transcript.
    const importedIds = new Set(imported.map((i) => i.id));
    if (autoSelectId && importedIds.has(autoSelectId)) {
      const mode = get().sessionHistoryMode;
      const current = sessionReadGuard(autoSelectId);
      loadSessionTranscript(autoSelectId, mode)
        .then((loaded) => {
          if (!current()) return;
          const hasMessages = loaded.kind === 'v2'
            ? loaded.page.messages.length > 0
            : loaded.messages.length > 0;
          if (!hasMessages) return;
          set((s) => ({
            sessions: s.sessions.map((se) =>
              se.id !== autoSelectId || se.messages.length > 0
                ? se
                : { ...se, ...transcriptPatch(loaded, se.messages, se.sharedSnapshot) },
            ),
          }));
        })
        .catch(() => {});
    }
    // Paint the context panel on first load: hydration sets the active session
    // directly (not via ``setActiveSession``), so without this the panel stayed
    // blank until the user switched chats. Only fire when the active session is
    // newly selected here — a metadata-only re-hydrate that keeps the same
    // active session leaves live context to the turn/context-report frames.
    if (autoSelectId && autoSelectId !== prevActive) {
      get().refreshContext(autoSelectId);
    }
  },

  markHydrated: () => set({ sessionsHydrated: true }),

  setSessionHistoryMode: (sessionHistoryMode) => set({ sessionHistoryMode }),

  mergeMessageWindow: (page, tool) => set((state) => {
    if (sessionIsRevoked(page.session_id)) return {};
    const incoming = page.messages.map(canonicalMessageToChat);
    if (tool) {
      const messageId = tool.message_id;
      for (let index = 0; index < incoming.length; index += 1) {
        const message = incoming[index];
        if (message.id !== messageId && message.toolInvocationId !== tool.id) continue;
        incoming[index] = {
          ...message,
          role: 'tool',
          toolInvocationId: tool.id,
          toolInfo: toolInfoFromInvocationDetail(tool),
        };
      }
    }
    const known = state.sessions.some((session) => session.id === page.session_id);
    const sessions = known
      ? state.sessions
      : [...state.sessions, {
          id: page.session_id,
          messages: [],
          isProcessing: false,
          ...childStubFor(page.session_id),
        } as ChatSession];
    return {
      sessions: sessions.map((session) => {
        if (session.id !== page.session_id) return session;
        const byId = new Map(session.messages.map((message) => [message.id, message]));
        for (const message of incoming) {
          const prior = byId.get(message.id);
          byId.set(message.id, {
            ...prior,
            ...message,
            toolInfo: message.toolInfo || prior?.toolInfo,
          });
        }
        const messages = [...byId.values()].sort((a, b) => {
          if (a.ordinal != null && b.ordinal != null) return a.ordinal - b.ordinal;
          if (a.ordinal != null) return -1;
          if (b.ordinal != null) return 1;
          return a.timestamp - b.timestamp;
        });
        return {
          ...session,
          messages,
          messageWindow: {
            revision: page.revision,
            beforeCursor: page.before_cursor,
            afterCursor: page.after_cursor,
            hasMoreBefore: page.has_more_before,
            hasMoreAfter: page.has_more_after,
          },
        };
      }),
    };
  }),

  loadEarlierMessages: async (sessionId) => {
    const current = get().sessions.find((session) => session.id === sessionId);
    const cursor = current?.messageWindow?.beforeCursor;
    if (get().sessionHistoryMode !== 'v2'
        || !current?.messageWindow?.hasMoreBefore || !cursor) return;
    const running = earlierPageLoads.get(sessionId);
    if (running) return running;
    const authorized = sessionReadGuard(sessionId);
    const request = listSessionMessages(sessionId, {
      cursor,
      direction: 'before',
      limit: SESSION_MESSAGE_PAGE_SIZE,
    })
      .then((page) => {
        if (!authorized()) return;
        // Ignore a page for a cursor superseded by an anchor navigation or a
        // reconnect refresh while this request was in flight.
        const latest = get().sessions.find((session) => session.id === sessionId);
        if (latest?.messageWindow?.beforeCursor !== cursor) return;
        get().mergeMessageWindow(page);
      })
      .catch(() => {})
      .finally(() => {
        if (earlierPageLoads.get(sessionId) === request) earlierPageLoads.delete(sessionId);
      });
    earlierPageLoads.set(sessionId, request);
    return request;
  },

  addUserMessage: (sessionId, text, attachments) => {
    const state = get();
    const ses = state.sessions.find((s) => s.id === sessionId);
    const suggestedTitle = sessionTitleFromPrompt(text)
      || (!text.trim() ? attachments?.[0]?.filename : undefined);
    const newTitle = suggestedTitle && (!ses || isAutomaticSessionTitle(ses.title, sessionId))
      ? suggestedTitle
      : undefined;

    set((s) => {
      const known = s.sessions.some((se) => se.id === sessionId);
      const sessions = known
        ? s.sessions
        : capHiddenStubs([
            ...s.sessions,
            {
              id: sessionId,
              messages: [],
              isProcessing: false,
              ...childStubFor(sessionId),
            } as ChatSession,
          ], s.activeSessionId);

      return {
        sessions: sessions.map((se) =>
          se.id !== sessionId ? se : {
            ...se,
            isProcessing: true,
            statusText: 'Thinking...',
            // Stamp recency (epoch seconds) so the sidebar floats this
            // conversation to the top of its unified feed immediately.
            lastActiveAt: Math.floor(Date.now() / 1000),
            messages: [...se.messages, {
              id: genId(),
              role: 'user' as const,
              text,
              timestamp: Date.now(),
              attachments: attachments && attachments.length ? attachments : undefined,
            }],
            title: newTitle ?? se.title,
          },
        ),
      };
    });

    // Persist the title to the server so it shows up on reconnect.
    if (newTitle) {
      updateSessionMetadata(sessionId, { title: newTitle }).catch(() => {});
    }
  },

  editUserMessage: (sessionId, messageId, newText) => {
    let found = false;
    set((s) => ({
      sessions: s.sessions.map((se) => {
        if (se.id !== sessionId) return se;
        const idx = se.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return se;
        found = true;
        const edited: ChatMessage = { ...se.messages[idx], text: newText };
        return {
          ...se,
          // Truncate after the edited message — the next assistant turn
          // gets a clean slate. Matches ChatGPT's edit-and-resend flow.
          messages: [...se.messages.slice(0, idx), edited],
          isProcessing: true,
          statusText: 'Thinking...',
        };
      }),
    }));
    return found;
  },

  setDraftInput: (sessionId, text) => {
    set((s) => ({
      sessions: s.sessions.map((se) =>
        se.id === sessionId ? { ...se, draftInput: text } : se,
      ),
    }));
  },

  togglePinned: (sessionId) => {
    set((s) => ({
      sessions: s.sessions.map((se) =>
        se.id === sessionId ? { ...se, pinned: !se.pinned } : se,
      ),
    }));
  },

  setLlmPin: (sessionId, model) => {
    set((s) => ({
      sessions: s.sessions.map((se) =>
        se.id === sessionId ? { ...se, llmPin: model } : se,
      ),
    }));
  },

  setSystemPrompt: (sessionId, prompt) => {
    set((s) => ({
      sessions: s.sessions.map((se) =>
        se.id === sessionId ? { ...se, systemPrompt: prompt } : se,
      ),
    }));
  },

  applyLiveState: (sessionId, frames, active = true) => {
    if (!sessionId || !Array.isArray(frames)) return;
    noteFrame(sessionId);
    pendingDeltas.delete(sessionId);
    const live = liveMessagesFromFrames(frames, active);
    const contextFrame = [...frames]
      .reverse()
      .find((frame): frame is Extract<ServerMessage, { type: 'context_report' }> =>
        frame?.type === 'context_report' && !!frame.report,
      );
    const contextReport = contextFrame?.report;
    let shouldReconcile = false;
    set((s) => {
      const known = s.sessions.some((ses) => ses.id === sessionId);
      if (!known && !active) return {};
      const baseSessions = known
        ? s.sessions
        : capHiddenStubs([
            ...s.sessions,
            {
              id: sessionId,
              messages: [],
              isProcessing: false,
              ...childStubFor(sessionId),
            } as ChatSession,
          ], s.activeSessionId);

      return {
        sessions: baseSessions.map((ses) => {
          if (ses.id !== sessionId) return ses;
          if (
            !active
            || !liveSnapshotHasReplayContent(frames)
            || liveSnapshotAlreadyCompletedLocally(ses, frames)
          ) {
            shouldReconcile = true;
            return clearLiveFlags(ses, contextReport);
          }
          let liveMessages = live.messages;
          let messages = ses.messages;
          if (liveMessages.length > 0) {
            let replaceFrom = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (sameLiveStart(messages[i], liveMessages[0])) {
                replaceFrom = i;
                break;
              }
            }
            const prefix = replaceFrom >= 0 ? messages.slice(0, replaceFrom) : messages;
            const previousLive = replaceFrom >= 0 ? messages.slice(replaceFrom) : messages;
            liveMessages = preserveToolMetadataAcrossReplay(
              previousLive,
              liveMessages,
              { preserveMessageIds: true },
            );
            messages = [...prefix, ...liveMessages];
          }
          return {
            ...ses,
            messages,
            isProcessing: live.isProcessing,
            isReasoning: live.isReasoning,
            statusText: live.statusText,
            contextUsage: contextReport || ses.contextUsage,
            lastActiveAt: Math.floor(Date.now() / 1000),
            hasUnread: s.activeSessionId === sessionId ? ses.hasUnread : true,
          };
        }),
      };
    });
    if (shouldReconcile) {
      get().reconcileSession(sessionId);
      get().refreshContext(sessionId);
    }
  },

  handleServerMessage: (msg) => set((s) => {
    const sessionId = (msg as { session_id?: string }).session_id;
    if (sessionId && sessionIsRevoked(sessionId)) return {};
    noteFrame((msg as { session_id?: string }).session_id);
    // A streaming frame may arrive for a freshly-spawned child session (a
    // delegated sub-agent streaming live) a beat before the sidebar's
    // session-event refetch lands. Lazy-create a placeholder row so the frame
    // isn't dropped — hydrateFromServer backfills its real title/origin. The
    // app already routes every frame by session_id, so a child session streams
    // exactly like any session once its row exists.
    let stubAdded = false;
    if (
      (
        msg.type === 'status' || msg.type === 'delta' || msg.type === 'response'
        || msg.type === 'seed' || msg.type === 'session_compacted' || msg.type === 'text_final'
        || (msg.type === 'reasoning' && msg.active)
      )
      && msg.session_id
      && !s.sessions.some((x) => x.id === msg.session_id)
    ) {
      // First sight of a freshly-spawned child session. For a scheduler/
      // workflow run (whose run-now executes in a detached context the server
      // can't link back to the chat chip), this broadcast IS the cross-context
      // signal — use it to flip the matching run-now card clickable mid-run.
      const withLink = linkRunNowChip(s.sessions, msg.session_id);
      s = {
        ...s,
        sessions: capHiddenStubs([
          ...withLink,
          {
            id: msg.session_id,
            messages: [],
            isProcessing: msg.type === 'reasoning' ? msg.active : false,
            // Tag from the id shape so a hidden child (sub-agent, scheduled
            // firing, workflow node) stays hidden from the sidebar — its origin
            // metadata never arrives via the (excluded) history list.
            ...childStubFor(msg.session_id),
          } as ChatSession,
        ], s.activeSessionId),
      };
      stubAdded = true;
    }

    if (msg.type === 'text_final') {
      const text = msg.text || '';
      const attachments = normalizedAttachments(msg.attachments);
      if (!text && !attachments?.length) return stubAdded ? { sessions: s.sessions } : {};
      return {
        sessions: s.sessions.map((ses) => {
          if (ses.id !== msg.session_id) return ses;
          const last = ses.messages[ses.messages.length - 1];
          if (last?.role === 'user'
              && last.text === text
              && attachmentSignature(last.attachments) === attachmentSignature(attachments)) return ses;
          return {
            ...ses,
            isProcessing: true,
            statusText: undefined,
            lastActiveAt: Math.floor(Date.now() / 1000),
            messages: [...ses.messages, {
              id: genId(),
              role: 'user' as const,
              text,
              timestamp: Date.now(),
              attachments,
            }],
          };
        }),
      };
    }

    if (msg.type === 'seed') {
      // The agent-self mission/role/task prompt that opens a spawned child
      // session, streamed before any delta so the Mission block shows at the
      // top WHILE the run executes (a scheduled firing / workflow node) — not
      // only once its canonical transcript persists at completion. Rendered as
      // a user-role, agent-authored message (MessageList's SelfPromptBlock).
      const text = msg.text || '';
      if (!text) return stubAdded ? { sessions: s.sessions } : {};
      return {
        sessions: s.sessions.map((ses) => {
          if (ses.id !== msg.session_id) return ses;
          // Idempotent: the mission opens the transcript exactly once. Skip if
          // it's already present (a re-broadcast, or reconcile beat us to the
          // canonical row) so we never double the Mission block.
          if (ses.messages.some((m) => m.role === 'user' && m.author?.kind === 'agent')) {
            return ses;
          }
          const seedMsg: ChatMessage = {
            id: genId(),
            role: 'user',
            text,
            timestamp: Date.now(),
            author: msg.author,
          };
          // Prepend so the mission stays at the top even if a delta raced ahead
          // of this frame.
          return { ...ses, messages: [seedMsg, ...ses.messages] };
        }),
      };
    }

    if (msg.type === 'reasoning') {
      // Transient reasoning signal: flip the matching session's animated
      // "Reasoning" indicator on/off. ``active=true`` → thinking with no
      // visible output yet; ``active=false`` → output started or turn ended.
      // The reasoning ping is frequently the FIRST frame emitted by a child.
      // The lazy-stub path above therefore creates the row and opens its local
      // turn before this branch runs, so navigating into that child paints the
      // same animated indicator as the parent immediately.
      return {
        sessions: s.sessions.map((ses) =>
          ses.id !== msg.session_id
            ? ses
            : {
              ...ses,
              isProcessing: msg.active ? true : ses.isProcessing,
              isReasoning: msg.active,
            },
        ),
      };
    }

    if (msg.type === 'session_compacted') {
      // In-place compaction (vision §2). ``running`` opens a compaction
      // card; the terminal ``done``/``error`` frame resolves that same
      // card in place so the two render as ONE tool-style entry. A
      // terminal frame with no running card to patch (running missed, or
      // a manual /compact with no prior card) still lands as its own card.
      const phase = msg.phase || 'done';
      const info: CompactionInfo = {
        phase,
        foldedRuns: msg.folded_runs,
        keptRuns: msg.kept_runs_count,
        summaryChars: msg.summary_chars,
        tokensBefore: msg.tokens_before,
        tokensAfter: msg.tokens_after,
      };
      return {
        sessions: s.sessions.map((ses) => {
          if (ses.id !== msg.session_id) return ses;
          const msgs = [...ses.messages];
          if (phase !== 'running') {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'compaction'
                  && msgs[i].compactionInfo?.phase === 'running') {
                msgs[i] = { ...msgs[i], compactionInfo: info };
                return { ...ses, messages: msgs };
              }
            }
          }
          msgs.push({
            id: genId(),
            role: 'compaction' as const,
            text: '',
            timestamp: Date.now(),
            compactionInfo: info,
          });
          return { ...ses, messages: msgs };
        }),
      };
    }

    if (msg.type === 'status') {
      const text = msg.text || '';

      // Try to parse as structured tool event. The server emits
      // its native ``ToolExecution.to_dict()`` shape — phase
      // (running / completed / error) is derived locally below.
      let toolInfo: ToolInfo | undefined;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.tool_name) toolInfo = parsed as ToolInfo;
      } catch { /* plain text status */ }

      if (toolInfo) {
        return {
          sessions: s.sessions.map((ses) => {
            if (ses.id !== msg.session_id) return ses;
            return { ...ses, messages: appendOrPatchTool(ses.messages, toolInfo!) };
          }),
        };
      }

      // Legacy plain text tool status ("Using ...")
      const isTool = text.startsWith('Using ');
      return {
        sessions: s.sessions.map((ses) => {
          if (ses.id !== msg.session_id) return ses;
          if (isTool) {
            return {
              ...ses,
              statusText: text,
              messages: [...ses.messages, {
                id: genId(),
                role: 'tool' as const,
                text,
                timestamp: Date.now(),
              }],
            };
          }
          return { ...ses, statusText: text };
        }),
      };
    }

    if (msg.type === 'delta') {
      // Token-streaming chunk for the in-progress assistant bubble.
      // Coalesced via the module-level buffer above so we collapse a
      // burst of deltas into one set() per animation frame.
      const delta = msg.text || '';
      // Commit a just-created stub session so the deferred flush below (which
      // reads fresh state) can find it; otherwise the first child delta drops.
      if (!delta) return stubAdded ? { sessions: s.sessions } : {};
      const sid = msg.session_id;
      pendingDeltas.set(sid, (pendingDeltas.get(sid) ?? '') + delta);
      scheduleDeltaFlush((snapshot) => {
        set((cur) => ({
          sessions: cur.sessions.map((ses) => {
            const buffered = snapshot.get(ses.id);
            if (!buffered) return ses;
            const msgs = [...ses.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
              msgs[msgs.length - 1] = { ...last, text: last.text + buffered };
            } else {
              msgs.push({
                id: genId(),
                role: 'assistant' as const,
                text: buffered,
                timestamp: Date.now(),
                streaming: true,
              });
            }
            return {
              ...ses,
              messages: msgs,
              statusText: undefined,
              // Visible output has started — clear the reasoning shimmer
              // (safety net per the wire contract in case the server's
              // explicit ``reasoning active=false`` frame was missed).
              isReasoning: false,
              // NOTE: deliberately NOT re-stamping lastActiveAt here. It is
              // set on user send (addUserMessage) and hydrate; restamping it
              // every animation frame churned the sort key and forced the
              // recent-session feed to re-sort + re-render ~60x/s while
              // streaming, for a value that only changes at 1s granularity.
              hasUnread: cur.activeSessionId === ses.id ? ses.hasUnread : true,
            };
          }),
        }));
      });
      // Commit the stub (if any) so the deferred flush finds the session row.
      return stubAdded ? { sessions: s.sessions } : {};
    }

    if (msg.type === 'response') {
      const attachments = normalizedAttachments(msg.attachments);
      // Drop any buffered deltas for this session — the response
      // frame is canonical, applying them on top would duplicate
      // content.
      pendingDeltas.delete(msg.session_id);
      return {
        sessions: s.sessions.map((ses) => {
          if (ses.id !== msg.session_id) return ses;
          const msgs = [...ses.messages];
          const last = msgs[msgs.length - 1];
          // If a streaming bubble is in-flight, replace its content
          // with the canonical RESPONSE text (which strips attachment
          // markers + carries model meta). Otherwise append a new
          // bubble — the legacy single-RESPONSE path used by older
          // gateways and clients that ignore ``delta``.
          if (last && last.role === 'assistant' && last.streaming) {
            msgs[msgs.length - 1] = {
              ...last,
              text: msg.text,
              attachments,
              parts: normalizeMessageContent(msg.parts, msg.artifacts, msg.text, attachments ?? []),
              model: msg.model,
              streaming: false,
            };
          } else {
            msgs.push({
              id: genId(),
              role: 'assistant' as const,
              text: msg.text,
              timestamp: Date.now(),
              attachments,
              parts: normalizeMessageContent(msg.parts, msg.artifacts, msg.text, attachments ?? []),
              model: msg.model,
            });
          }
          return {
            ...ses,
            isProcessing: false,
            statusText: undefined,
            // Turn ended — clear the reasoning shimmer (safety net).
            isReasoning: false,
            messages: msgs,
          };
        }),
      };
    }

    if (msg.type === 'error') {
      // Route to the originating session (gateway sets session_id on
      // errors raised inside _process_message). Fall back to the chat
      // tab's active session for legacy/global errors with no id —
      // without this fallback an old gateway would silently swallow
      // every error frame.
      const targetId = msg.session_id ?? s.activeSessionId;
      return {
        sessions: s.sessions.map((ses) =>
          ses.id !== targetId ? ses : {
            ...ses,
            isProcessing: false,
            statusText: undefined,
            // Turn ended (errored) — clear the reasoning shimmer (safety net).
            isReasoning: false,
            messages: [...ses.messages, {
              id: genId(),
              role: 'assistant' as const,
              text: `Error: ${msg.text}`,
              timestamp: Date.now(),
            }],
          },
        ),
      };
    }

    return {};
  }),

  finaliseStreaming: (sessionId) => {
    set((s) => ({
      sessions: s.sessions.map((ses) => {
        if (ses.id !== sessionId) return ses;
        // Flush any buffered deltas for this session so nothing is lost.
        pendingDeltas.delete(sessionId);
        // Clear the stuck streaming flag on the last assistant bubble (if any)
        // and mark the session as no longer processing. This is idempotent:
        // if ``response`` already landed and cleaned up, the messages and
        // isProcessing flag are already correct and this is a no-op.
        const msgs = ses.messages.map((m) =>
          m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
        );
        return {
          ...ses,
          isProcessing: false,
          isReasoning: false,
          statusText: undefined,
          messages: msgs,
        };
      }),
    }));
  },

  noteTurnOutcome: (sessionId, reason, error) => set((s) => {
    const ses = s.sessions.find((x) => x.id === sessionId);
    if (!ses) return {};
    // Did this turn actually produce something? The last message being an
    // assistant one with text is the honest test: an errored turn that still
    // streamed an answer before failing does not need a tombstone.
    const last = ses.messages[ses.messages.length - 1];
    if (last && last.role === 'assistant' && (last.text || '').trim()) return {};
    const text = reason === 'cancelled'
      ? 'Turn stopped.'
      : reason === 'empty'
        ? 'The turn ended without an answer.'
        : `Turn failed${error ? `: ${error}` : '.'}`;
    return {
      sessions: s.sessions.map((x) => (x.id !== sessionId ? x : {
        ...x,
        messages: [...x.messages, {
          id: genId(),
          role: 'assistant' as const,
          text,
          timestamp: Date.now(),
        }],
      })),
    };
  }),

  settleStaleTurns: (attachedAt) => {
    // The question this answers is "is that turn still alive?", and neither
    // the session listing nor a timeout can answer it on their own: a turn
    // that is genuinely running is absent from the listing until its run is
    // persisted (which happens at the END of the turn), and a long tool call
    // is legitimately silent for a while. What IS decisive is the gateway's
    // reattach contract — right after ``auth_ok`` it replays a ``live_state``
    // snapshot for every turn it still owns, and prunes the ones it does not.
    // So: heard nothing since we attached ⇒ nobody is running this turn.
    const stale = get().sessions.filter((se) => (
      (se.isProcessing || se.isReasoning)
      && !se.messages.some(message => message.sharedTurnId && message.streaming)
      && (lastFrameAt.get(se.id) ?? 0) < attachedAt
    ));
    if (stale.length === 0) return;
    const staleIds = new Set(stale.map((se) => se.id));
    set((s) => ({
      sessions: s.sessions.map((se) => {
        if (!staleIds.has(se.id)) return se;
        return {
          ...se,
          isProcessing: false,
          isReasoning: false,
          statusText: undefined,
          messages: [
            ...se.messages.map((m) => (
              m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m
            )),
            {
              id: genId(),
              role: 'assistant' as const,
              text: 'Turn interrupted — the agent restarted or the connection '
                + 'dropped before it could answer. Send the message again to retry.',
              timestamp: Date.now(),
            },
          ],
        };
      }),
    }));
    // Now that the flags are clear, ask the database. Two outcomes, both
    // right: the turn actually finished while we were away and its runs are
    // stored, so the real transcript replaces the note; or there is nothing
    // stored, ``reconcileSession`` leaves the optimistic transcript alone,
    // and the note stands as the explanation.
    staleIds.forEach((sid) => get().reconcileSession(sid));
  },

  reconcileSession: async (sessionId) => {
    const ses = get().sessions.find((s) => s.id === sessionId);
    // Only reconcile a session we know about and that isn't mid-turn. (A new
    // turn flips isProcessing true; clobbering it would drop the just-typed
    // message.)
    if (!ses || ses.isProcessing) return;
    const mode = get().sessionHistoryMode;
    const current = sessionReadGuard(sessionId);
    return loadSessionTranscript(sessionId, mode)
      .then((loaded) => {
        if (!current()) return;
        // Empty result → keep the optimistic transcript (the runs may not be
        // flushed yet); never wipe a visible conversation to nothing.
        const hasMessages = loaded.kind === 'v2'
          ? loaded.page.messages.length > 0
          : loaded.messages.length > 0;
        if (!hasMessages) return;
        set((s) => ({
          sessions: s.sessions.map((se) => {
            if (se.id !== sessionId) return se;
            // Re-check at apply time: a turn may have started during the fetch.
            if (se.isProcessing) return se;
            return { ...se, ...transcriptPatch(loaded, se.messages, se.sharedSnapshot) };
          }),
        }));
      })
      .catch(() => {});
  },

  applyContextReport: (sessionId, report) => set((s) => {
    // Only patch a session we already know about — the panel binds to the
    // active session, which always exists by the time a report arrives.
    if (!report || !s.sessions.some((ses) => ses.id === sessionId)) return {};
    return {
      sessions: s.sessions.map((ses) =>
        ses.id === sessionId ? { ...ses, contextUsage: report } : ses,
      ),
    };
  }),

  refreshContext: (sessionId) => {
    if (!sessionId) return;
    const current = sessionReadGuard(sessionId);
    getSessionContext(sessionId)
      .then((report) => {
        if (!current()) return;
        // A valid report has a real window; the empty-session shape
        // (context_window 0) is ignored so the panel keeps its last good state.
        if (!report || !report.context_window) return;
        get().applyContextReport(sessionId, report);
      })
      .catch(() => {});
  },

  dropSessionLocal: (sessionId) => set((s) => {
    if (!s.sessions.some((ses) => ses.id === sessionId)) return {};
    const sessions = s.sessions.filter((ses) => ses.id !== sessionId);
    let activeSessionId = s.activeSessionId;
    if (s.activeSessionId === sessionId) {
      activeSessionId = sessions[0]?.id ?? null;
    }
    return { sessions, activeSessionId };
  }),

  clearAll: () => {
    resetSessionReadAccess();
    earlierPageLoads.clear();
    set({
      sessions: [],
      activeSessionId: null,
      sessionsHydrated: false,
      sessionHistoryMode: 'unknown',
    });
  },

  loadSession: (id, title, history) => {
    const buildToolInfo = (entry: typeof history[0]): ToolInfo | undefined => {
      const name = entry.tool_name;
      if (!name) return undefined;
      // Server-native tool-execution shape — phase is derived in the
      // renderer from ``tool_call_error`` + ``result`` presence. Errors
      // carry the message in ``result`` (same convention live wire
      // frames use).
      const isError = !!entry.tool_error;
      return {
        tool_name: name,
        tool_args: entry.tool_args ?? {},
        tool_call_error: isError,
        result: isError
          ? (entry.tool_error ?? null)
          : (entry.tool_result ?? null),
      };
    };
    const messages: ChatMessage[] = history.map((entry, i) => {
      const toolInfo = buildToolInfo(entry);
      if (toolInfo) {
        return {
          id: `load-${id}-${i}-${Date.now()}`,
          role: 'tool' as const,
          text: JSON.stringify(toolInfo),
          timestamp: Date.now() - (history.length - i) * 1000,
          toolInfo,
        };
      }
      if (entry.role === 'user') {
        return {
          id: `load-${id}-${i}-${Date.now()}`,
          role: 'user' as const,
          text: entry.content,
          timestamp: Date.now() - (history.length - i) * 1000,
        };
      }
      return {
        id: `load-${id}-${i}-${Date.now()}`,
        role: 'assistant' as const,
        text: entry.content,
        timestamp: Date.now() - (history.length - i) * 1000,
      };
    });
    const session: ChatSession = { id, title, messages, isProcessing: false };
    set((s) => {
      const existing = s.sessions.some((ses) => ses.id === id);
      const sessions = existing
        ? s.sessions.map((ses) => (ses.id === id ? session : ses))
        : [...s.sessions, session];
      return { sessions, activeSessionId: id };
    });
    return id;
  },
}));
