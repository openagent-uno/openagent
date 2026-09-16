/** Pure Electron renderer security policy, isolated for unit testing. */

export const DEFAULT_DEV_SERVER_PORT = 8081;

/**
 * Resolve the optional development renderer port without allowing the
 * environment to influence the protocol, hostname, path, or credentials.
 * Invalid overrides fail closed instead of silently loading an unexpected
 * origin.
 */
export function resolveDevServerUrl(rawPort: string | undefined): string {
  if (rawPort === undefined) {
    return `http://localhost:${DEFAULT_DEV_SERVER_PORT}`;
  }
  if (!/^[0-9]+$/.test(rawPort)) {
    throw new Error('OPENAGENT_DEV_SERVER_PORT must be an integer between 1 and 65535');
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('OPENAGENT_DEV_SERVER_PORT must be an integer between 1 and 65535');
  }
  return `http://localhost:${port}`;
}

export const PRODUCTION_CSP = [
  "default-src 'self'",
  // Expo's exported bundle is self-hosted. Blob is required by the existing
  // AudioWorklet PCM capture; there is no unsafe-eval.
  "script-src 'self' blob:",
  // React Native Web and the Expo reset emit inline style attributes/tags.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  // Custom Views resolve images through authenticated artifact/asset routes;
  // the renderer never fetches arbitrary remote pixels.
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "media-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function isAllowedExternalUrl(raw: string): boolean {
  if (!raw || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol === 'mailto:') return !url.username && !url.password;
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !!url.hostname
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function isAllowedRendererNavigation(raw: string, appOrigin: string): boolean {
  try {
    const target = new URL(raw);
    const origin = new URL(appOrigin);
    return target.origin === origin.origin && (target.protocol === 'http:' || target.protocol === 'https:');
  } catch {
    return false;
  }
}
