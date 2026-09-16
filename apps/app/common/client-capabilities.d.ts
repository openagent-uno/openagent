/**
 * OpenAgent client-capability protocol v1.
 *
 * This declaration is deliberately runtime-free so Electron main, the
 * universal renderer, and external host-tool implementations can share the
 * wire contract without coupling their build outputs.
 */

export type ClientCapabilityProtocol = 'client-capabilities/1';

export interface ClientCapabilityTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  classification?: string;
  classification_by_argument?: Record<string, Record<string, string>>;
}

export interface ClientCapabilityServer {
  name: string;
  version?: string;
  instructions?: string;
  tools: ClientCapabilityTool[];
}

export interface CapabilityHello {
  type: 'capability_hello';
  protocol: ClientCapabilityProtocol;
  client_instance_id: string;
  generation: number;
  device_label: string;
  /** Certified network expected on this already-authenticated channel. */
  network_id?: string;
  servers: ClientCapabilityServer[];
}

export interface CapabilityHelloAck {
  type: 'capability_hello_ack';
  protocol: ClientCapabilityProtocol;
  device_id: string;
  /** Network identity derived by the Gateway from the device certificate. */
  account_id: string;
  network_id?: string;
  client_instance_id: string;
  generation: number;
  accepted: boolean;
  reason?: string;
}

export interface CapabilityCatalogUpdate {
  type: 'capability_catalog_update';
  generation: number;
  servers: ClientCapabilityServer[];
}

export interface CapabilityHeartbeat {
  type: 'capability_heartbeat';
  generation: number;
  ts_ms?: number;
}

export interface CapabilityHeartbeatAck {
  type: 'capability_heartbeat_ack';
  generation: number;
  ts_ms?: number;
}

export interface ClientToolCall {
  type: 'client_tool_call';
  call_id: string;
  generation: number;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  deadline_ms?: number;
  session_id?: string | null;
  /** Certified network identity; informative only, never a local selector. */
  account_id: string;
  network_id?: string;
  idempotency_key: string;
  arguments_sha256: string;
}

export interface ClientToolCancel {
  type: 'client_tool_cancel';
  call_id: string;
  generation: number;
  reason?: string;
}

export interface ClientToolResultValue {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClientToolResultError {
  code: string;
  message: string;
  data?: unknown;
}

export interface ClientToolResult {
  type: 'client_tool_result';
  call_id: string;
  generation: number;
  result?: ClientToolResultValue;
  error?: ClientToolResultError;
}

export interface ClientArtifactChunk {
  type: 'client_artifact_chunk';
  call_id: string;
  generation: number;
  transfer_id: string;
  seq: number;
  data: string;
  eof: boolean;
  size?: number;
  mime_type?: string;
  sha256?: string;
}

export interface ClientToolEvent {
  type: 'client_tool_event';
  generation: number;
  /** Event payload produced by the local broker. Routing fields are ignored server-side. */
  event: Record<string, unknown>;
}

export interface ClientToolEventAck {
  type: 'client_tool_event_ack';
  generation: number;
  shell_id: string;
  accepted: boolean;
  duplicate?: boolean;
}

export type CapabilityClientFrame =
  | CapabilityHello
  | CapabilityCatalogUpdate
  | CapabilityHeartbeat
  | ClientToolResult
  | ClientArtifactChunk
  | ClientToolEvent;

export type CapabilityServerFrame =
  | CapabilityHelloAck
  | CapabilityHeartbeatAck
  | ClientToolCall
  | ClientToolCancel
  | ClientToolEventAck;

export interface ClientExecutionHost {
  kind: 'client';
  device_label: string;
  device_id: string;
  client_instance_id: string;
  generation: number;
}

export interface ServerExecutionHost {
  kind: 'server';
  device_label: string;
}

export type ToolExecutionHost = ClientExecutionHost | ServerExecutionHost;

export type DesktopCapabilityPhase =
  | 'disabled'
  | 'starting'
  | 'unavailable'
  | 'ready'
  | 'connecting'
  | 'connected'
  | 'active';

export interface DesktopCapabilityStatus {
  clientInstanceId: string;
  consent: { enabled: boolean; version: number; updatedAt: string | null };
  phase: DesktopCapabilityPhase;
  generation: number;
  connectedAccounts: number;
  activeCalls: number;
  servers: Array<{ name: string; tools: number }>;
  error: string | null;
}
