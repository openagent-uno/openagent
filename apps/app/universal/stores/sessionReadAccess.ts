/** Fence asynchronous history reads across revocation, regrant and account changes. */
let accountGeneration = 0;
const generations = new Map<string, number>();
const revoked = new Set<string>();
const listeners = new Set<(sessionId: string | null) => void>();

/** Observe access changes: a session id when its access flips, ``null`` when
 * every session's access is reset (account change). Caches derived from
 * session reads (e.g. the turn index) drop their entries here. */
export function onSessionReadAccessChange(listener: (sessionId: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sessionIsRevoked(id: string): boolean { return revoked.has(id); }

export function setSessionRevoked(id: string, value: boolean): void {
  if (revoked.has(id) === value) return;
  generations.set(id, (generations.get(id) ?? 0) + 1);
  if (value) revoked.add(id); else revoked.delete(id);
  for (const listener of listeners) listener(id);
}

export function sessionReadGuard(id: string): () => boolean {
  const account = accountGeneration;
  const generation = generations.get(id) ?? 0;
  const permitted = !revoked.has(id);
  return () => permitted && account === accountGeneration
    && generation === (generations.get(id) ?? 0) && !revoked.has(id);
}

export function resetSessionReadAccess(): void {
  accountGeneration++;
  generations.clear(); revoked.clear();
  for (const listener of listeners) listener(null);
}
