import WebSocket, { type RawData } from 'ws';
import { createHash } from 'crypto';
import {
  CAPABILITY_PROTOCOL,
  CapabilityProtocolError,
  encodeCapabilityFrame,
  normalizeToolResult,
  parseCapabilityServerFrame,
  protocolError,
  type ClientCapabilityServer,
  type ClientToolCall,
} from './protocol';

const CONNECT_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ARTIFACT_THRESHOLD_BYTES = 256 * 1024;
const ARTIFACT_CHUNK_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES_PER_CALL = 64 * 1024 * 1024;
const MAX_ARTIFACT_TRANSFERS_PER_CALL = 64;
const MAX_PENDING_TOOL_EVENTS = 1_024;
const MAX_ACTIVE_TOOL_CALLS = 32;
const SOCKET_BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const SOCKET_SEND_STALL_MS = 30_000;
const SOCKET_BUFFER_POLL_MS = 10;

type CapabilityClientFrame = Parameters<typeof encodeCapabilityFrame>[0];

export type CapabilityConnectionPhase =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'error';

export interface CapabilityOffer {
  generation: number;
  servers: ClientCapabilityServer[];
}

export interface CapabilitySocketOptions {
  accountId: string;
  /** Coordinator-certified network id bound to this local Iroh loopback. */
  trustedAccountId: string;
  /** Device public key bound into the same coordinator certificate. */
  trustedDeviceId: string;
  url: string;
  clientInstanceId: string;
  deviceLabel: string;
  getOffer: () => CapabilityOffer;
  invoke: (call: ClientToolCall, signal: AbortSignal) => Promise<unknown>;
  onPhase?: (phase: CapabilityConnectionPhase, error?: string) => void;
  onActivity?: (activeCalls: number) => void;
  reconnect?: boolean;
  /** Test/diagnostic override; production uses the protocol heartbeat. */
  heartbeatMs?: number;
}

/**
 * One authenticated capability channel over an account's existing Iroh
 * loopback. The client never invents retries or moves work to another host;
 * the Gateway may resend a read-only/idempotent call with the same call id
 * after this exact instance reconnects in the same generation.
 */
export class CapabilitySocket {
  private socket: WebSocket | null = null;
  private stopped = true;
  private acknowledged = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private active = new Map<string, AbortController>();
  private pendingEvents = new Map<string, Record<string, unknown>>();
  private eventFlush: Promise<void> | null = null;
  private heartbeatPending = false;
  private outboundTail: Promise<void> = Promise.resolve();
  private outboundEpoch = 0;

  constructor(private readonly options: CapabilitySocketOptions) {}

