import type {
  CapabilityClientFrame,
  CapabilityServerFrame,
  ClientCapabilityServer,
  ClientToolCall,
  ClientToolResultError,
  ClientToolResultValue,
} from '../../../common/client-capabilities';

export type {
  CapabilityClientFrame,
  CapabilityServerFrame,
  ClientCapabilityServer,
  ClientToolCall,
  ClientToolResultError,
  ClientToolResultValue,
};

export const CAPABILITY_PROTOCOL = 'client-capabilities/1' as const;
export const HOST_TOOLS_PROTOCOL = 'openagent-host-tools/1' as const;

export interface HostToolsRequest {
  id: string;
  type: 'initialize' | 'catalog' | 'call' | 'cancel' | 'status' | 'shutdown' | 'set_consent' | 'release_principal';
  protocol?: typeof HOST_TOOLS_PROTOCOL;
  principal?: Record<string, unknown>;
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  idempotency_key?: string;
  arguments_sha256?: string;
  deadline_ms?: number;
  call_id?: string;
  enabled?: boolean;
  consent_version?: number;
}

export interface HostToolsError {
  code: string;
  message: string;
  data?: unknown;
}

export interface HostToolsResponse {
  id: string;
  type: 'response';
  ok: boolean;
  result?: unknown;
  error?: HostToolsError;
}

export interface HostToolsEvent {
  type: 'event';
  event: Record<string, unknown>;
}

export interface HostToolsCatalog {
  servers: ClientCapabilityServer[];
}

export type CapabilityPhase =
  | 'disabled'
  | 'starting'
  | 'unavailable'
  | 'ready'
  | 'connecting'
  | 'connected'
  | 'active';

export interface DesktopCapabilityStatus {
  clientInstanceId: string;
  consent: {
    enabled: boolean;
    version: number;
    updatedAt: string | null;
  };
  phase: CapabilityPhase;
  generation: number;
  connectedAccounts: number;
  activeCalls: number;
  servers: Array<{ name: string; tools: number }>;
  error: string | null;
}

export class CapabilityProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CapabilityProtocolError';
  }
}

export function parseCapabilityServerFrame(raw: string): CapabilityServerFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CapabilityProtocolError('invalid_json', 'Capability frame is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityProtocolError('invalid_frame', 'Capability frame must be an object');
  }
  const frame = value as Record<string, unknown>;
  if (typeof frame.type !== 'string') {
    throw new CapabilityProtocolError('invalid_frame', 'Capability frame is missing type');
  }
  switch (frame.type) {
    case 'capability_hello_ack':
      requireString(frame, 'protocol');
      requireString(frame, 'device_id');
      requireString(frame, 'account_id');
      if (frame.network_id !== undefined) requireString(frame, 'network_id');
      requireString(frame, 'client_instance_id');
      requireGeneration(frame);
      if (typeof frame.accepted !== 'boolean') invalid('accepted must be a boolean');
      return frame as unknown as CapabilityServerFrame;
    case 'capability_heartbeat_ack':
      requireGeneration(frame);
      return frame as unknown as CapabilityServerFrame;
    case 'client_tool_event_ack':
      requireGeneration(frame);
      requireString(frame, 'shell_id');
      if (typeof frame.accepted !== 'boolean') invalid('accepted must be a boolean');
      if (frame.duplicate !== undefined && typeof frame.duplicate !== 'boolean') {
        invalid('duplicate must be a boolean');
      }
      return frame as unknown as CapabilityServerFrame;
    case 'client_tool_call':
      requireString(frame, 'call_id');
      requireGeneration(frame);
      requireString(frame, 'server');
      requireString(frame, 'tool');
      requireString(frame, 'account_id');
      if (frame.network_id !== undefined) requireString(frame, 'network_id');
      if (frame.session_id != null) requireString(frame, 'session_id');
      requireString(frame, 'idempotency_key');
      requireString(frame, 'arguments_sha256');
      if (!/^[a-f0-9]{64}$/.test(frame.arguments_sha256 as string)) {
        invalid('arguments_sha256 must be a lowercase SHA-256 hex digest');
      }
      if (!frame.args || typeof frame.args !== 'object' || Array.isArray(frame.args)) {
        invalid('args must be an object');
      }
      if (frame.deadline_ms !== undefined &&
          (typeof frame.deadline_ms !== 'number' || !Number.isFinite(frame.deadline_ms))) {
        invalid('deadline_ms must be a finite number');
      }
      return frame as unknown as CapabilityServerFrame;
    case 'client_tool_cancel':
      requireString(frame, 'call_id');
      requireGeneration(frame);
      return frame as unknown as CapabilityServerFrame;
    default:
      throw new CapabilityProtocolError('unknown_frame', `Unknown capability frame: ${frame.type}`);
  }
}

export function normalizeToolResult(value: unknown): ClientToolResultValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ClientToolResultValue;
  }
  return {
    content: [{ type: 'text', text: value == null ? '' : String(value) }],
  };
}

export function protocolError(error: unknown): ClientToolResultError {
  if (error instanceof CapabilityProtocolError) {
    if (error.code === 'idempotency_indeterminate') {
      const detail = error.data && typeof error.data === 'object' && !Array.isArray(error.data)
        ? error.data as Record<string, unknown>
        : {};
      return {
        code: 'CLIENT_RESULT_INDETERMINATE',
        message: error.message,
        data: { local_code: error.code, ...detail },
      };
    }
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof Error) {
    return { code: 'client_tool_error', message: error.message };
  }
  return { code: 'client_tool_error', message: String(error) };
}

export function encodeCapabilityFrame(frame: CapabilityClientFrame): string {
  return JSON.stringify(frame);
}

function requireString(frame: Record<string, unknown>, key: string): void {
  if (typeof frame[key] !== 'string' || !(frame[key] as string).length) {
    invalid(`${key} must be a non-empty string`);
  }
}

function requireGeneration(frame: Record<string, unknown>): void {
  if (!Number.isInteger(frame.generation) || (frame.generation as number) < 1) {
    invalid('generation must be an integer >= 1');
  }
}

function invalid(message: string): never {
  throw new CapabilityProtocolError('invalid_frame', message);
}
