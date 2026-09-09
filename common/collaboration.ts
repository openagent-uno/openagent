/** Additive collaboration/1 contract. Snapshots replace, never append deltas. */
export type SharedTarget = { kind: 'session' | 'workflow' | 'scheduled_task' | 'event'; id: string };
export type SharedPerson = { userId: string; name: string; target: SharedTarget };
export type SharedAuthor = { kind: 'human' | 'agent'; userId?: string; handle?: string; display?: string };
export type SharedTurn = {
  id: string; runId: string | null; active: boolean; startedAt: number;
  finishedAt?: number; status?: string; reasoning?: boolean; error?: string; truncated?: boolean;
  messages: { id: string; role: 'user' | 'assistant'; text: string; timestamp: number; author?: SharedAuthor; model?: string }[];
};
export type SharedSnapshot = { session_id: string; revision: number; turns: SharedTurn[] };
export type SharedTurnResult = { session_id: string; request_id: string; response: string; model?: string; errored?: boolean; interrupted?: boolean };

export function validSharedTarget(value: unknown): value is SharedTarget {
  const target = value as SharedTarget | null;
  return !!target && ['session', 'workflow', 'scheduled_task', 'event'].includes(target.kind)
    && typeof target.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(target.id);
}

export function validSharedSnapshot(value: unknown): value is SharedSnapshot {
  const state = value as SharedSnapshot | null;
  return !!state && validSharedTarget({ kind: 'session', id: state.session_id })
    && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.turns) && state.turns.length <= 8 && state.turns.every(turn =>
      !!turn && typeof turn.id === 'string' && turn.id.length <= 128 && typeof turn.active === 'boolean'
      && Number.isFinite(turn.startedAt) && Array.isArray(turn.messages) && turn.messages.length <= 2
      && turn.messages.every(message => !!message && typeof message.id === 'string'
        && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'
        && message.text.length <= 262144 && Number.isFinite(message.timestamp)
        && (!message.author || (['human', 'agent'].includes(message.author.kind)
          && [message.author.userId, message.author.handle, message.author.display]
            .every(field => field === undefined || (typeof field === 'string' && field.length <= 1024))))));
}
