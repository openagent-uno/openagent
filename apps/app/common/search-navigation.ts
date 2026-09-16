import type { EventCause, SearchRootKind, SearchTarget } from './unified-history';

/** Pure, serializable route intent. The universal service performs the push. */
export interface SearchNavigationIntent {
  pathname: string;
  params: Record<string, string>;
}

/**
 * Every route into Chat carries the session identity. A bare `/chat` route is
 * ambiguous once React Navigation keeps multiple Chat entries in its stack:
 * returning from Settings can otherwise restore an older route parameter and
 * hide a newer turn that is still streaming in memory.
 */
export function chatSessionIntent(sessionId: string): SearchNavigationIntent {
  return { pathname: '/chat', params: { session: sessionId } };
}

/** Presentation metadata that lets Chat replace a lazy search-result stub
 * with the canonical title without loading any message content eagerly. */
export interface SearchOpenMetadata {
  title: string;
  occurredAt: string;
  rootKind: SearchRootKind;
}

export interface ChatAnchorInput {
  sessionId?: string;
  messageId?: string;
  toolInvocationId?: string;
  generation?: number;
}

export interface ResolvedChatAnchor {
  sessionId?: string;
  messageId?: string;
  toolInvocationId?: string;
  generation: number;
}

/**
 * Prefer the latest in-app search selection over route parameters: an outer
 * React Navigation Drawer may retain an older query string when opening a
 * second result on the already-focused Chat screen. An explicit root-chat
 * selection therefore resolves to no anchor and clears that stale highlight.
 */
export function resolveChatAnchor(
  route: ChatAnchorInput,
  inApp: ChatAnchorInput | null,
  activeSessionId?: string | null,
): ResolvedChatAnchor {
  const current = inApp?.sessionId === activeSessionId ? inApp : null;
  if (current) {
    return current.messageId
      ? {
          sessionId: current.sessionId,
          messageId: current.messageId,
          toolInvocationId: current.toolInvocationId,
          generation: current.generation ?? 0,
        }
      : { generation: current.generation ?? 0 };
  }
  return {
    sessionId: route.sessionId,
    messageId: route.messageId,
    toolInvocationId: route.toolInvocationId,
    generation: 0,
  };
}

export type ChatSearchTarget = Extract<
  SearchTarget,
  { kind: 'chat' | 'chat_message' | 'chat_tool' }
>;

export function isChatSearchTarget(target: SearchTarget): target is ChatSearchTarget {
  return target.kind === 'chat'
    || target.kind === 'chat_message'
    || target.kind === 'chat_tool';
}

function addCause(params: Record<string, string>, causedBy?: EventCause | null): void {
  if (!causedBy) return;
  params.causedByEvent = causedBy.event_id;
  params.causedByDelivery = causedBy.delivery_id;
  params.causedByTitle = causedBy.title;
}

function unreachable(target: never): never {
  throw new Error(`Unsupported search target: ${JSON.stringify(target)}`);
}

/**
 * Exhaustive wire-target to existing Expo Router mapping.
 * SearchRoot is intentionally not accepted: it is display/grouping metadata,
 * not an authorized fallback navigation target.
 */
export function searchNavigationIntent(
  target: SearchTarget,
  causedBy?: EventCause | null,
): SearchNavigationIntent {
  switch (target.kind) {
    case 'chat':
      return chatSessionIntent(target.session_id);
    case 'chat_message':
      return {
        pathname: '/chat',
        params: { session: target.session_id, message: target.message_id },
      };
    case 'chat_tool':
      return {
        pathname: '/chat',
        params: {
          session: target.session_id,
          message: target.message_id,
          toolInvocation: target.tool_invocation_id,
        },
      };
    case 'workflow_definition': {
      const params: Record<string, string> = { id: target.workflow_id };
      if (target.node_id) params.node = target.node_id;
      if (target.field) params.field = target.field;
      return { pathname: '/(tabs)/workflows/[id]', params };
    }
    case 'workflow_run': {
      const params: Record<string, string> = {
        id: target.run_id,
        kind: 'workflow',
        parentId: target.workflow_id,
      };
      if (target.trace_step_id) params.traceStep = target.trace_step_id;
      if (target.tool_invocation_id) params.toolInvocation = target.tool_invocation_id;
      addCause(params, causedBy);
      return { pathname: '/(tabs)/runs/[id]', params };
    }
    case 'scheduled_definition': {
      const params: Record<string, string> = { id: target.task_id };
      if (target.field) params.field = target.field;
      return { pathname: '/(tabs)/tasks/[id]', params };
    }
    case 'scheduled_run': {
      const params: Record<string, string> = {
        id: target.run_id,
        kind: 'task',
        parentId: target.task_id,
      };
      if (target.session_id) params.session = target.session_id;
      if (target.message_id) params.message = target.message_id;
      if (target.tool_invocation_id) params.toolInvocation = target.tool_invocation_id;
      addCause(params, causedBy);
      return { pathname: '/(tabs)/runs/[id]', params };
    }
    case 'event_definition': {
      const params: Record<string, string> = { id: target.event_id };
      if (target.field) params.field = target.field;
      return { pathname: '/(tabs)/events/[id]', params };
    }
    case 'event_delivery': {
      const params: Record<string, string> = {
        id: target.delivery_id,
        kind: 'event',
        parentId: target.event_id,
      };
      if (target.session_id) params.session = target.session_id;
      if (target.message_id) params.message = target.message_id;
      if (target.tool_invocation_id) params.toolInvocation = target.tool_invocation_id;
      addCause(params, causedBy);
      return { pathname: '/(tabs)/runs/[id]', params };
    }
    case 'ui_view':
      return { pathname: '/(tabs)/views/[id]', params: { id: target.view_id } };
    default:
      return unreachable(target);
  }
}
