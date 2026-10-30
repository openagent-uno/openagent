export const MCP_APPS_VERSION: '2026-01-26';
export const MCP_APP_MIME: 'text/html;profile=mcp-app';
export const MCP_APPS_CAPABILITY: Readonly<Record<string, unknown>>;
export class McpAppError extends Error { readonly code: string; constructor(code: string, message?: string); }
export type JsonObject = Record<string, unknown>;
export interface McpAppBinding { sourceId: string; toolRef: string; contextId: string; capabilityEpoch: string; }
export interface McpAppBroker {
  authorize(binding: Readonly<McpAppBinding>, operation: JsonObject, signal?: AbortSignal): Promise<boolean>;
  callTool?(binding: Readonly<McpAppBinding>, params: { name: string; arguments: JsonObject }, signal: AbortSignal): Promise<unknown>;
  readResource?(binding: Readonly<McpAppBinding>, params: { uri: string }, signal?: AbortSignal): Promise<unknown>;
  openLink?(binding: Readonly<McpAppBinding>, params: { url: string }, signal: AbortSignal): Promise<unknown>;
  sendMessage?(binding: Readonly<McpAppBinding>, params: { role: 'user'; content: JsonObject[] }, signal: AbortSignal): Promise<unknown>;
  updateContext?(binding: Readonly<McpAppBinding>, params: { content?: JsonObject[]; structuredContent?: JsonObject }, signal: AbortSignal): Promise<unknown>;
  requestDisplayMode?(binding: Readonly<McpAppBinding>, params: { mode: 'inline' | 'fullscreen' | 'pip' }, signal: AbortSignal): Promise<{mode: 'inline'|'fullscreen'|'pip'}>;
  log?(binding: Readonly<McpAppBinding>, params: JsonObject, signal: AbortSignal): Promise<unknown>;
}
export interface McpAppCsp { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[]; }
export interface McpAppResource { uri: string; mimeType: 'text/html;profile=mcp-app'; html: string; _meta?: JsonObject; }
export interface McpAppPolicy { approvedCsp?: McpAppCsp; grantedPermissions?: Partial<Record<'camera'|'microphone'|'geolocation'|'clipboardWrite', boolean>>; }
export interface McpAppSessionOptions {
  binding: McpAppBinding; broker: McpAppBroker; send(frame: JsonObject): void;
  hostInfo?: {name: string;version: string}; hostContext?: JsonObject;
  policy?: {csp: McpAppCsp;permissions: JsonObject};
  onResize?(size: {height: number;width?: number}): void; onClose?(): void;
}
export class McpAppSession {
  readonly binding: Readonly<McpAppBinding>; readonly state: string;
  constructor(options: McpAppSessionOptions);
  authorize(operation: JsonObject, signal?: AbortSignal): Promise<void>;
  receive(frame: unknown): Promise<void>;
  setToolInput(arguments_: JsonObject): Promise<void>;
  setToolInputUnavailable():Promise<void>;
  setToolInputPartial(arguments_: JsonObject): Promise<void>;
  setToolResult(result: JsonObject): Promise<void>;
  setHostContext(context: JsonObject): Promise<void>;
  cancel(reason?: string): Promise<void>;
  revoke(): void; dispose(): Promise<void>;
}
export interface MountMcpAppOptions extends Omit<McpAppSessionOptions, 'send'|'policy'>, McpAppPolicy {
  container: HTMLElement; sandboxUrl: string; resource: McpAppResource; title?: string;
  toolInput?: JsonObject; toolResult?: JsonObject;
}
export interface McpAppController {
  iframe: HTMLIFrameElement; session: McpAppSession;
  setToolInput(arguments_: JsonObject): Promise<void>;
  setToolInputUnavailable():Promise<void>;
  setToolInputPartial(arguments_: JsonObject): Promise<void>;
  setToolResult(result: JsonObject): Promise<void>;
  setHostContext(context: JsonObject): Promise<void>;
  cancel(reason?: string): Promise<void>; revoke(): void; dispose(): Promise<void>;
}
export function mountMcpApp(options: MountMcpAppOptions): Promise<McpAppController>;
export function loadMcpAppResource(options: {tool: JsonObject;binding: McpAppBinding;broker: McpAppBroker;signal?: AbortSignal;listingMeta?: JsonObject}): Promise<McpAppResource>;
export function parseUiResource(value: unknown, expectedUri: string, listingMeta?: JsonObject): McpAppResource;
export function uiResourceUri(tool: unknown): string | undefined;
export function effectiveResourcePolicy(meta?: JsonObject, policy?: McpAppPolicy): {csp: McpAppCsp;permissions: JsonObject};
export function normalizeCsp(csp?: McpAppCsp): McpAppCsp;
export function contentSecurityPolicy(csp?: McpAppCsp): string;
export function externalUrl(value: unknown): string;
export function boundedCopy<T>(value: T, maxBytes?: number): T;
export function isRecord(value: unknown): value is JsonObject;
export function safeString(value: unknown, max?: number): value is string;
export function buildSandboxProxyHtml(): string;
export const SANDBOX_PROXY_HEADERS: Readonly<Record<string, string>>;

export function normalizeTextMessage(params:unknown):{role:'user';content:Array<{type:'text';text:string}>};
