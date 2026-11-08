import type { ChatMessage } from './types';
import type { SharedSnapshot } from './collaboration';

/** Reconcile by durable run identity. Equal text from different turns is distinct. */
export function mergeSharedTranscript(previous: ChatMessage[], snapshot: SharedSnapshot): ChatMessage[] {
  const turns = new Set(snapshot.turns.map(t => t.id));
  const durableRuns = new Map<string, ChatMessage[]>();
  for (const message of previous) {
    if (message.sharedTurnId || !message.providerRunId) continue;
    const group = durableRuns.get(message.providerRunId) ?? [];
    group.push(message);
    durableRuns.set(message.providerRunId, group);
  }
  const replacedRuns = new Set(snapshot.turns.filter(t => t.active).map(t => t.providerRunId).filter(Boolean));
  const base = previous.filter(m => !turns.has(m.sharedTurnId || '') && !replacedRuns.has(m.providerRunId));
  for (const turn of snapshot.turns) {
    if (!turn.runId) continue; // Native transports have their own live reducer.
    const response = turn.messages.find(message => message.role === 'assistant');
    const durable = !turn.active && turn.providerRunId ? durableRuns.get(turn.providerRunId) : undefined;
    const durableReplies = durable?.filter(message => message.role === 'assistant') ?? [];
    const hasPositions = turn.tools?.some(tool => tool.afterText !== undefined);
    // Only reuse positions for the exact canonical answer. A protected or
    // revised answer must not recover any obsolete streamed text or cards.
    const canonical = durableReplies.length === 1 && response && hasPositions
      && durableReplies[0].text === response.text ? durableReplies[0] : undefined;
    const responseId = canonical?.id ?? (response ? `shared:${turn.id}:${response.id}` : undefined);

    const toolRows = (turn.tools ?? []).map((tool, order): ChatMessage => ({
      id: `shared:${turn.id}:tool:${tool.id}`, sharedTurnId: turn.id, role: 'tool', text: '',
      toolInfo: tool.toolInfo, providerRunId: turn.providerRunId, timestamp: tool.timestamp * 1000,
      ...(responseId !== undefined && tool.afterText !== undefined
        ? { toolPosition: { messageId: responseId, afterText: tool.afterText, order } } : {}),
    }));
    if (durable) {
      if (canonical) {
        const byCall = new Map(durable.filter(m => m.role === 'tool' && m.toolInfo?.tool_call_id)
          .map(m => [m.toolInfo!.tool_call_id, m]));
        for (const tool of toolRows) {
          if (!tool.toolPosition) continue;
          const current = byCall.get(tool.toolInfo!.tool_call_id);
          if (current) {
            const index = base.indexOf(current);
            if (index >= 0) base[index] = { ...current, toolPosition: tool.toolPosition };
          } else {
            base.push(tool);
          }
        }
      }
      continue;
    }
    for (const message of turn.messages) base.push({
      ...message, id: `shared:${turn.id}:${message.id}`, sharedTurnId: turn.id,
      providerRunId: turn.providerRunId, timestamp: message.timestamp * 1000,
      streaming: turn.active && message.role === 'assistant',
    });
    base.push(...toolRows);
    if (turn.error) base.push({ id: `shared:${turn.id}:error`, sharedTurnId: turn.id,
      role: 'assistant', text: turn.error, timestamp: (turn.finishedAt || turn.startedAt) * 1000 });
  }
  return base.sort((a, b) => a.timestamp - b.timestamp);
}

/** Split only the rendered reply. Keep durable rows and pagination anchors
 * intact in the store. Tool updates keep their card ID. */
export function placeSharedTools(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  if (!messages.some(message => message.toolPosition)) return messages;
  const replies = new Map(messages.filter(m => m.role === 'assistant').map(m => [m.id, m]));
  const toolsByReply = new Map<string, ChatMessage[]>();
  const placed = new Set<ChatMessage>();
  for (const tool of messages) {
    const position = tool.toolPosition;
    if (tool.role !== 'tool' || !position || !replies.has(position.messageId)) continue;
    const tools = toolsByReply.get(position.messageId) ?? [];
    tools.push(tool);
    toolsByReply.set(position.messageId, tools);
    placed.add(tool);
  }
  if (!placed.size) return messages;
  return messages.flatMap(message => {
    if (placed.has(message)) return [];
    const tools = toolsByReply.get(message.id);
    if (!tools) return [message];
    tools.sort((a, b) => a.toolPosition!.order - b.toolPosition!.order);
    return splitReply(message, tools);
  });
}

function splitReply(message: ChatMessage, tools: ChatMessage[]): ChatMessage[] {
  const characters = Array.from(message.text);
  const originalParts = message.parts ?? [];
  if (originalParts.length && originalParts.map(part => part.kind === 'text' ? part.text : '').join('') !== message.text) {
    // No reliable mapping from plain-text positions to this rich answer.
    return [...tools, message];
  }
  const rows: ChatMessage[] = [];
  let offset = 0;
  let partIndex = 0;
  let partOffset = 0;
  let previousTool: string | undefined;
  let first = true;
  const appendSegment = (end: number, final: boolean) => {
    const text = characters.slice(offset, end).join('');
    offset = end;
    let remaining = text.length;
    const parts = [] as NonNullable<ChatMessage['parts']>;
    while (partIndex < originalParts.length && (remaining > 0 || final)) {
      const part = originalParts[partIndex];
      if (part.kind !== 'text') {
        parts.push(part);
      } else {
        const length = Math.min(remaining, part.text.length - partOffset);
        if (length > 0) parts.push({ ...part, text: part.text.slice(partOffset, partOffset + length) });
        remaining -= length;
        partOffset += length;
        if (partOffset < part.text.length) break;
      }
      partIndex++;
      partOffset = 0;
    }
    const attachments = final && !originalParts.length ? message.attachments : undefined;
    if (!text && !parts.length && !attachments?.length) return;
    rows.push({
      ...message, id: first ? message.id : `${message.id}:after:${previousTool}`,
      text, parts: parts.length ? parts : undefined, attachments,
      streaming: final && message.streaming,
    });
    first = false;
  };
  for (const tool of tools) {
    const end = Math.max(offset, Math.min(tool.toolPosition!.afterText, characters.length));
    appendSegment(end, false);
    rows.push(tool);
    previousTool = tool.id;
  }
  appendSegment(characters.length, true);
  return rows;
}
