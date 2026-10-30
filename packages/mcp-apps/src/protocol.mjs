export const MCP_APPS_VERSION = '2026-01-26';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
export const MCP_APPS_CAPABILITY = Object.freeze({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME] } } });
export class McpAppError extends Error {
  constructor(code, message = code) { super(message); this.name = 'McpAppError'; this.code = code; }
}
export const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const safeString = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
export function boundedCopy(value, max = 1024 * 1024) {
  let json;
  try { json = JSON.stringify(value); } catch { throw new McpAppError('invalid_payload'); }
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > max) throw new McpAppError('payload_limit');
  return JSON.parse(json);
}
export function uiResourceUri(tool) {
  const meta = isRecord(tool?._meta) ? tool._meta : {};
  const uri = (isRecord(meta.ui) ? meta.ui.resourceUri : undefined) ?? meta['ui/resourceUri'];
  return safeString(uri, 2048) && uri.startsWith('ui://') ? uri : undefined;
}
export function externalUrl(value) {
  if (!safeString(value, 4096)) throw new McpAppError('invalid_url');
  let url;
  try { url = new URL(value); } catch { throw new McpAppError('invalid_url'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new McpAppError('invalid_url');
  return url.href;
}
export function normalizeTextMessage(params) {
  const content=Array.isArray(params?.content)?params.content:isRecord(params?.content)?[params.content]:[];
  if(params?.role!=='user'||!content.length||content.length>32||!content.every(block=>isRecord(block)&&block.type==='text'&&typeof block.text==='string'))throw new McpAppError('invalid_message');
  return boundedCopy({role:'user',content:content.map(block=>({type:'text',text:block.text}))},64*1024);
}
const CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'];
export function normalizeCsp(csp = {}) {
  if (!isRecord(csp)) throw new McpAppError('invalid_csp');
  const result = {};
  for (const key of CSP_KEYS) {
    const domains = csp[key] ?? [];
    if (!Array.isArray(domains) || domains.length > 32) throw new McpAppError('invalid_csp');
    result[key] = [...new Set(domains.map(domain => {
      if (!safeString(domain, 512) || !/^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/i.test(domain) && !(key === 'connectDomains' && /^wss:\/\/(?:\*\.)?[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/i.test(domain))) throw new McpAppError('invalid_csp');
      return domain.replace(/\/$/, '').toLowerCase();
    }))];
  }
  return result;
}
export function effectiveResourcePolicy(resourceMeta = {}, policy = {}) {
  const ui = isRecord(resourceMeta.ui) ? resourceMeta.ui : {};
  const requested = normalizeCsp(ui.csp ?? {});
  const approved = normalizeCsp(policy.approvedCsp ?? {});
  const csp = Object.fromEntries(CSP_KEYS.map(key => [key, requested[key].filter(domain => approved[key].includes(domain))]));
  const permissions = {};
  for (const key of ['camera', 'microphone', 'geolocation', 'clipboardWrite']) {
    if (isRecord(ui.permissions?.[key]) && policy.grantedPermissions?.[key] === true) permissions[key] = {};
  }
  return { csp, permissions };
}
export function contentSecurityPolicy(csp = {}) {
  const domains = normalizeCsp(csp);
  const src = key => domains[key].length ? domains[key].join(' ') : "'none'";
  const resources = domains.resourceDomains.join(' ');
  return ["default-src 'none'", `script-src 'unsafe-inline' ${resources}`, `style-src 'unsafe-inline' ${resources}`,
    `img-src data: ${resources}`, `font-src ${src('resourceDomains')}`, `media-src data: ${resources}`,
    `connect-src ${src('connectDomains')}`, `frame-src ${src('frameDomains')}`, `base-uri ${src('baseUriDomains')}`,
    "object-src 'none'", "form-action 'none'", "worker-src 'none'"].join('; ');
}

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new McpAppError('operation_cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve(value).then(result => { cleanup(); resolve(result); }, cause => { cleanup(); reject(cause); });
  });
}

/** Pure JSON-RPC session. The binding is trusted host state and is never taken from guest params. */
export class McpAppSession {
  constructor(options) {
    if (!isRecord(options.binding) || !['sourceId', 'toolRef', 'contextId', 'capabilityEpoch'].every(key => safeString(options.binding[key], 2048)) || typeof options.broker?.authorize !== 'function' || typeof options.send !== 'function') throw new McpAppError('invalid_binding');
    this.binding = Object.freeze(boundedCopy(options.binding, 8192));
    this.broker = options.broker; this.send = options.send; this.onResize = options.onResize;
    this.hostInfo = options.hostInfo ?? { name: 'OpenAgent', version: 'source' };
    this.hostContext = boundedCopy(options.hostContext ?? {});
    this.policy = options.policy ?? { csp: normalizeCsp(), permissions: {} };
    this.state = 'new'; this.epoch = 0; this.pending = new Map(); this.seen = new Set();
    this.input = undefined; this.result = undefined; this.cancelled = undefined; this.inputSent = false;
    this.controller = new AbortController(); this.onClose = options.onClose; this.delivery = Promise.resolve(); this.toolCancelled = false;
  }
  async authorize(operation, signal = this.controller.signal) {
    const epoch = this.epoch;
    if (this.state === 'closed' || signal.aborted) throw new McpAppError('app_revoked');
    const allowed = await abortable(this.broker.authorize(this.binding, operation, signal), signal);
    if (allowed !== true || epoch !== this.epoch || this.state === 'closed' || signal.aborted) throw new McpAppError('app_revoked');
  }
  emit(method, params) { if (this.state !== 'closed') this.send({ jsonrpc: '2.0', method, params: boundedCopy(params, 16 * 1024 * 1024) }); }
  async publish(method, params) {
    try { await this.authorize({ kind: 'publish', method }); this.emit(method, params); }
    catch { this.revoke(); }
  }
  setToolInput(arguments_) {
    if (this.inputSent || this.input !== undefined) throw new McpAppError('tool_input_already_sent');
    this.input = boundedCopy(arguments_);
    if (!isRecord(this.input)) throw new McpAppError('invalid_arguments');
    return this.flush();
  }
  setToolInputUnavailable() {
    if(this.inputSent||this.input!==undefined)throw new McpAppError('tool_input_already_sent');
    // Close the input stage without inventing an empty argument notification.
    this.inputSent=true;return this.flush();
  }
  setToolInputPartial(arguments_) {
    if (this.inputSent) throw new McpAppError('tool_input_already_sent');
    return this.state === 'ready' ? this.publish('ui/notifications/tool-input-partial', { arguments: boundedCopy(arguments_) }) : Promise.resolve();
  }
  setToolResult(result) { if (this.toolCancelled) return Promise.resolve(); this.result = boundedCopy(result, 16 * 1024 * 1024); return this.flush(); }
  setHostContext(context) { this.hostContext = boundedCopy(context); return this.state === 'ready' ? this.publish('ui/notifications/host-context-changed', this.hostContext) : Promise.resolve(); }
  cancel(reason = 'Tool execution cancelled') { this.toolCancelled = true; this.result = undefined; this.cancelled = String(reason).slice(0, 4096); for (const controller of this.pending.values()) controller.abort(); return this.flush(); }
  flush() {
    const operation = this.delivery.then(() => this.flushNow());
    this.delivery = operation.catch(() => {}); return operation;
  }
  async flushNow() {
    if (this.state !== 'ready') return;
    if (this.input !== undefined && !this.inputSent) { this.inputSent = true; await this.publish('ui/notifications/tool-input', { arguments: this.input }); }
    if (!this.inputSent || this.state !== 'ready') return;
    if (this.cancelled !== undefined) { const reason = this.cancelled; this.cancelled = undefined; await this.publish('ui/notifications/tool-cancelled', { reason }); }
    else if (this.result !== undefined) { const result = this.result; this.result = undefined; await this.publish('ui/notifications/tool-result', result); }
  }
  capabilities() {
    return { ...(this.broker.callTool ? { serverTools: {} } : {}), ...(this.broker.readResource ? { serverResources: {} } : {}),
      ...(this.broker.openLink ? { openLinks: {} } : {}), ...(this.broker.log ? { logging: {} } : {}), sandbox: this.policy };
  }
  async receive(raw) {
    if (this.state === 'closed' || this.state === 'closing') return;
    let frame;
    try { frame = boundedCopy(raw); } catch { this.revoke(); return; }
    if (!isRecord(frame) || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string' || frame.params !== undefined && !isRecord(frame.params)) { this.revoke(); return; }
    const params = frame.params ?? {};
    const hasId = Object.hasOwn(frame, 'id');
    if (!hasId) {
      if (frame.method === 'ui/notifications/initialized') {
        if (this.state !== 'initializing') { this.revoke(); return; }
        this.state = 'ready'; await this.flush(); return;
      }
      if (this.state !== 'ready') return;
      if (frame.method === 'notifications/cancelled') {
        const key = `${typeof params.requestId}:${params.requestId}`; this.pending.get(key)?.abort(); return;
      }
      if (frame.method === 'ui/notifications/size-changed') {
        if (typeof params.height !== 'number' || !Number.isFinite(params.height) || params.height < 0 || params.height > 4096 || params.width !== undefined && (typeof params.width !== 'number' || !Number.isFinite(params.width) || params.width < 0 || params.width > 8192)) return;
        try { await this.authorize({ kind: 'resize' }); this.onResize?.({ height: Math.max(80, Math.ceil(params.height)), width: params.width }); } catch { this.revoke(); }
      } else if (frame.method === 'notifications/message' && this.broker.log) {
        try { await this.authorize({ kind: 'log' }); await this.broker.log(this.binding, boundedCopy(params, 16 * 1024), this.controller.signal); } catch { /* Logging never gains another privilege. */ }
      }
      return;
    }
    const id = frame.id;
    if (!(typeof id === 'string' && safeString(id, 128) || Number.isSafeInteger(id))) { this.revoke(); return; }
    const key = `${typeof id}:${id}`;
    if (this.seen.has(key) || this.seen.size >= 4096 || this.pending.size >= 16) { this.replyError(id, -32600, 'Duplicate request or session request limit'); return; }
    this.seen.add(key);
    const controller = new AbortController(); this.pending.set(key, controller); const epoch = this.epoch;
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let result;
      if (frame.method === 'ui/initialize') {
        if (this.state !== 'new' || params.protocolVersion !== MCP_APPS_VERSION || !isRecord(params.appInfo) || !safeString(params.appInfo.name, 128) || !safeString(params.appInfo.version, 64) || !isRecord(params.appCapabilities)) throw new McpAppError('unsupported_ui_protocol');
        this.state = 'initializing';
        await this.authorize({ kind: 'initialize' }, controller.signal);
        result = { protocolVersion: MCP_APPS_VERSION, hostInfo: this.hostInfo, hostCapabilities: this.capabilities(), hostContext: this.hostContext };
      } else {
        if (this.state !== 'ready') throw new McpAppError('app_not_initialized');
        await this.authorize({ kind: frame.method, params }, controller.signal);
        result = await abortable(this.dispatch(frame.method, params, controller.signal), controller.signal);
        await this.authorize({ kind: 'publish', method: frame.method }, controller.signal);
      }
      if (epoch === this.epoch && !controller.signal.aborted && this.state !== 'closed') this.send({ jsonrpc: '2.0', id, result: boundedCopy(result ?? {}, 16 * 1024 * 1024) });
    } catch (cause) {
      let revoked = cause?.code === 'app_revoked';
      // An authenticated backend may reject after the initial admission. Recheck
      // current publication rights on failures too; do not retain a dead panel.
      if (!revoked && this.state === 'ready' && epoch === this.epoch) {
        try { await this.authorize({ kind: 'publish', method: frame.method }); }
        catch { revoked = true; }
      }
      if (revoked) this.revoke();
      else if (epoch === this.epoch && this.state !== 'closed') this.replyError(id, cause?.code === 'method_not_found' ? -32601 : -32000, cause instanceof McpAppError ? cause.code : 'App operation failed');
    } finally { clearTimeout(timer); this.pending.delete(key); }
  }
  replyError(id, code, message) { if (this.state !== 'closed') this.send({ jsonrpc: '2.0', id, error: { code, message } }); }
  async dispatch(method, params, signal) {
    switch (method) {
      case 'ping': return {};
      case 'tools/call':
        if (!this.broker.callTool) throw new McpAppError('method_not_found');
        if (!safeString(params.name, 128) || params.arguments !== undefined && !isRecord(params.arguments)) throw new McpAppError('invalid_arguments');
        return this.broker.callTool(this.binding, { name: params.name, arguments: boundedCopy(params.arguments ?? {}) }, signal);
      case 'resources/read':
        if (!this.broker.readResource) throw new McpAppError('method_not_found');
        if (!safeString(params.uri, 2048) || !params.uri.startsWith('ui://')) throw new McpAppError('invalid_resource_uri');
        return this.broker.readResource(this.binding, { uri: params.uri }, signal);
      case 'ui/open-link':
        if (!this.broker.openLink) throw new McpAppError('method_not_found');
        await this.broker.openLink(this.binding, { url: externalUrl(params.url) }, signal); return {};
      case 'ui/message':
        if (!this.broker.sendMessage) throw new McpAppError('method_not_found');
        await this.broker.sendMessage(this.binding, normalizeTextMessage(params), signal); return {};
      case 'ui/update-model-context':
        if (!this.broker.updateContext) throw new McpAppError('method_not_found');
        if (params.content !== undefined && !Array.isArray(params.content) || params.structuredContent !== undefined && !isRecord(params.structuredContent)) throw new McpAppError('invalid_context');
        await this.broker.updateContext(this.binding, boundedCopy({ content: params.content, structuredContent: params.structuredContent }, 64 * 1024), signal); return {};
      case 'ui/request-display-mode':
        if (!['inline', 'fullscreen', 'pip'].includes(params.mode)) throw new McpAppError('invalid_display_mode');
        return this.broker.requestDisplayMode ? this.broker.requestDisplayMode(this.binding, { mode: params.mode }, signal) : { mode: 'inline' };
      default: throw new McpAppError('method_not_found');
    }
  }
  revoke() {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.epoch++; this.controller.abort();
    for (const controller of this.pending.values()) controller.abort(); this.pending.clear();
    this.input = undefined; this.result = undefined; this.onClose?.();
  }
  async dispose() {
    if (this.state === 'closed' || this.state === 'closing') return;
    if (this.state === 'ready') this.send({ jsonrpc: '2.0', id: 'oa-host-teardown', method: 'ui/resource-teardown', params: {} });
    this.state = 'closing'; this.controller.abort();
    for (const controller of this.pending.values()) controller.abort();
    await new Promise(resolve => setTimeout(resolve, 100)); this.revoke();
  }
}
