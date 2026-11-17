import { create } from 'zustand';
import type { SharedPerson, SharedSnapshot, SharedTarget } from '../../common/collaboration';
import { mergeSharedTranscript, unconfirmedMessages } from '../../common/shared-transcript';
import { CollaborationClient } from '../services/collaboration';
import { useChat } from './chat';
import { sessionIsRevoked, setSessionRevoked } from './sessionReadAccess';
import { getSessionModelPin } from '../services/api';

export const useCollaboration = create<{ client: CollaborationClient | null; people: readonly SharedPerson[] }>(() => ({ client: null, people: [] }));
const leases = new Map<symbol, { sessions: string[]; focus: SharedTarget | null }>();
let client: CollaborationClient | null = null;
// Wire revisions are fenced by CollaborationClient. An exact terminal HTTP
// receipt can also replace a projection at the same wire revision.
const projections = new Map<string, SharedSnapshot>();
const active = new Map<string, boolean>();
const refreshCycles = new Map<string, symbol>();
const retryRefresh = new Set<string>();
// Bumped whenever a session's shared state is dropped. Async follow-ups
// (durable commands, model pin) captured before a revoke/regrant must not
// apply their older answer on top of the state that replaced it.
const generations = new Map<string, number>();

function sameSharedHistory(previous: SharedSnapshot | undefined, next: SharedSnapshot): boolean {
  if (!previous) return false;
  // Wire revision and idle status/finish timestamps do not change durable
  // transcript data. Messages, tool results and run identity still invalidate
  // history even when no new turn was started or finished.
  const history = (snapshot: SharedSnapshot) => snapshot.turns.map(turn => ({
    id: turn.id, runId: turn.runId, providerRunId: turn.providerRunId,
    messages: turn.messages, tools: turn.tools, error: turn.error, truncated: turn.truncated,
  }));
  return JSON.stringify(history(previous)) === JSON.stringify(history(next));
}

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
  client = next; projections.clear(); active.clear(); refreshCycles.clear(); retryRefresh.clear(); generations.clear();
  useCollaboration.setState({ client, people: [] });
  if (!next) return () => {};
  const unsubscribe = next.subscribe(() => {
    if (client !== next) return;
    useCollaboration.setState({ people: next.presence() });
    const ids = new Set([
      ...[...leases.values()].flatMap(l => [...l.sessions, ...(l.focus?.kind === 'session' ? [l.focus.id] : [])]),
      ...useChat.getState().sessions.filter(se => next.revoked(se.id)).map(se => se.id),
    ]);
    for (const id of ids) {
      const snapshot = next.snapshot(id);
      if (!snapshot) {
        const withdrawn = next.revoked(id);
        if (projections.delete(id) || (withdrawn && !sessionIsRevoked(id))) {
          generations.set(id, (generations.get(id) ?? 0) + 1);
          refreshCycles.delete(id);
          retryRefresh.delete(id);
          // A fresh attachment (including an empty/pruned projection) must
          // reconcile once even if the old attachment already appeared idle.
          active.delete(id);
          // A withdrawn grant (or logout) must drop the cached snapshot AND the
          // visible text: a history fetch still in flight would otherwise merge
          // the revoked transcript back in. A socket that merely dropped keeps
          // the transcript, but still discards the snapshot so nothing stale
          // can be re-merged before the reconnect delivers a fresh one.
          if (withdrawn) setSessionRevoked(id, true);
          useChat.setState(s => ({ sessions: (withdrawn && !s.sessions.some(se => se.id === id)
            ? [...s.sessions, { id, title: 'Session', messages: [], isProcessing: false }]
            : s.sessions).map(se => se.id === id
            ? (withdrawn
              ? { ...se, accessRevoked: true, messages: [], outbound: undefined, sharedSnapshot: undefined, messageWindow: undefined, loadedRanges: undefined, contextUsage: undefined, isProcessing: false, isReasoning: undefined, statusText: undefined }
              : { ...se, sharedSnapshot: undefined })
            : se) }));
        }
        continue;
      }
      if (sessionIsRevoked(id)) {
        setSessionRevoked(id, false);
        useChat.setState(s => ({ sessions: s.sessions.map(se => se.id === id ? { ...se, accessRevoked: false } : se) }));
      }
      const previous = projections.get(id);
      if (previous === snapshot && !retryRefresh.has(id)) continue;
      projections.set(id, snapshot);
      // Native audio/automation turns already arrive through OpenAgentWS.
      // Only HTTP-owned turns use this transcript reducer; presence is common.
      if (snapshot.turns.length && !snapshot.turns.at(-1)?.runId) continue;
      const running = snapshot.turns.some(t => t.active);
      const last = snapshot.turns.at(-1);
      let status = last?.status;
      try { const tool = JSON.parse(status || ''); if (tool.tool_name) status = `Using ${tool.tool_name}`; } catch { /* plain status */ }
      useChat.setState(s => ({ sessions: (s.sessions.some(se => se.id === id) ? s.sessions : [...s.sessions, { id, title: 'Session', messages: [], isProcessing: false, origin: 'delegation' as const }]).map(se => se.id === id ? {
        ...se, localDraft: snapshot.turns.length ? false : se.localDraft,
        accessRevoked: false, messages: mergeSharedTranscript(se.messages, snapshot), isProcessing: running,
        sharedSnapshot: snapshot, outbound: unconfirmedMessages(se.outbound, se.messages, snapshot),
        isReasoning: last?.reasoning, statusText: running ? status : undefined,
      } : se) }));
      const newFinish = snapshot.turns.some(turn => !turn.active && turn.runId
        && !previous?.turns.some(prior => prior.id === turn.id && prior.runId === turn.runId
          && prior.providerRunId === turn.providerRunId && !prior.active));
      const refreshIdle = !running && (active.get(id) !== false || newFinish
        || retryRefresh.has(id) || !sameSharedHistory(previous, snapshot));
      if ((newFinish && running) || refreshIdle) {
        const generation = generations.get(id) ?? 0;
        const cycle = Symbol();
        refreshCycles.set(id, cycle);
        retryRefresh.delete(id);
        const current = () => client === next && !!next.snapshot(id)
          && (generations.get(id) ?? 0) === generation && refreshCycles.get(id) === cycle;
        const reconcile = Promise.resolve(useChat.getState().reconcileSession(id));
        if (running) {
          void reconcile.then(ok => { if (!ok && current()) retryRefresh.add(id); })
            .catch(() => { if (current()) retryRefresh.add(id); });
        } else {
          // A new active turn also fences idle-only ancillary responses: an
          // older model pin or command projection must not replace its state.
          const idle = () => current() && !next.snapshot(id)?.turns.some(turn => turn.active);
          const commands = reconcile.then(async ok => {
            if (!idle()) return false;
            const history = await next.commands(id);
            if (!idle()) return false;
            useChat.setState(s => ({ sessions: s.sessions.map(se => se.id === id
              ? { ...se, messages: mergeSharedTranscript(se.messages, history) } : se) }));
            return ok;
          }).catch(() => false);
          const pin = getSessionModelPin(id).then(value => {
            if (!idle()) return false;
            useChat.getState().setLlmPin(id, value.runtime_id || undefined);
            return true;
          }).catch(() => false);
          void Promise.all([commands, pin]).then(results => {
            if (current() && results.some(ok => !ok)) retryRefresh.add(id);
          });
        }
      }
      active.set(id, running);
    }
  });
  observe();
  return () => { unsubscribe(); if (client === next) { client = null; useCollaboration.setState({ client: null, people: [] }); } };
}