  get isAcknowledged(): boolean {
    return this.acknowledged;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(reason = 'Capability channel stopped'): void {
    this.stopped = true;
    this.acknowledged = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connectTimer = null;
    this.abortAll(reason);
    this.pendingEvents.clear();
    this.eventFlush = null;
    this.heartbeatPending = false;
    this.outboundEpoch += 1;
    this.outboundTail = Promise.resolve();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, reason.slice(0, 120));
    }
    this.options.onPhase?.('stopped');
  }

  updateCatalog(): void {
    if (!this.acknowledged) return;
    const offer = this.options.getOffer();
    this.sendDetached({
      type: 'capability_catalog_update',
      generation: offer.generation,
      servers: offer.servers,
    });
  }

  /** Forward a broker event only on this exact registered capability socket. */
  sendToolEvent(event: Record<string, unknown>): boolean {
    const key = toolEventKey(event);
    if (!key) return false;
    this.pendingEvents.set(key, { ...event });
    while (this.pendingEvents.size > MAX_PENDING_TOOL_EVENTS) {
      const oldest = this.pendingEvents.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.pendingEvents.delete(oldest);
    }
    this.flushToolEvents();
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.onPhase?.('connecting');
    const socket = new WebSocket(this.options.url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }, CONNECT_TIMEOUT_MS);

    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.acknowledged = false;
      const offer = this.options.getOffer();
      this.outboundEpoch += 1;
      this.outboundTail = Promise.resolve();
      this.sendDetached({
        type: 'capability_hello',
        protocol: CAPABILITY_PROTOCOL,
        client_instance_id: this.options.clientInstanceId,
        generation: offer.generation,
        device_label: this.options.deviceLabel,
        network_id: this.options.trustedAccountId,
        servers: offer.servers,
      });
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (this.socket !== socket || this.stopped) return;
      if (isBinary) {
        this.options.onPhase?.('error', 'Capability server sent an unexpected binary frame');
        return;
      }
      void this.handleMessage(data.toString()).catch((error) => this.handleOutboundFailure(error));
    });

    socket.on('error', (error) => {
      if (this.socket === socket && !this.stopped) {
        this.options.onPhase?.('error', error.message);
      }
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.outboundEpoch += 1;
      this.outboundTail = Promise.resolve();
      this.eventFlush = null;
      this.heartbeatPending = false;
      this.acknowledged = false;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.connectTimer = null;
      this.heartbeatTimer = null;
      this.abortAll('Capability channel disconnected');
      if (this.stopped) return;
      this.options.onPhase?.('error', 'Capability channel disconnected');
      if (this.options.reconnect === false) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let frame;
    try {
      frame = parseCapabilityServerFrame(raw);
    } catch (error) {
      this.options.onPhase?.('error', error instanceof Error ? error.message : String(error));
      return;
    }

    switch (frame.type) {
      case 'capability_hello_ack': {
        const offer = this.options.getOffer();
        if (
          frame.protocol !== CAPABILITY_PROTOCOL ||
          frame.device_id !== this.options.trustedDeviceId ||
          frame.account_id !== this.options.trustedAccountId ||
          (frame.network_id !== undefined &&
            frame.network_id !== this.options.trustedAccountId) ||
          frame.client_instance_id !== this.options.clientInstanceId ||
          frame.generation !== offer.generation ||
          !frame.accepted
        ) {
          this.options.onPhase?.('error', frame.reason || 'Capability registration was rejected');
          this.socket?.close(1008, 'Capability registration rejected');
          return;
        }
        this.acknowledged = true;
        this.reconnectAttempt = 0;
        this.options.onPhase?.('connected');
        this.flushToolEvents();
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          const current = this.options.getOffer();
          if (!this.heartbeatPending) {
            this.heartbeatPending = true;
            void this.send({
              type: 'capability_heartbeat',
              generation: current.generation,
              ts_ms: Date.now(),
            }).catch((error) => this.handleOutboundFailure(error)).finally(() => {
              this.heartbeatPending = false;
            });
          }
          // At-least-once delivery: an ACK can be lost while the WebSocket
          // remains open. Server-side shell correlation is idempotent.
          this.flushToolEvents();
        }, this.options.heartbeatMs ?? HEARTBEAT_MS);
        return;
      }
      case 'capability_heartbeat_ack':
        return;
      case 'client_tool_event_ack':
        if (
          frame.generation === this.options.getOffer().generation &&
          typeof frame.shell_id === 'string' &&
          frame.accepted === true
        ) {
          this.pendingEvents.delete(`shell_completed:${frame.shell_id}`);
        }
        return;
      case 'client_tool_cancel': {
        if (frame.generation !== this.options.getOffer().generation) return;
        this.active.get(frame.call_id)?.abort(frame.reason || 'Cancelled by server');
        return;
      }
      case 'client_tool_call':
        await this.handleToolCall(frame);
        return;
    }
  }

  private async handleToolCall(call: ClientToolCall): Promise<void> {
    if (!this.acknowledged) {
      await this.sendError(call, new CapabilityProtocolError('not_registered', 'Capability host is not registered'));
      return;
    }
    const offer = this.options.getOffer();
    const toolManifest = offer.servers
      .find((server) => server.name === call.server)
      ?.tools.find((tool) => tool.name === call.tool);
    const classification = classificationForArguments(toolManifest, call.args);
    const mutating = classification !== 'read_only' && classification !== 'idempotent';
    // account_id is supplied by the certified Gateway, but it is never used
    // to choose a local account or principal. The socket was already bound to
    // a loopback; this is only a confused-deputy/misrouting check.
    if (call.account_id !== this.options.trustedAccountId) {
      await this.sendError(call, new CapabilityProtocolError(
        'account_mismatch',
        'Capability call account does not match this certified loopback',
      ));
      this.socket?.close(1008, 'Capability account mismatch');
      return;
    }
    if (call.generation !== offer.generation) {
      await this.sendError(call, new CapabilityProtocolError(
        'stale_generation',
        `Call generation ${call.generation} does not match ${offer.generation}`,
      ));
      return;
    }
    if (this.active.has(call.call_id)) {
      await this.sendError(call, new CapabilityProtocolError('duplicate_call', `Duplicate call_id ${call.call_id}`));
      return;
    }
    if (this.active.size >= MAX_ACTIVE_TOOL_CALLS) {
      await this.sendError(call, new CapabilityProtocolError(
        'client_backpressure',
        `This client already has ${MAX_ACTIVE_TOOL_CALLS} active local tool calls`,
      ));
      return;
    }

    const controller = new AbortController();
    this.active.set(call.call_id, controller);
    this.options.onActivity?.(this.active.size);
    const timeoutMs = localDeadline(call.deadline_ms);
    const timer = timeoutMs == null ? null : setTimeout(() => {
      controller.abort('Client tool deadline elapsed');
    }, timeoutMs);
    try {
      const result = await this.options.invoke(call, controller.signal);
      if (controller.signal.aborted) {
        throw new CapabilityProtocolError('cancelled', String(controller.signal.reason || 'Cancelled'));
      }
      const prepared = prepareToolResultArtifacts(normalizeToolResult(result), call);
      for (const artifact of prepared.artifacts) {
        for (let offset = 0, seq = 0; offset < artifact.data.length; offset += ARTIFACT_CHUNK_BYTES, seq += 1) {
          const chunk = artifact.data.subarray(offset, offset + ARTIFACT_CHUNK_BYTES);
          await this.sendArtifactChunk(call, artifact, chunk, offset, seq, controller.signal);
        }
      }
      await this.send({
        type: 'client_tool_result',
        call_id: call.call_id,
        generation: call.generation,
        result: prepared.result,
      }, controller.signal);
    } catch (error) {
      if (
        isAmbiguousHostTransportError(error) ||
        (mutating && error instanceof CapabilityProtocolError && error.code === 'cancelled')
      ) {
        // Do not turn a lost broker/stdio transport into a determinate tool
        // result: an effect may already have happened locally. Dropping this
        // exact capability socket lets the Gateway apply the catalog's safety
        // class (safe exact-host retry vs mutation indeterminate).
        this.options.onPhase?.(
          'error',
          error instanceof Error ? error.message : 'Local capability transport lost',
        );
        this.socket?.terminate();
        return;
      }
      await this.sendError(call, error);
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(call.call_id);
      this.options.onActivity?.(this.active.size);
    }
  }

  private sendError(call: ClientToolCall, error: unknown): Promise<void> {
    return this.send({
      type: 'client_tool_result',
      call_id: call.call_id,
      generation: call.generation,
      error: protocolError(error),
    });
  }

  private flushToolEvents(): void {
    if (!this.acknowledged || this.eventFlush) return;
    this.eventFlush = (async () => {
      for (const event of this.pendingEvents.values()) {
        if (!this.acknowledged) return;
        const offer = this.options.getOffer();
        await this.send({
          type: 'client_tool_event',
          generation: offer.generation,
          event,
        });
      }
    })().catch((error) => this.handleOutboundFailure(error)).finally(() => {
      this.eventFlush = null;
    });
  }

  /**
   * Serialize writes and wait for ws' completion callback. This makes the
   * transport itself the backpressure boundary instead of eagerly buffering
   * an entire multi-megabyte result in Electron's main process.
   */
  private send(frame: CapabilityClientFrame, signal?: AbortSignal): Promise<void> {
    return this.enqueueSend(() => encodeCapabilityFrame(frame), signal);
  }

  private sendArtifactChunk(
    call: ClientToolCall,
    artifact: PreparedArtifact,
    chunk: Buffer,
    offset: number,
    seq: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Base64 conversion is deliberately delayed until this frame reaches the
    // head of the send queue, keeping slow receivers from accumulating every
    // encoded artifact chunk in memory.
    return this.enqueueSend(() => encodeCapabilityFrame({
      type: 'client_artifact_chunk',
      call_id: call.call_id,
      generation: call.generation,
      transfer_id: artifact.transferId,
      seq,
      data: chunk.toString('base64'),
      eof: offset + chunk.length >= artifact.data.length,
      ...(seq === 0 ? {
        size: artifact.data.length,
        mime_type: artifact.mimeType,
        sha256: artifact.sha256,
      } : {}),
    }), signal);
  }

  private enqueueSend(encode: () => string, signal?: AbortSignal): Promise<void> {
    const socket = this.socket;
    const epoch = this.outboundEpoch;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(capabilityTransportLost('Capability WebSocket is not open'));
    }
    const previous = this.outboundTail;
    const task = previous.catch(() => {}).then(async () => {
      this.assertCurrentTransport(socket, epoch, signal);
      const startedAt = Date.now();
      while (socket.bufferedAmount > SOCKET_BUFFER_HIGH_WATER_BYTES) {
        this.assertCurrentTransport(socket, epoch, signal);
        if (Date.now() - startedAt >= SOCKET_SEND_STALL_MS) {
          throw capabilityTransportLost('Capability WebSocket send buffer did not drain');
        }
        await waitForSendCapacity(signal);
      }
      this.assertCurrentTransport(socket, epoch, signal);
      await sendWebSocketFrame(socket, encode(), signal);
      this.assertCurrentTransport(socket, epoch, signal);
    });
    // A failed write must not poison later queue bookkeeping. Callers still
    // receive the original rejection and close this exact capability stream.
    this.outboundTail = task.catch(() => {});
    return task;
  }

  private assertCurrentTransport(socket: WebSocket, epoch: number, signal?: AbortSignal): void {
    if (
      signal?.aborted ||
      this.socket !== socket ||
      this.outboundEpoch !== epoch ||
      socket.readyState !== WebSocket.OPEN
    ) {
      throw capabilityTransportLost('Capability WebSocket changed or closed during send');
    }
  }

  private sendDetached(frame: CapabilityClientFrame): void {
    void this.send(frame).catch((error) => this.handleOutboundFailure(error));
  }

  private handleOutboundFailure(error: unknown): void {
    if (this.stopped) return;
    this.options.onPhase?.('error', error instanceof Error ? error.message : String(error));
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.terminate();
  }

  private abortAll(reason: string): void {
    for (const controller of this.active.values()) controller.abort(reason);
    this.active.clear();
    this.options.onActivity?.(0);
  }
}

