import { contentSecurityPolicy, normalizeCsp } from './protocol.mjs';

/** This response must be served on an origin with no product cookies, APIs or native bridge. */
export const SANDBOX_PROXY_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  // Do not place a default-src on the proxy: srcdoc inherits it, preventing
  // per-resource declared CSP from working. Frame/base restrictions are installed
  // from the trusted per-view policy before creating the inner frame.
  'Content-Security-Policy': "object-src 'none'",
});
function proxyMain(makePolicy, normalize) {
  const params = new URLSearchParams(location.hash.slice(1));
  const hostOrigin = params.get('hostOrigin');
  if (!hostOrigin || hostOrigin === 'null' || new URL(hostOrigin).origin !== hostOrigin || hostOrigin === location.origin) return;
  let guest = null;
  let loaded = false;
  const reserved = method => typeof method === 'string' && method.startsWith('ui/notifications/sandbox-');
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.origin === hostOrigin) {
      const frame = event.data;
      if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0') return;
      if (frame.method === 'ui/notifications/sandbox-resource-ready') {
        if (loaded || typeof frame.params?.html !== 'string' || frame.params.html.length > 2 * 1024 * 1024) return;
        let csp, policy;
        try { policy = normalize(frame.params.csp ?? {}); csp = makePolicy(policy); } catch { return; }
        // Enforce descendant navigation before any guest script can run. A guest's
        // own default-src cannot prevent it from navigating its containing frame.
        // Do not add default-src here: srcdoc must retain its per-resource policy.
        const navigation = document.createElement('meta');
        navigation.httpEquiv = 'Content-Security-Policy';
        navigation.content = "frame-src 'self'" + (policy.frameDomains.length ? ' ' + policy.frameDomains.join(' ') : '') +
          '; base-uri ' + (policy.baseUriDomains.length ? policy.baseUriDomains.join(' ') : "'none'");
        document.head.append(navigation);
        loaded = true;
        guest = document.createElement('iframe');
        guest.title = 'MCP App content';
        guest.setAttribute('sandbox', 'allow-scripts');
        const permissions = frame.params.permissions ?? {};
        const feature = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' };
        guest.allow = Object.entries(feature).map(([key, name]) => `${name} ${permissions[key] ? '*' : "'none'"}`).join('; ');
        guest.style.cssText = 'border:0;width:100%;height:100%;display:block';
        const escaped = csp.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        guest.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+escaped+'"><meta name="referrer" content="no-referrer"></head><body>'+frame.params.html+'</body></html>';
        document.body.replaceChildren(guest);
      } else if (!reserved(frame.method) && guest) guest.contentWindow.postMessage(frame, '*');
    } else if (guest && event.source === guest.contentWindow && event.origin === 'null') {
      const frame = event.data;
      if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0' || reserved(frame.method)) return;
      window.parent.postMessage(frame, hostOrigin);
    }
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, hostOrigin);
}
export function buildSandboxProxyHtml() {
  // Functions below are original dependency-free protocol code, not untrusted input.
  // Include the strict normalizer/error type needed by the CSP builder.
  const helpers = `const McpAppError=Error;const isRecord=v=>!!v&&typeof v==='object'&&!Array.isArray(v);const safeString=(v,m=512)=>typeof v==='string'&&v.length>0&&v.length<=m&&!/[\\u0000-\\u001f\\u007f]/u.test(v);const CSP_KEYS=['connectDomains','resourceDomains','frameDomains','baseUriDomains'];const normalizeCsp=${normalizeCsp.toString()};const contentSecurityPolicy=${contentSecurityPolicy.toString()};`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>MCP App sandbox</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>${helpers}(${proxyMain.toString()})(contentSecurityPolicy,normalizeCsp);</script></body></html>`;
}
