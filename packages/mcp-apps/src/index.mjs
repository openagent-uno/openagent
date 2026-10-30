import { McpAppSession, MCP_APP_MIME, McpAppError, boundedCopy, effectiveResourcePolicy, isRecord, uiResourceUri } from './protocol.mjs';
export * from './protocol.mjs';
export { buildSandboxProxyHtml, SANDBOX_PROXY_HEADERS } from './sandbox.mjs';

export function parseUiResource(value, expectedUri, listingMeta = {}) {
  if (!isRecord(value) || !Array.isArray(value.contents) || value.contents.length !== 1) throw new McpAppError('invalid_ui_resource');
  const content = value.contents[0];
  if (!isRecord(content) || content.uri !== expectedUri || content.mimeType !== MCP_APP_MIME || typeof content.text !== 'string' && typeof content.blob !== 'string') throw new McpAppError('invalid_ui_resource');
  let html = content.text;
  if (html === undefined) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.blob)) throw new McpAppError('invalid_ui_resource');
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content.blob), char => char.charCodeAt(0))); } catch { throw new McpAppError('invalid_ui_resource'); }
  }
  if (new TextEncoder().encode(html).length > 2 * 1024 * 1024) throw new McpAppError('ui_resource_limit');
  const meta = isRecord(content._meta?.ui) ? content._meta : listingMeta;
  return { uri: expectedUri, mimeType: MCP_APP_MIME, html, _meta: boundedCopy(meta ?? {}) };
}

/** Fetch through an already authenticated, exact-source broker; URI is never authority. */
export async function loadMcpAppResource({ tool, binding, broker, signal, listingMeta }) {
  const uri = uiResourceUri(tool);
  if (!uri || typeof broker.readResource !== 'function') throw new McpAppError('ui_resource_unavailable');
  if (await broker.authorize(binding, { kind: 'resources/read', uri }, signal) !== true) throw new McpAppError('app_revoked');
  const value = await broker.readResource(binding, { uri }, signal);
  if (signal?.aborted || await broker.authorize(binding, { kind: 'publish', uri }, signal) !== true) throw new McpAppError('app_revoked');
  return parseUiResource(value, uri, listingMeta);
}

function cspMatchesOrigin(rule, origin) {
  const wildcard = rule.includes('://*.');
  const candidate = new URL(rule.replace('://*.', '://wildcard.'));
  const target = new URL(origin);
  return candidate.protocol === target.protocol && candidate.port === target.port &&
    (wildcard ? target.hostname.endsWith(candidate.hostname.slice('wildcard'.length)) : candidate.hostname === target.hostname);
}

/** Browser-only mount. The intermediate trusted proxy must have a distinct origin. */
export async function mountMcpApp(options) {
  const { container, resource, broker, binding } = options;
  const window_ = container.ownerDocument.defaultView;
  const hostOrigin = window_.location.origin;
  const proxyUrl = new URL(options.sandboxUrl, window_.location.href);
  if (hostOrigin === 'null' || !['http:', 'https:'].includes(proxyUrl.protocol) || proxyUrl.username || proxyUrl.password || proxyUrl.origin === hostOrigin) throw new McpAppError('isolated_sandbox_required');
  if (!resource || resource.mimeType !== MCP_APP_MIME || typeof resource.html !== 'string' || !resource.uri?.startsWith('ui://') || new TextEncoder().encode(resource.html).length > 2 * 1024 * 1024) throw new McpAppError('invalid_ui_resource');
  const policy = effectiveResourcePolicy(resource._meta ?? {}, options);
  if (Object.values(policy.csp).flat().some(rule => cspMatchesOrigin(rule, hostOrigin) || cspMatchesOrigin(rule, proxyUrl.origin))) {
    throw new McpAppError('privileged_origin_in_csp', 'App CSP cannot grant access to the host or sandbox service origin');
  }
  const iframe = container.ownerDocument.createElement('iframe');
  iframe.title = options.title ?? 'Interactive tool';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.referrerPolicy = 'no-referrer';
  iframe.style.cssText = 'border:0;width:100%;min-height:80px;height:280px;display:block';
  const features = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' };
  iframe.allow = Object.entries(features).map(([key, name]) => `${name} ${policy.permissions[key] ? '*' : "'none'"}`).join('; ');
  let closed = false, loaded = false;
  const send = frame => { if (!closed) iframe.contentWindow?.postMessage(frame, proxyUrl.origin); };
  const remove = () => { if (closed) return; closed = true; window_.removeEventListener('message', receive); iframe.remove(); options.onClose?.(); };
  const session = new McpAppSession({ ...options, binding, broker, policy, send, onClose: remove,
    onResize: size => { iframe.style.height = `${size.height}px`; options.onResize?.(size); } });
  const receive = event => {
    if (closed || event.source !== iframe.contentWindow || event.origin !== proxyUrl.origin) return;
    if (event.data?.method === 'ui/notifications/sandbox-proxy-ready') {
      if (loaded) return;
      loaded = true;
      void session.authorize({ kind: 'publish', uri: resource.uri }).then(() => {
        if (!closed) send({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: { html: resource.html, ...policy } });
      }).catch(() => session.revoke());
    } else void session.receive(event.data);
  };
  try {
    await session.authorize({ kind: 'render', uri: resource.uri });
    if (options.toolInput !== undefined) await session.setToolInput(options.toolInput);
    else if(options.toolResult!==undefined)await session.setToolInputUnavailable();
    if (options.toolResult !== undefined) await session.setToolResult(options.toolResult);
    const fragment = new URLSearchParams({ hostOrigin }); proxyUrl.hash = fragment.toString();
    iframe.src = proxyUrl.href;
    window_.addEventListener('message', receive);
    container.append(iframe);
  } catch (cause) { session.revoke(); throw cause; }
  return { iframe, session, setToolInput: value => session.setToolInput(value), setToolInputUnavailable:()=>session.setToolInputUnavailable(), setToolInputPartial: value => session.setToolInputPartial(value),
    setToolResult: value => session.setToolResult(value), setHostContext: value => session.setHostContext(value), cancel: reason => session.cancel(reason),
    revoke: () => session.revoke(), dispose: () => session.dispose() };
}
