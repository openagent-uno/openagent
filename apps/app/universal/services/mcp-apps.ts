/** Presentation hints are untrusted; only the authenticated host resolves a tool reference. */
export interface McpAppOpenRequest { sessionId: string; toolRef: string; toolCallId?: string; agentId?: string; workspaceId?: string; accountId?: string; }
export interface McpAppView { viewId: string; url: string; }
export interface McpAppsTransport { open(request: McpAppOpenRequest): Promise<McpAppView>; close(viewId: string): Promise<void>; }
export interface McpAppSurfaceProps { request: McpAppOpenRequest; scopeKey?: string; title?: string; }
export interface McpAppHint { toolRef: string; resourceUri: string; toolCallId?: string; }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
function parsed(value: unknown): Record<string, unknown> | undefined {
  if (record(value)) return value;
  if (typeof value !== 'string' || value.length > 64 * 1024) return undefined;
  try { const result: unknown = JSON.parse(value); return record(result) ? result : undefined; } catch { return undefined; }
}
export function mcpAppHint(info: unknown): McpAppHint | undefined {
  if (!record(info)) return undefined;
  const args = parsed(info.tool_args) ?? parsed(info.arguments) ?? parsed(info.params);
  const binding = parsed(info.binding) ?? parsed(info.tool_binding);
  const toolRef = [info.tool_ref, info.toolRef, args?.tool_ref, binding?.tool_ref].find(value => text(value));
  if (!text(toolRef)) return undefined;
  const candidates = [info, parsed(info.metadata), parsed(binding?.metadata), parsed(info.result), parsed(info.output), parsed(info.definition)].filter(record);
  let resourceUri: string | undefined;
  for (const candidate of candidates) {
    const meta = parsed(candidate._meta) ?? candidate;
    const ui = parsed(meta.ui);
    const value = ui?.resourceUri ?? meta['ui/resourceUri'];
    if (text(value) && value.startsWith('ui://')) { resourceUri = value; break; }
  }
  if (!resourceUri) return undefined;
  const callId = [info.tool_call_id, info.tool_invocation_id, info.call_id].find(value => text(value, 512));
  return { toolRef, resourceUri, ...(text(callId, 512) ? { toolCallId: callId } : {}) };
}

type SelectedTransport = { transport: McpAppsTransport; trustedOrigin?: string };
let configured: SelectedTransport | null = null;
/** Called only by the trusted product bootstrap; no endpoint or credential is inferred from tool content. */
export function configureMcpAppsTransport(transport: McpAppsTransport | null, trustedOrigin?: string): void {
  if (!transport) { configured = null; return; }
  if (!trustedOrigin || typeof transport.open !== 'function' || typeof transport.close !== 'function') throw new Error('mcp_app_host_unavailable');
  const url = new URL(trustedOrigin);
  if (url.origin !== trustedOrigin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.protocol === 'http:' && !loopback(url.hostname)) throw new Error('mcp_app_host_unavailable');
  configured = { transport, trustedOrigin };
}
const loopback = (hostname: string) => ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
export function mcpAppsTransport(): SelectedTransport | null {
  if (configured) return configured;
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as Record<string, unknown>).desktop;
  const tools = record(bridge) ? bridge.mcpApps : undefined;
  return record(tools) && typeof tools.open === 'function' && typeof tools.close === 'function'
    ? { transport: tools as unknown as McpAppsTransport } : null;
}
export function validatedMcpAppView(value: unknown, trustedOrigin?: string): McpAppView {
  if (!record(value) || !text(value.viewId, 256) || !text(value.url, 8192)) throw new Error('mcp_app_host_unavailable');
  const url = new URL(value.url);
  if (url.username || url.password || (trustedOrigin ? url.origin !== trustedOrigin : url.protocol !== 'http:' || !loopback(url.hostname))) throw new Error('mcp_app_host_unavailable');
  return { viewId: value.viewId, url: url.href };
}