function classificationForArguments(
  tool: ClientCapabilityServer['tools'][number] | undefined,
  args: Record<string, unknown>,
): string | undefined {
  const matches: string[] = [];
  for (const [argument, values] of Object.entries(
    tool?.classification_by_argument ?? {},
  )) {
    const value = args[argument];
    if (typeof value === 'string' && typeof values[value] === 'string') {
      matches.push(values[value]);
    }
  }
  if (!matches.length) return tool?.classification;
  const risk: Record<string, number> = {
    read_only: 0,
    idempotent: 1,
    mutating: 2,
  };
  return matches.reduce((mostRestrictive, candidate) =>
    (risk[candidate] ?? risk.mutating) >
    (risk[mostRestrictive] ?? risk.mutating)
      ? candidate
      : mostRestrictive,
  );
}

function isAmbiguousHostTransportError(error: unknown): boolean {
  return error instanceof CapabilityProtocolError && [
    'host_transport_lost',
    'host_timeout',
    'host_stopped',
    'host_protocol_error',
    'capability_transport_lost',
  ].includes(error.code);
}

function capabilityTransportLost(message: string): CapabilityProtocolError {
  return new CapabilityProtocolError('capability_transport_lost', message);
}

function waitForSendCapacity(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(capabilityTransportLost('Capability send was cancelled'));
      return;
    }
    const timer = setTimeout(done, SOCKET_BUFFER_POLL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(capabilityTransportLost('Capability send was cancelled'));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sendWebSocketFrame(socket: WebSocket, payload: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(capabilityTransportLost('Capability WebSocket send timed out')), SOCKET_SEND_STALL_MS);
    const onAbort = () => finish(capabilityTransportLost('Capability send was cancelled'));
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      socket.send(payload, (error) => finish(error ? capabilityTransportLost(error.message) : undefined));
    } catch (error) {
      finish(capabilityTransportLost(error instanceof Error ? error.message : String(error)));
    }
  });
}

