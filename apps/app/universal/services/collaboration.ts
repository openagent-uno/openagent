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
    private readonly appConnection?: () => Promise<string | undefined>) {}

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
    if (sessions.length > 16 || sessions.some(id => !validSharedTarget({ kind: 'session', id }))
        || (focus !== null && !validSharedTarget(focus))) throw new Error('Invalid observation');
    this.sessions = [...new Set(sessions)];
    this.focus = focus;
    for (const id of this.states.keys()) if (!this.sessions.includes(id)) this.states.delete(id);
    for (const id of [...this.revokedIds]) if (!this.sessions.includes(id)) this.revokedIds.delete(id);
    this.changed();
    if (this.stopped) { this.stopped = false; this.connect(); }
    else this.sendObservation();
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
  private clear(): void { this.states.clear(); this.people = []; this.changed(); }
  private sendObservation(): void {
    if (this.ready && this.ws?.readyState === 1)
      this.ws.send(JSON.stringify({ type: 'observe', sessions: this.sessions, focus: this.focus }));
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.origin.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/collaboration';
    let ws: WebSocket;
    try { ws = this.socketFactory(url); }
    catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    this.ready = false;
    this.greeting = setTimeout(() => { if (this.ws === ws) ws.close(); }, 10_000);
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
          this.retry = 0;
          this.sendObservation();
        } else if (frame.type === 'shared_state' && this.ready) {
          if (!validSharedSnapshot(frame)) throw new Error('Invalid shared snapshot');
          if (!this.sessions.includes(frame.session_id)) return;
          const previous = this.states.get(frame.session_id);
          if (previous && previous.revision >= frame.revision) return;
          this.revokedIds.delete(frame.session_id);
          this.states.set(frame.session_id, frame);
          this.changed();
        } else if (frame.type === 'shared_revoked') {
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
          // The device itself lost access: every observed transcript goes.
          for (const id of this.sessions) this.revokedIds.add(id);
          this.clear();
          ws.close();
        }
      } catch (error) {
        this.onError?.(error instanceof Error ? error : new Error('Invalid shared frame'));
        this.clear();
        ws.close();
      }
    };
    ws.onerror = () => { if (this.ws === ws) ws.close(); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.greeting) clearTimeout(this.greeting);
      this.greeting = null;
      this.ws = null;
      this.ready = false;
      this.clear();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.stopped) this.reconnect = setTimeout(() => {
      this.reconnect = null; this.connect();
    }, Math.min(8000, 250 * 2 ** Math.min(this.retry++, 5)));
  }

  async sendTurn(sessionId: string, requestId: string, message: string, delivery: 'queue' | 'steer' = 'queue', signal?: AbortSignal, attachments?: Attachment[], clientInstanceId?: string): Promise<SharedTurnResult> {
    const appConnectionId = await this.appConnection?.();
    return this.post('/api/collaboration/turns', { session_id: sessionId, request_id: requestId, message, delivery,
      ...(attachments?.length ? { attachments } : {}), ...(clientInstanceId ? { client_instance_id: clientInstanceId } : {}),
      ...(appConnectionId ? { app_connection_id: appConnectionId } : {}),
    }, signal);
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
    this.reconnect = this.greeting = null;
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    ws?.close();
    this.clear();
    this.listeners.clear();
  }
}
