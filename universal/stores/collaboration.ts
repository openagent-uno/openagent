import { create } from 'zustand';
import type { SharedPerson, SharedTarget } from '../../common/collaboration';
import { mergeSharedTranscript } from '../../common/shared-transcript';
import { CollaborationClient } from '../services/collaboration';
import { useChat } from './chat';
import { getSessionModelPin } from '../services/api';

export const useCollaboration = create<{ client: CollaborationClient | null; people: readonly SharedPerson[] }>(() => ({ client: null, people: [] }));
const leases = new Map<symbol, { sessions: string[]; focus: SharedTarget | null }>();
let client: CollaborationClient | null = null;
const revisions = new Map<string, number>();
const active = new Map<string, boolean>();
// Bumped whenever a session's shared state is dropped. Async follow-ups
// (durable commands, model pin) captured before a revoke/regrant must not
// apply their older answer on top of the state that replaced it.
const generations = new Map<string, number>();

function observe() {
  const all = [...leases.values()];
  const focused = all.filter(l => l.focus?.kind === 'session').map(l => l.focus!.id);
  const sessions = [...new Set([...focused, ...all.flatMap(l => l.sessions)])].slice(0, 16);
  client?.observe(sessions, all.findLast(l => l.focus)?.focus ?? null);
}
export function observeShared(sessions: string[], focus: SharedTarget | null) {
  const key = Symbol(); leases.set(key, { sessions, focus }); observe();
  return () => { leases.delete(key); observe(); };
}
export function bindShared(next: CollaborationClient | null) {
  client = next; revisions.clear(); active.clear(); generations.clear();
  useCollaboration.setState({ client, people: [] });
  if (!next) return () => {};
  const unsubscribe = next.subscribe(() => {
    if (client !== next) return;
    useCollaboration.setState({ people: next.presence() });
    const ids = new Set([...leases.values()].flatMap(l => l.sessions));
    for (const id of ids) {
      const snapshot = next.snapshot(id);
      if (!snapshot) {
        if (revisions.delete(id)) {
          generations.set(id, (generations.get(id) ?? 0) + 1);
          // A withdrawn grant (or logout) must drop the cached snapshot AND the
          // visible text: a history fetch still in flight would otherwise merge
          // the revoked transcript back in. A socket that merely dropped keeps
          // the transcript, but still discards the snapshot so nothing stale
          // can be re-merged before the reconnect delivers a fresh one.
          const withdrawn = next.revoked(id);
          useChat.setState(s => ({ sessions: s.sessions.map(se => se.id === id
            ? (withdrawn
              ? { ...se, messages: [], sharedSnapshot: undefined, isProcessing: false, isReasoning: undefined, statusText: undefined }
              : { ...se, sharedSnapshot: undefined })
            : se) }));
        }
        continue;
      }
      if (revisions.get(id) === snapshot.revision) continue;
      revisions.set(id, snapshot.revision);
      // Native audio/automation turns already arrive through OpenAgentWS.
      // Only HTTP-owned turns use this transcript reducer; presence is common.
      if (snapshot.turns.length && !snapshot.turns.at(-1)?.runId) continue;
      const running = snapshot.turns.some(t => t.active);
      const last = snapshot.turns.at(-1);
      let status = last?.status;
      try { const tool = JSON.parse(status || ''); if (tool.tool_name) status = `Using ${tool.tool_name}`; } catch { /* plain status */ }
      useChat.setState(s => ({ sessions: (s.sessions.some(se => se.id === id) ? s.sessions : [...s.sessions, { id, title: 'Session', messages: [], isProcessing: false, origin: 'delegation' as const }]).map(se => se.id === id ? {
        ...se, messages: mergeSharedTranscript(se.messages, snapshot), isProcessing: running,
        sharedSnapshot: snapshot,
        isReasoning: last?.reasoning, statusText: running ? status : undefined,
      } : se) }));
      if (!running && (active.get(id) !== false || snapshot.turns.length)) {
        const generation = generations.get(id) ?? 0;
        const current = () => client === next && !!next.snapshot(id) && (generations.get(id) ?? 0) === generation;
        void Promise.resolve(useChat.getState().reconcileSession(id)).then(() => next.commands(id)).then(history => {
          if (current()) useChat.setState(s => ({ sessions: s.sessions.map(se => se.id === id
            ? { ...se, messages: mergeSharedTranscript(se.messages, history) } : se) }));
        }).catch(() => {});
        void getSessionModelPin(id).then(pin => {
          if (current()) useChat.getState().setLlmPin(id, pin.runtime_id || undefined);
        }).catch(() => {});
      }
      active.set(id, running);
    }
  });
  observe();
  return () => { unsubscribe(); if (client === next) { client = null; useCollaboration.setState({ client: null, people: [] }); } };
}