function toolEventKey(event: Record<string, unknown>): string | null {
  if (event.type === 'shell_completed' && typeof event.shell_id === 'string' && event.shell_id) {
    return `shell_completed:${event.shell_id}`;
  }
  return null;
}

interface PreparedArtifact {
  transferId: string;
  mimeType: string;
  sha256: string;
  data: Buffer;
}

/** Extract large MCP base64 blocks into the bounded artifact sub-protocol. */
export function prepareToolResultArtifacts(
  input: ReturnType<typeof normalizeToolResult>,
  call: Pick<ClientToolCall, 'call_id'>,
): { result: ReturnType<typeof normalizeToolResult>; artifacts: PreparedArtifact[] } {
  const artifacts: PreparedArtifact[] = [];
  let totalBytes = 0;
  let artifactIndex = 0;
  const visit = (raw: unknown): unknown => {
    if (Array.isArray(raw)) return raw.map(visit);
    if (!raw || typeof raw !== 'object') return raw;
    const block = raw as Record<string, unknown>;
    const type = String(block.type || '');
    let encoded: string | null = null;
    let artifactTemplate: Record<string, unknown> | null = null;
    let artifactInsertPath: string[] | null = null;
    let mimeType = typeof block.mimeType === 'string'
      ? block.mimeType
      : typeof block.mime_type === 'string' ? block.mime_type : 'application/octet-stream';
    if (['image', 'audio', 'video', 'file', 'blob'].includes(type) && typeof block.data === 'string') {
      encoded = block.data;
      artifactTemplate = { ...block };
      delete artifactTemplate.data;
      artifactInsertPath = ['data'];
    } else if (
      type === 'resource' &&
      block.resource &&
      typeof block.resource === 'object' &&
      typeof (block.resource as Record<string, unknown>).blob === 'string'
    ) {
      const resource = block.resource as Record<string, unknown>;
      encoded = resource.blob as string;
      mimeType = typeof resource.mimeType === 'string'
        ? resource.mimeType
        : typeof resource.mime_type === 'string' ? resource.mime_type : mimeType;
      const resourceTemplate = { ...resource };
      delete resourceTemplate.blob;
      artifactTemplate = { ...block, resource: resourceTemplate };
      artifactInsertPath = ['resource', 'blob'];
    } else if (
      type === 'text' &&
      typeof block.text === 'string' &&
      input._meta?.encoding === 'base64'
    ) {
      encoded = block.text;
      if (typeof input._meta.mimeType === 'string') mimeType = input._meta.mimeType;
      artifactTemplate = { ...block };
      delete artifactTemplate.text;
      artifactInsertPath = ['text'];
    }
    if (encoded) {
      const data = decodeBase64(encoded);
      if (data && data.length >= ARTIFACT_THRESHOLD_BYTES) {
        if (artifacts.length >= MAX_ARTIFACT_TRANSFERS_PER_CALL) {
          throw new CapabilityProtocolError(
            'too_many_artifacts',
            `Client tool result exceeds ${MAX_ARTIFACT_TRANSFERS_PER_CALL} artifact transfers`,
          );
        }
        totalBytes += data.length;
        if (totalBytes > MAX_ARTIFACT_BYTES_PER_CALL) {
          throw new CapabilityProtocolError(
            'artifact_too_large',
            `Client tool artifacts exceed ${MAX_ARTIFACT_BYTES_PER_CALL} bytes`,
          );
        }
        const sha256 = createHash('sha256').update(data).digest('hex');
        const transferId = `${call.call_id.slice(0, 160)}-${artifactIndex++}-${sha256.slice(0, 12)}`;
        artifacts.push({ transferId, mimeType, sha256, data });
        return {
          type: 'artifact_ref',
          transfer_id: transferId,
          ...(artifactTemplate && artifactInsertPath ? {
            artifact_template: artifactTemplate,
            artifact_insert_path: artifactInsertPath,
          } : {}),
        };
      }
    }
    return Object.fromEntries(Object.entries(block).map(([key, value]) => [key, visit(value)]));
  };
  const result = visit(input) as ReturnType<typeof normalizeToolResult>;
  if (!artifacts.length) return { result: input, artifacts };
  return { result, artifacts };
}

function decodeBase64(value: string): Buffer | null {
  const compact = value.replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  try {
    return Buffer.from(compact, 'base64');
  } catch {
    return null;
  }
}

function localDeadline(deadlineMs?: number): number | null {
  if (deadlineMs == null || !Number.isFinite(deadlineMs)) return null;
  const remaining = deadlineMs > 1_000_000_000_000
    ? deadlineMs - Date.now()
    : deadlineMs;
  return Math.max(1, Math.min(remaining, 24 * 60 * 60 * 1000));
}
