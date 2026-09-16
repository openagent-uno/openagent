/**
 * Pure URL policy for Electron renderer and OS-external navigation.
 *
 * Desktop renderer content is always served from one exact loopback origin.
 * Keeping this module free of Electron imports makes the security boundary
 * independently testable in ordinary Node.
 */

export interface RendererUrlPolicy {
  readonly origin: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function createRendererUrlPolicy(baseUrl: string): RendererUrlPolicy {
  const parsed = parseUrl(baseUrl, 'renderer base URL');
  if (
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Renderer base URL must be an authenticated-free loopback http origin with a port');
  }
  return Object.freeze({ origin: parsed.origin });
}

/** True only for documents on the exact origin assigned to a BrowserWindow. */
export function isTrustedRendererUrl(rawUrl: string, policy: RendererUrlPolicy): boolean {
  if (!rawUrl || CONTROL_CHARACTER.test(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'http:' &&
      parsed.origin === policy.origin &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

/**
 * Construct a same-origin renderer target without allowing a renderer-owned
 * route string to become a scheme-relative or backslash navigation.
 */
export function buildRendererTarget(
  policy: RendererUrlPolicy,
  route?: string,
): URL {
  const value = route ?? '';
  if (
    CONTROL_CHARACTER.test(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.length > 16_384
  ) {
    throw new Error('Renderer route must be a relative same-origin route');
  }
  const target = new URL(value || '/', `${policy.origin}/`);
  if (!isTrustedRendererUrl(target.href, policy)) {
    throw new Error('Renderer route escaped its assigned origin');
  }
  return target;
}

/**
 * Return the canonical URL that may be handed to the operating system, or
 * null for dangerous/custom schemes. Renderer input never reaches
 * shell.openExternal without passing this function.
 */
export function safeExternalHttpUrl(rawUrl: string): string | null {
  if (!rawUrl || CONTROL_CHARACTER.test(rawUrl) || rawUrl.length > 16_384) return null;
  try {
    const parsed = new URL(rawUrl);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function parseUrl(value: string, label: string): URL {
  if (!value || CONTROL_CHARACTER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}
