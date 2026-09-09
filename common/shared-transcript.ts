import type { ChatMessage } from './types';
import type { SharedSnapshot } from './collaboration';

/** Reconcile by durable run identity. Equal text from different turns is distinct. */
export function mergeSharedTranscript(previous: ChatMessage[], snapshot: SharedSnapshot): ChatMessage[] {
  const turns = new Set(snapshot.turns.map(t => t.id));
  const durableRuns = new Set(previous.filter(m => !m.sharedTurnId && m.providerRunId).map(m => m.providerRunId));
  const replacedRuns = new Set(snapshot.turns.filter(t => t.active).map(t => t.providerRunId).filter(Boolean));
  const base = previous.filter(m => !turns.has(m.sharedTurnId || '') && !replacedRuns.has(m.providerRunId));
  for (const turn of snapshot.turns) {
    if (!turn.runId) continue; // Native transports have their own live reducer.
    if (!turn.active && turn.providerRunId && durableRuns.has(turn.providerRunId)) continue;
    for (const message of turn.messages) base.push({
      ...message, id: `shared:${turn.id}:${message.id}`, sharedTurnId: turn.id,
      providerRunId: turn.providerRunId, timestamp: message.timestamp * 1000,
      streaming: turn.active && message.role === 'assistant',
    });
    if (turn.error) base.push({ id: `shared:${turn.id}:error`, sharedTurnId: turn.id,
      role: 'assistant', text: turn.error, timestamp: (turn.finishedAt || turn.startedAt) * 1000 });
  }
  return base.sort((a, b) => a.timestamp - b.timestamp);
}
