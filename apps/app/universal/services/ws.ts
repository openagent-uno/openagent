/**
 * WebSocket client for OpenAgent.
 * Works on all platforms (React Native, Web, Electron).
 */

import type { Attachment, ClientMessage, ServerMessage } from '../../common/types';
import { attachmentsForSend } from '../../common/attachments';
import { isConnectionReplacedClose } from '../../common/websocket-close';
import { CollaborationClient } from './collaboration';
const sharedRequestId = () => globalThis.crypto?.randomUUID?.() || `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export type MessageHandler = (msg: ServerMessage) => void;

/** Why the close handler fired. ``pre_auth`` = drop before the first
 *  ``auth_ok`` of this WS lifetime — the connection store treats it as a
 *  "couldn't connect" failure. ``post_auth`` = transient drop in an
 *  already-authed session (auto-reconnect kicks in). ``retries_exhausted``
 *  = capped retry limit hit; the store should give up and surface the
 *  error to the user. ``replaced`` = a newer transport authenticated with the
 *  same device identity, so this superseded socket must stay closed. */
export type CloseReason = 'pre_auth' | 'post_auth' | 'retries_exhausted' | 'replaced';

export type CloseHandler = (info: {
  reason: CloseReason;
  code: number;
  detail?: string;
}) => void;

export type ErrorHandler = (info: { detail?: string }) => void;

export class OpenAgentWS {
  collaboration: CollaborationClient | null = null;
  private sharedProbe: Promise<CollaborationClient | null> | null = null;
  private sharedClosed = false;
  private sharedDiscovered = false;
  private sharedSessions = new Map<string, Promise<boolean>>();

  enableShared(): Promise<CollaborationClient | null> {
    if (this.sharedProbe) return this.sharedProbe;
    const origin = this.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
    this.sharedProbe = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response: Response;
      try { response = await fetch(origin + '/api/collaboration', { signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (response.status === 404 || response.status === 405) { this.sharedDiscovered = true; return null; }
      if (!response.ok) throw new Error('Could not discover shared sessions');
      const info = await response.json();
      if (info.version !== 1) throw new Error('Unsupported shared session protocol');
      if (this.sharedClosed) return null;
      const shared = new CollaborationClient(origin, undefined, () => this.dashboardConnection());
      shared.onResource = frame => this.handlers.forEach(h => h(frame as ServerMessage));
      this.collaboration = shared;
      this.sharedDiscovered = true;
      return shared;
    })();
    return this.sharedProbe;
  }

  /** Resolves true only for the client that actually created the session. A
   *  session that already exists carries whatever prelude it was opened with;
   *  re-sending ours would duplicate it after every reconnect, and would let a
   *  second participant prepend their own system text to a shared history. */
  private async ensureSharedSession(sessionId: string, title: string): Promise<boolean> {
    let pending = this.sharedSessions.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const origin = this.url.replace(/^ws/, 'http').replace(/\/ws$/, '');
        const path = '/api/sessions/' + encodeURIComponent(sessionId);
        const response = await fetch(origin + path);
        let missing = response.status === 404;
        if (response.status === 405) {
          // Collaboration shipped one release before GET metadata. Those
          // gateways can still list and PATCH sessions, so distinguish an
          // existing chat from a new app-created id without renaming the
          // former to its next message text.
          const listed = await fetch(origin + '/api/sessions?limit=200');
          if (!listed.ok) throw new Error('Session unavailable');
          const body = await listed.json();
          const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
          const exists = sessions.some((item: unknown) => {
            if (!item || typeof item !== 'object') return false;
            const row = item as { id?: unknown; session_id?: unknown };
            return row.id === sessionId || row.session_id === sessionId;
          });
          if (exists) return false;
          missing = true;
        }
        if (missing) {
          const created = await fetch(origin + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title.slice(0, 70) || 'Chat' }) });
          if (!created.ok) throw new Error('Could not create shared session');
          return true;
        }
        if (!response.ok) throw new Error('Session unavailable');
        return false;
      })();
      this.sharedSessions.set(sessionId, pending);
      pending.catch(() => this.sharedSessions.delete(sessionId));
    }
    return pending;
  }

  async sendSharedCommand(sessionId: string, command: string): Promise<void> {
    const shared = await this.enableShared();
    if (!shared) throw new Error('Shared sessions are unavailable');
    await this.ensureSharedSession(sessionId, 'Chat');
    const result = await shared.sendTurn(sessionId, sharedRequestId(), command);
    if (result.errored) throw new Error(result.response);
    this.handlers.forEach(h => h({ type: 'command_result', text: result.response, session_id: sessionId } as ServerMessage));
  }

  private sharedError(sessionId: string, error: unknown): void {
    this.handlers.forEach(h => h({ type: 'error', session_id: sessionId,
      text: error instanceof Error ? error.message : 'Shared turn failed' }));
  }
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private clientInstanceId: string;
  private appConnectionId: string | undefined;
  private appRegistration: Promise<string | undefined> = Promise.resolve(undefined);
  private appRegistrationComplete: ((id: string | undefined) => void) | undefined;
  private appRegistrationTimer: ReturnType<typeof setTimeout> | undefined;

  private dashboardConnection(): Promise<string | undefined> { return this.appRegistration; }
  private offerAppCapabilities(): void {
    this.clearAppRegistration();
    this.appRegistration = new Promise(resolve => { this.appRegistrationComplete = resolve; });
    // Old standalone servers can continue to serve chat during transition.
    this.appRegistrationTimer = setTimeout(() => this.clearAppRegistration(), 5000);
    this.send({ type: 'app_capability_register', product: 'openagent-app', dashboard_tools: 1 });
  }
  private clearAppRegistration(): void {
    if (this.appRegistrationTimer) clearTimeout(this.appRegistrationTimer);
    this.appRegistrationTimer = undefined;
    this.appConnectionId = undefined;
    this.appRegistrationComplete?.(undefined);
    this.appRegistrationComplete = undefined;
    this.appRegistration = Promise.resolve(undefined);
  }
  private handleAppRegistration(message: ServerMessage): void {
    if (message.type === 'app_capability_registered' && message.dashboard_tools === 1 && message.connection_id) {
      if (this.appRegistrationTimer) clearTimeout(this.appRegistrationTimer);
      this.appRegistrationTimer = undefined;
      this.appConnectionId = message.connection_id;
      this.appRegistrationComplete?.(message.connection_id);
      this.appRegistrationComplete = undefined;
      this.appRegistration = Promise.resolve(message.connection_id);
    } else if (message.type === 'app_capability_error') this.clearAppRegistration();
  }
  private handlers: Set<MessageHandler> = new Set();
  private closeHandlers: Set<CloseHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private openedSessions: Set<string> = new Set();
  private pendingOut: string[] = [];
  private static MAX_PENDING = 200;
  private authed = false;
  private everAuthed = false;
  private reconnectAttempts = 0;
  private static MAX_PRE_AUTH_RECONNECT = 3;
  /** Post-auth reconnects get more budget than pre-auth (the session was
   *  already live), but not unlimited — a dead loopback must eventually
   *  surface so the store can restart it rather than looping forever.
   *
   *  The budget has to outlast the commonest reason a live session drops:
   *  the agent restarting. An auto-update or a deploy takes it away for a
   *  minute or more (MCP servers, indices, model catalogue), and giving up
   *  inside that window would end every routine restart with a password
   *  prompt — a worse outcome than the stuck spinner this cap exists to
   *  prevent. Twelve attempts on the backoff below spans ~3 minutes. */
  private static MAX_POST_AUTH_RECONNECT = 12;

  /** Retry delay for attempt ``n`` (0-based): quick at first, because most
   *  drops are a blip, then easing off so a long outage isn't hammered. */
  private static backoffMs(attempt: number): number {
    const ladder = [3_000, 3_000, 5_000, 8_000, 13_000, 21_000];
    return ladder[Math.min(attempt, ladder.length - 1)] ?? 30_000;
  }
  private _transport: any = null; // IpcWebSocket in Electron child windows

  constructor(url: string, token?: string, clientInstanceId?: string) {
    this.url = url;
    this.token = token ?? '';
    this.clientInstanceId = clientInstanceId ?? '';
  }

  setTransport(transport: any): void {
    this._transport = transport;
  }

  connect(): void {
    if (this._transport) {
      this.connectViaTransport();
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] connected, sending auth...');
      // Fresh WS → this transport has not announced any stream sessions yet.
      // Drop the local cache so the next sendMessage re-sends session_open
      // and lets the server rebind to any still-running StreamSession.
      this.openedSessions.clear();
      this.authed = false;
      // Auth is the only frame the server accepts pre-auth; everything
      // else has to wait for ``auth_ok`` before draining.
      this.ws?.send(JSON.stringify({
        type: 'auth',
        token: this.token,
        client_kind: this.clientInstanceId ? 'desktop' : 'webapp',
        ...(this.clientInstanceId ? { client_instance_id: this.clientInstanceId } : {}),
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        // Server confirmed auth — release any messages typed while we
        // were CONNECTING or in the reconnect window.
        if ((msg as { type?: string }).type === 'auth_ok' && !this.authed) {
          this.authed = true;
          this.everAuthed = true;
          this.reconnectAttempts = 0;
          this.offerAppCapabilities();
          this.flushPending();
        }
        this.handleAppRegistration(msg);
        this.handlers.forEach((h) => h(msg));
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] closed: code=${event.code} reason=${event.reason}`);
      this.openedSessions.clear();
      this.authed = false;
      this.clearAppRegistration();

      // A fresh connection carrying this device certificate has already
      // taken over on the gateway.  Reconnecting this old socket would evict
      // the fresh one; the two instances would then replace each other every
      // backoff interval forever.  Stop only this superseded OpenAgentWS.
      // All normal/abnormal transport closes continue through the existing
      // bounded reconnect policy below.
      if (isConnectionReplacedClose(event.code, event.reason)) {
        this.shouldReconnect = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.pendingOut = [];
        this.notifyClose({
          reason: 'replaced',
          code: event.code,
          detail: event.reason || undefined,
        });
        return;
      }

      // Pre-auth drop on the first connect attempt → surface to the
      // store immediately (prevents the indefinite-loading bug). We
      // still try a few reconnects in case the proxy is racing with us,
      // but cap them so a doomed dial doesn't loop forever. Post-auth
      // drops keep the existing gentle 3 s reconnect — those are
      // network blips during a working session.
      if (!this.everAuthed) {
        const giveUp = this.reconnectAttempts >= OpenAgentWS.MAX_PRE_AUTH_RECONNECT;
        this.notifyClose({
          reason: giveUp ? 'retries_exhausted' : 'pre_auth',
          code: event.code,
          detail: event.reason || undefined,
        });
        if (this.shouldReconnect && !giveUp) {
          this.reconnectAttempts += 1;
          this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        }
        return;
      }

      // Already-authed session — try reconnects with a cap. A dead
      // loopback (iroh transport gone while the proxy port is still
      // bound) would otherwise loop forever: TCP connect to localhost
      // succeeds, auth times out after 15 s, onclose fires again.
      //
      // The retry must NOT be conditional on this particular socket having
      // reached ``auth_ok``. A dead tunnel's signature is precisely the
      // opposite: the socket opens (the proxy port is still bound), the auth
      // frame goes nowhere, and the close arrives un-authed. Gating on that
      // meant the very first drop scheduled no retry AND counted no attempt,
      // so ``retries_exhausted`` — the state that stops the dead loopback and
      // asks the user to reconnect — was unreachable. The session stayed on
      // "Reconnecting…" forever while every REST call failed. ``disconnect()``
      // is what stops the loop deliberately, via ``shouldReconnect``.
      const postAuthGiveUp = this.reconnectAttempts >= OpenAgentWS.MAX_POST_AUTH_RECONNECT;
      this.notifyClose({
        reason: postAuthGiveUp ? 'retries_exhausted' : 'post_auth',
        code: event.code,
        detail: event.reason || undefined,
      });
      if (this.shouldReconnect && !postAuthGiveUp) {
        const delay = OpenAgentWS.backoffMs(this.reconnectAttempts);
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onerror = (event) => {
      console.error('[WS] error:', event);
      // The native WS error event has no useful diagnostic; surface a
      // best-effort detail and let onclose carry the reason classifier.
      const detail =
        (event as Event & { message?: string }).message ?? undefined;
      this.notifyError({ detail });
      this.ws?.close();
    };
  }

  /** IPC transport path — Electron child windows relay through the primary window's WS. */
  private connectViaTransport(): void {
    const t = this._transport as any;

    t.onopen = () => {
      this.openedSessions.clear();
      this.authed = true;
      this.everAuthed = true;
      this.reconnectAttempts = 0;
      this.offerAppCapabilities();
      this.flushPending();
      queueMicrotask(() => {
        this.handlers.forEach((h) => h({ type: 'auth_ok' as const } as any));
      });
    };

    t.onmessage = (event: { data: string }) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        if ((msg as { type?: string }).type === 'auth_ok' && !this.authed) {
          this.authed = true;
          this.everAuthed = true;
          this.reconnectAttempts = 0;
          this.offerAppCapabilities();
          this.flushPending();
        }
        this.handleAppRegistration(msg);
        this.handlers.forEach((h) => h(msg));
      } catch { /* ignore */ }
    };

    t.onclose = (info: { code: number; reason: string }) => {
      this.openedSessions.clear();
      this.authed = false;
      this.clearAppRegistration();
      if (isConnectionReplacedClose(info.code, info.reason)) {
        this.shouldReconnect = false;
        this.pendingOut = [];
        this.notifyClose({
          reason: 'replaced',
          code: info.code,
          detail: info.reason || undefined,
        });
        return;
      }
      this.notifyClose({
        reason: this.everAuthed ? 'post_auth' : 'pre_auth',
        code: info.code,
        detail: info.reason,
      });
    };

    (this as any).ws = t;
    t.init();
  }

  /** Send a raw payload through the underlying transport (used by the
   *  primary window to relay child messages to its real WebSocket). */
  sendRaw(payload: string): void {
    const rawWs = this.ws ?? this._transport;
    if (rawWs && (rawWs as any).readyState === 1 && this.authed) {
      (rawWs as any).send(payload);
      return;
    }
    if (this.pendingOut.length >= OpenAgentWS.MAX_PENDING) {
      this.pendingOut.shift();
    }
    this.pendingOut.push(payload);
  }

  /** Subscribe to close events (pre-auth, post-auth, retries-exhausted). */
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Subscribe to low-level error events (rare; usually paired with onclose). */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  private notifyClose(info: { reason: CloseReason; code: number; detail?: string }): void {
    this.closeHandlers.forEach((h) => {
      try { h(info); } catch { /* ignore handler errors */ }
    });
  }

  private notifyError(info: { detail?: string }): void {
    this.errorHandlers.forEach((h) => {
      try { h(info); } catch { /* ignore handler errors */ }
    });
  }

  disconnect(): void {
    this.clearAppRegistration();
    this.sharedClosed = true;
    this.collaboration?.dispose();
    this.collaboration = null;
    this.sharedSessions.clear();
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.openedSessions.clear();
    this.pendingOut = [];
    this.authed = false;
    this.everAuthed = false;
    this.reconnectAttempts = 0;
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMessage): void {
    const payload = JSON.stringify(msg);
    // Auth gate: server rejects any non-auth frame before ``auth_ok``,
    // so even on an OPEN socket we queue until handshake completes.
    if (this.ws?.readyState === WebSocket.OPEN && this.authed) {
      this.ws.send(payload);
      return;
    }
    if (this.pendingOut.length >= OpenAgentWS.MAX_PENDING) {
      // Pathological case — drop oldest to keep memory bounded. The
      // user's most recent intent is more useful than the stalest one.
      this.pendingOut.shift();
    }
    this.pendingOut.push(payload);
  }

  private flushPending(): void {
    if (!this.pendingOut.length) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const queue = this.pendingOut;
    this.pendingOut = [];
    for (const payload of queue) ws.send(payload);
  }

  /** Send a typed user message into the user's stream session.
   *
   * Lazily opens a ``batched``-profile stream session on the first
   * call for a given ``sessionId`` (with ``speak: false`` by default
   * so chat-tab typed messages don't trigger TTS), then pushes a
   * ``text_final`` frame. The legacy ``message`` wire frame is no
   * longer used — every message flows through ``StreamSession``, the
   * same primitive voice mode uses.
   *
   * ``options.source`` should be ``"stt"`` for transcribed voice
   * notes (mirrors the bridge convention) — the stream session's
   * STT-bypass kicks in (instant barge-in) AND the mirror-modality
   * rule re-enables TTS for the reply even when the session was
   * opened with ``speak: false``.
   */
  sendMessage(
    text: string,
    sessionId: string,
    options?: {
      source?: 'user_typed' | 'stt' | 'system';
      llmPin?: string;
      systemPrompt?: string;
      attachments?: Attachment[];
    },
  ): void {
    if (!this.sharedDiscovered && (!options?.source || options.source === 'user_typed')) {
      void this.enableShared().then(() => {
        if (!this.sharedClosed) this.sendMessage(text, sessionId, options);
      }).catch(error => this.sharedError(sessionId, error));
      return;
    }
    if (this.collaboration && (!options?.source || options.source === 'user_typed')) {
      const shared = this.collaboration;
      const requestId = sharedRequestId();
      void this.ensureSharedSession(sessionId, text).then(async (opened) => {
        if (this.sharedClosed) return;
        if (options?.systemPrompt && opened) {
          await shared.sendTurn(sessionId, sharedRequestId(), `[system] ${options.systemPrompt}`);
        }
        await shared.sendTurn(sessionId, requestId, text, 'steer', undefined,
          attachmentsForSend(options?.attachments || []), this.clientInstanceId || undefined);
      }).catch(error => this.sharedError(sessionId, error));
      return;
    }
    if (!this.openedSessions.has(sessionId)) {
      this.sendSessionOpen(sessionId, {
        profile: 'batched',
        clientKind: 'webapp-chat',
        // Chat-tab sessions stay silent on typed-text replies. Voice
        // notes (source="stt") still get spoken replies via the
        // mirror-modality rule on the server side.
        speak: false,
        llmPin: options?.llmPin,
      });
      // Push the system prompt as the first user-tagged frame so the
      // gateway lands it in the session prelude. The gateway has no
      // first-class ``system_prompt`` field today; this is the
      // simplest hand-off that survives reconnect.
      if (options?.systemPrompt) {
        this.sendTextFinal(
          sessionId,
          `[system] ${options.systemPrompt}`,
          { source: 'system' },
        );
      }
    }
    this.sendTextFinal(sessionId, text, {
      source: options?.source ?? 'user_typed',
      attachments: options?.attachments,
    });
  }

  sendCommand(
    // The gateway's registry (`/api/commands`) is the authority on which
    // commands exist, and the composer now builds its menu from it — so a
    // command the server grows must be sendable without editing a union
    // here. `string & {}` keeps autocomplete for the names we do know
    // while accepting any the registry hands us.
    name: (ClientMessage & { type: 'command' } extends { name: infer N } ? N : never) | (string & {}),
    sessionId?: string,
    arg?: string,
  ): void {
    if (this.collaboration && sessionId && ['compact', 'model', 'context', 'status', 'queue', 'help', 'usage', 'stop'].includes(name)) {
      void this.sendSharedCommand(sessionId, '/' + name + (arg ? ' ' + arg : '')).catch(error => this.sharedError(sessionId, error));
      return;
    }
    // Scope scope-sensitive commands (stop/new/clear/reset/compact/model)
    // to the specific chat tab so other tabs stay intact. Pass `undefined`
    // for global admin commands (help/usage/update/restart).
    const payload: any = { type: 'command', name };
    if (sessionId !== undefined) payload.session_id = sessionId;
    if (arg !== undefined) payload.arg = arg;
    this.send(payload);
  }

  // ── Stream protocol helpers (audio/video bytes go base64 on the wire) ─

  /** Open a long-lived stream session. Idempotent within one WS
   *  lifetime; on reconnect the cache is wiped and the next caller
   *  re-sends ``session_open``. */
  sendSessionOpen(
    sessionId: string,
    options?: {
      profile?: 'realtime' | 'batched';
      llmPin?: string;
      sttPin?: string;
      ttsPin?: string;
      language?: string;
      clientKind?: string;
      coalesceWindowMs?: number;
      // Default true (matches voice-mode UX). Set to ``false`` for
      // chat-style sessions where typed replies should stay silent
      // even when a TTS provider is configured.
      speak?: boolean;
    },
  ): void {
    if (this.openedSessions.has(sessionId)) return;
    const profile = options?.profile ?? 'realtime';
    const speak = options?.speak ?? true;
    this.send({
      type: 'session_open',
      session_id: sessionId,
      profile,
      llm_pin: options?.llmPin,
      stt_pin: options?.sttPin,
      tts_pin: options?.ttsPin,
      language: options?.language,
      client_kind: options?.clientKind,
      client_instance_id: this.clientInstanceId || undefined,
      coalesce_window_ms: options?.coalesceWindowMs,
      speak,
      client_capabilities: {
        attachments: true,
        ordered_parts: true,
        inline_ui: true,
        sidebar_ui: true,
        custom_ui_version: 1,
        // App-owned capability registration, separate from local computer
        // access consent and scoped by the server to this authenticated socket.
        dashboard_tools: 1,
      },
    });
    this.openedSessions.add(sessionId);
  }

  /** Close a previously-opened stream session. */
  sendSessionClose(sessionId: string): void {
    this.send({ type: 'session_close', session_id: sessionId });
    this.openedSessions.delete(sessionId);
  }

  /** Push one audio chunk into a realtime session. */
  sendAudioChunkIn(
    sessionId: string,
    base64: string,
    options?: { endOfSpeech?: boolean; sampleRate?: number; encoding?: string },
  ): void {
    this.send({
      type: 'audio_chunk_in',
      session_id: sessionId,
      data: base64,
      end_of_speech: options?.endOfSpeech,
      sample_rate: options?.sampleRate,
      encoding: options?.encoding,
    });
  }

  /** Mark end-of-speech without sending a final audio chunk. */
  sendAudioEndIn(sessionId: string): void {
    this.send({ type: 'audio_end_in', session_id: sessionId });
  }

  /** Push one video frame into a realtime session. */
  sendVideoFrame(
    sessionId: string,
    stream: string,
    base64: string,
    options?: { width?: number; height?: number; keyframe?: boolean },
  ): void {
    this.send({
      type: 'video_frame',
      session_id: sessionId,
      stream,
      data: base64,
      width: options?.width,
      height: options?.height,
      keyframe: options?.keyframe,
    });
  }

  /** Commit a typed user message into a realtime session (alternative
   * to the legacy ``message`` frame for stream-aware clients). */
  sendTextFinal(
    sessionId: string,
    text: string,
    options?: {
      source?: 'user_typed' | 'stt' | 'system';
      attachments?: Attachment[];
    },
  ): void {
    // Structured attachments — server decodes via wire.py:TextFinal and
    // forwards to Agent.run_stream(attachments=...), which routes
    // non-image files via the agent's native files= parameter (no
    // string injection into the user prompt).
    const attachments = attachmentsForSend(options?.attachments);
    this.send({
      type: 'text_final',
      session_id: sessionId,
      text,
      source: options?.source ?? 'user_typed',
      ...(attachments
        ? { attachments }
        : {}),
    });
  }

  /** Stream a partial typed text delta (ghost-text preview UI). */
  sendTextDelta(sessionId: string, text: string, final = false): void {
    this.send({
      type: 'text_delta',
      session_id: sessionId,
      text,
      final,
    });
  }

  /** Trigger barge-in. Cancels the active assistant turn (if any). */
  sendInterrupt(
    sessionId: string,
    reason: 'user_speech' | 'user_text' | 'manual' = 'manual',
  ): void {
    const turn = this.collaboration?.snapshot(sessionId)?.turns.findLast(t => t.active);
    if (this.collaboration && turn?.runId) {
      void this.collaboration.stopTurn(sessionId, turn.runId).catch(error => this.sharedError(sessionId, error));
      return;
    }
    this.send({ type: 'interrupt', session_id: sessionId, reason });
  }

  // ── OA-UI v1 subscriptions ───────────────────────────────────────

  subscribeUIView(
    subscriptionId: string,
    viewId: string,
    options: { revision?: number; knownRevision?: number } = {},
  ): void {
    this.send({
      type: 'ui_subscribe',
      subscriptionId,
      viewId,
      ...(options.revision != null ? { revision: options.revision } : {}),
      ...(options.knownRevision != null ? { knownRevision: options.knownRevision } : {}),
    });
  }

  unsubscribeUIView(subscriptionId: string): void {
    this.send({ type: 'ui_unsubscribe', subscriptionId });
  }

  sendUIViewAction(
    subscriptionId: string,
    actionId: string,
    input: unknown,
    idempotencyKey: string,
  ): void {
    this.send({
      type: 'ui_action',
      subscriptionId,
      actionId,
      ...(input !== undefined ? { input } : {}),
      idempotencyKey,
    });
  }

  // ── Interactive terminals (PTY on the gateway host) ──

  /** Open a new PTY terminal of the given geometry. The gateway replies
   *  with ``terminal_ready`` then streams ``terminal_output``. */
  sendTerminalOpen(
    terminalId: string,
    opts: { cols: number; rows: number; cwd?: string; shell?: string },
  ): void {
    this.send({
      type: 'terminal_open',
      terminal_id: terminalId,
      cols: opts.cols,
      rows: opts.rows,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.shell ? { shell: opts.shell } : {}),
    });
  }

  /** Feed keystrokes to a terminal. ``dataBase64`` is base64-encoded
   *  raw bytes (UTF-8 for normal input). */
  sendTerminalInput(terminalId: string, dataBase64: string): void {
    this.send({ type: 'terminal_input', terminal_id: terminalId, data: dataBase64 });
  }

  /** Reflow a terminal after a window/pane resize. */
  sendTerminalResize(terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_resize', terminal_id: terminalId, cols, rows });
  }

  /** Deliver a signal (e.g. Ctrl-C → INT) to a terminal's foreground job. */
  sendTerminalSignal(
    terminalId: string,
    signal: 'INT' | 'TERM' | 'HUP' | 'QUIT' | 'KILL' = 'INT',
  ): void {
    this.send({ type: 'terminal_signal', terminal_id: terminalId, signal });
  }

  /** Close a terminal (kills the shell on the host). */
  sendTerminalClose(terminalId: string): void {
    this.send({ type: 'terminal_close', terminal_id: terminalId });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
