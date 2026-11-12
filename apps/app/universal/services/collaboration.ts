/** One account-bound attachment to the gateway's shared text API.
 * Keep a single instance per connected agent/account. Dispose it on logout.
 * Voice/video and local machine capabilities continue using OpenAgentWS.
 */
import { validSharedSnapshot, validSharedTarget } from '../../common/collaboration';
import type { SharedPerson, SharedSnapshot, SharedTarget, SharedTurnResult } from '../../common/collaboration';
import type { Attachment } from '../../common/types';

export class CollaborationClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private ready = false;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private greeting: ReturnType<typeof setTimeout> | null = null;
  private health: ReturnType<typeof setTimeout> | null = null;
  private heartbeat = false;
  private ping = 0;
  private awaitingPong: number | null = null;
  private settlements = new Map<string, ReturnType<typeof setTimeout>>();
  private completed = new Map<string, { sessionId: string; requestId: string; finishedAt: number; awaitingSnapshot: boolean }>();
  private accessGeneration = 0;
  private retry = 0;
  private sessions: string[] = [];
  private focus: SharedTarget | null = null;
  private states = new Map<string, SharedSnapshot>();
  private people: SharedPerson[] = [];
  // Sessions the server explicitly took away, as opposed to ones whose
  // snapshot is merely absent because the socket dropped or the observation
  // changed. Only the former may discard a transcript a viewer can still see.
  private revokedIds = new Set<string>();
  private disposed = false;
  private listeners = new Set<() => void>();
  onResource: ((frame: { resource: string; action: string; id?: string }) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  constructor(private readonly origin: string, private readonly socketFactory = (url: string) => new WebSocket(url),
    private readonly appConnection?: () => Promise<string | undefined>, readonly sessionFork = false) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(sessionId: string): SharedSnapshot | undefined { return this.states.get(sessionId); }
  presence(): readonly SharedPerson[] { return this.people; }
  /** True when access was withdrawn (or this client was disposed on logout),
   *  false while a snapshot is only temporarily missing. */
  revoked(sessionId: string): boolean { return this.disposed || this.revokedIds.has(sessionId); }

  async commands(sessionId: string): Promise<SharedSnapshot> {
    const response = await fetch(this.origin.replace(/\/$/, '') + '/api/collaboration/' + encodeURIComponent(sessionId) + '/commands');
    if (!response.ok) throw new Error('Command history unavailable');
    const result = await response.json();
    if (!Array.isArray(result.turns) || result.turns.length > 64) throw new Error('Invalid command history');
    // Reuse the bounded live validator on each durable command.
    if (result.turns.some((turn: unknown) => !validSharedSnapshot({ session_id: sessionId, revision: 0, turns: [turn] }))) throw new Error('Invalid command history');
    return { session_id: sessionId, revision: 0, turns: result.turns };
  }

  observe(sessions: string[], focus: SharedTarget | null = null): void {
    if (this.disposed) return;
    if (sessions.length > 16 || sessions.some(id => !validSharedTarget({ kind: 'session', id }))
        || (focus !== null && !validSharedTarget(focus))) throw new Error('Invalid observation');
    this.sessions = [...new Set(sessions)];
    this.focus = focus;
    for (const id of this.states.keys()) if (!this.sessions.includes(id)) this.states.delete(id);
    for (const id of [...this.revokedIds]) if (!this.sessions.includes(id)) this.revokedIds.delete(id);
    for (const [key, receipt] of this.completed) if (!this.sessions.includes(receipt.sessionId)) this.completed.delete(key);
    this.changed();
    if (this.stopped) { this.stopped = false; this.connect(); }
    else this.sendObservation();
  }

  private changed(): void {
    let failed = false;
    for (const listener of this.listeners) {
      try { listener(); } catch { failed = true; }
    }
    if (failed && this.ws) this.retire(this.ws, 'Shared observer listener failed');
  }
  private report(reason: string): void {
    // Diagnostics never include transcript data or a malformed frame's body.
    try { this.onError?.(new Error(reason)); } catch { /* diagnostics cannot block recovery */ }
  }
  private clear(): void { this.states.clear(); this.people = []; this.changed(); }

  private terminalSnapshot(snapshot: SharedSnapshot): SharedSnapshot {
    let changed = false;
    const turns = snapshot.turns.map(turn => {
      const receipt = this.completed.get(JSON.stringify([snapshot.session_id, turn.runId]));
      if (!receipt || !turn.active) return turn;
      changed = true;
      return { ...turn, active: false, finishedAt: receipt.finishedAt, reasoning: false, status: undefined };
    });
    return changed ? { ...snapshot, turns } : snapshot;
  }
  private sendObservation(): void {
    const ws = this.ws;
    if (this.ready && ws?.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'observe', sessions: this.sessions, focus: this.focus })); }
      catch { this.retire(ws, 'Shared observer send failed'); }
    }
  }

  private retire(ws: WebSocket, reason?: string): void {
    if (this.ws !== ws) return;
    // Do not wait for onclose: a half-open transport can stay CLOSING forever.
    this.ws = null;
    this.ready = false;
    if (this.greeting) clearTimeout(this.greeting);
    if (this.health) clearTimeout(this.health);
    this.greeting = this.health = null;
    this.awaitingPong = null;
    this.scheduleReconnect();
    this.clear();
    if (reason) this.report(reason);
    try { ws.close(); } catch { /* the local reader has already been retired */ }
  }

  private armHealth(ws: WebSocket): void {
    if (this.ws !== ws || !this.ready) return;
    if (this.health) clearTimeout(this.health);
    if (!this.heartbeat) {
      // Older gateways only have protocol-level pings, invisible to JS.
      // Renew a silent read attachment; silence never means a run finished.
      this.health = setTimeout(() => this.retire(ws, 'Shared observer silent; refreshing'), 45_000);
      return;
    }
    this.health = setTimeout(() => {
      if (this.ws !== ws) return;
      this.awaitingPong = ++this.ping;
      try { ws.send(JSON.stringify({ type: 'ping', id: this.awaitingPong })); }
      catch { this.retire(ws, 'Shared observer heartbeat send failed'); return; }
      this.health = setTimeout(() => this.retire(ws, 'Shared observer heartbeat timed out'), 10_000);
    }, 15_000);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.origin.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/collaboration';
    let ws: WebSocket;
    try { ws = this.socketFactory(url); }
    catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    this.ready = false;
    this.heartbeat = false;
    this.greeting = setTimeout(() => this.retire(ws, 'Shared observer greeting timed out'), 10_000);
    ws.onmessage = event => {
      if (this.ws !== ws || this.stopped) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) throw new Error('Invalid shared frame');
        const frame = JSON.parse(event.data);
        if (!frame || typeof frame !== 'object') throw new Error('Invalid shared frame');
        if (frame.type === 'auth_ok' && frame.shared === true) {
          if (this.greeting) clearTimeout(this.greeting);
          this.greeting = null;
          this.ready = true;
          this.heartbeat = frame.heartbeat === true;
          this.retry = 0;
          this.sendObservation();
          this.armHealth(ws);
        } else if (frame.type === 'pong' && this.ready) {
          if (this.awaitingPong !== null && frame.id === this.awaitingPong) {
            this.awaitingPong = null;
            this.armHealth(ws);
          }
        } else if (frame.type === 'shared_state' && this.ready) {
          if (!validSharedSnapshot(frame)) throw new Error('Invalid shared snapshot');
          if (!this.sessions.includes(frame.session_id)) return;
          const previous = this.states.get(frame.session_id);
          if (previous && previous.revision >= frame.revision) return;
          for (const receipt of this.completed.values()) if (receipt.sessionId === frame.session_id)
            receipt.awaitingSnapshot = frame.turns.some(turn => turn.runId === receipt.requestId && turn.active);
          this.revokedIds.delete(frame.session_id);
          this.states.set(frame.session_id, this.terminalSnapshot(frame));
          this.changed();
        } else if (frame.type === 'shared_revoked') {
          this.accessGeneration++;
          for (const [key, receipt] of this.completed) if (receipt.sessionId === frame.session_id) this.completed.delete(key);
          this.revokedIds.add(frame.session_id);
          this.states.delete(frame.session_id);
          this.people = this.people.filter(person => !(person.target.kind === 'session' && person.target.id === frame.session_id));
          this.changed();
        } else if (frame.type === 'shared_presence' && this.ready) {
          if (!Array.isArray(frame.people) || frame.people.length > 32 || frame.people.some((person: SharedPerson) =>
            !person || typeof person.userId !== 'string' || person.userId.length > 1024
            || typeof person.name !== 'string' || person.name.length > 1024 || !validSharedTarget(person.target)))
            throw new Error('Invalid shared presence');
          this.people = frame.people;
          this.changed();
        } else if (frame.type === 'resource_event' && this.ready) this.onResource?.(frame);
        else if (frame.type === 'auth_error') {
          this.accessGeneration++;
          this.completed.clear();
          // The device itself lost access: every observed transcript goes.
          for (const id of this.sessions) this.revokedIds.add(id);
          this.retire(ws, 'Shared observer access unavailable');
        }
        if (!this.heartbeat) this.armHealth(ws);
      } catch {
        this.retire(ws, 'Invalid shared observer frame');
      }
    };
    ws.onerror = () => this.retire(ws, 'Shared observer socket failed');
    ws.onclose = () => this.retire(ws);
  }

  private scheduleReconnect(): void {
    if (!this.stopped && !this.reconnect) this.reconnect = setTimeout(() => {
      this.reconnect = null; this.connect();
    }, Math.min(8000, 250 * 2 ** Math.min(this.retry++, 5)));
  }

  async sendTurn(sessionId: string, requestId: string, message: string, delivery: 'queue' | 'steer' = 'queue', signal?: AbortSignal, attachments?: Attachment[], clientInstanceId?: string): Promise<SharedTurnResult> {
    if (this.disposed) throw new Error('Shared client disposed');
    const generation = this.accessGeneration;
    const appConnectionId = await this.appConnection?.();
    if (this.disposed) throw new Error('Shared client disposed');
    const result = await this.post<SharedTurnResult>('/api/collaboration/turns', { session_id: sessionId, request_id: requestId, message, delivery,
      ...(attachments?.length ? { attachments } : {}), ...(clientInstanceId ? { client_instance_id: clientInstanceId } : {}),
      ...(appConnectionId ? { app_connection_id: appConnectionId } : {}),
    }, signal);
    if (!this.disposed && generation === this.accessGeneration
        && result.session_id === sessionId && result.request_id === requestId && this.sessions.includes(sessionId)) {
      // This response is terminal, not an admission ACK. Give the coalesced
      // final snapshot time to arrive, then replace a stale live attachment.
      // Never fabricate tool success or stop a newer/long-running execution.
      const key = JSON.stringify([sessionId, requestId]);
      const snapshot = this.states.get(sessionId);
      if (this.completed.size >= 128) this.completed.delete(this.completed.keys().next().value!);
      this.completed.set(key, { sessionId, requestId, finishedAt: Date.now() / 1000,
        awaitingSnapshot: !snapshot || snapshot.turns.some(turn => turn.runId === requestId && turn.active) });
      if (snapshot) {
        // The HTTP result proves only this exact run is terminal. Stop the
        // old live overlay immediately so canonical results can replace it.
        this.states.set(sessionId, this.terminalSnapshot(snapshot));
        this.changed();
      }
      const previous = this.settlements.get(key);
      if (previous) clearTimeout(previous);
      if (this.settlements.size >= 128) {
        const [oldest, timer] = this.settlements.entries().next().value!;
        clearTimeout(timer); this.settlements.delete(oldest);
      }
      this.settlements.set(key, setTimeout(() => {
        this.settlements.delete(key);
        if (this.disposed || generation !== this.accessGeneration || !this.sessions.includes(sessionId)) return;
        if (this.completed.get(key)?.awaitingSnapshot && this.ws)
          this.retire(this.ws, 'Shared observer missed terminal state; refreshing');
      }, 500));
    }
    return result;
  }

  async stopTurn(sessionId: string, requestId: string, signal?: AbortSignal): Promise<{ stopped: boolean; request_id: string }> {
    return this.post('/api/collaboration/stop', { session_id: sessionId, request_id: requestId }, signal);
  }

  private async post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.origin.replace(/\/$/, '') + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Collaboration ${response.status}: ${result.error || 'Request failed'}`);
    return result;
  }

  dispose(): void {
    this.stopped = true;
    this.disposed = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.greeting) clearTimeout(this.greeting);
    if (this.health) clearTimeout(this.health);
    for (const timer of this.settlements.values()) clearTimeout(timer);
    this.settlements.clear();
    this.completed.clear();
    this.reconnect = this.greeting = this.health = null;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    ws?.close();
    this.clear();
    this.listeners.clear();
  }
}
