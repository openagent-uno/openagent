/**
 * Bound every iroh ``endpoint.connect()`` with a wall-clock budget AND a
 * retry layer for transient discovery failures.
 *
 * The iroh-js bindings don't take an AbortSignal, so a hung dial used to
 * hang the whole login chain forever (no error, no UI feedback). This
 * wrapper:
 *
 *  - rejects with ``DialTimeoutError`` once the total budget elapses,
 *  - retries on transient discovery errors (``Discovery produced no
 *    results``, ``No addressing information``, ``Discovery service
 *    failed``) — those fire briefly during cold-start when pkarr DNS
 *    or mDNS hasn't yet found the peer; a 500ms / 1s / 2s backoff is
 *    typically enough,
 *  - propagates non-transient errors (cert / ALPN / handshake) immediately
 *    so real failures still surface,
 *  - lets a late-resolving dial self-clean (closed instead of leaked).
 */
import type { IrohConnection, IrohEndpoint, IrohNodeAddr } from './iroh-types.js';

export const DEFAULT_DIAL_TIMEOUT_MS = 20_000;

const TRANSIENT_DISCOVERY_PATTERNS = [
  'Discovery produced no results',
  'No addressing information',
  'Discovery service failed',
];

const RETRY_BACKOFFS_MS = [500, 1000, 2000];

export class DialTimeoutError extends Error {
  readonly nodeId: string;
  readonly timeoutMs: number;
  constructor(nodeId: string, timeoutMs: number) {
    super(`iroh dial to ${nodeId.slice(0, 12)}… timed out after ${timeoutMs}ms`);
    this.name = 'DialTimeoutError';
    this.nodeId = nodeId;
    this.timeoutMs = timeoutMs;
  }
}

function isTransientDiscoveryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_DISCOVERY_PATTERNS.some((p) => msg.includes(p));
}

async function raceOneDial(
  endpoint: IrohEndpoint,
  nodeAddr: IrohNodeAddr,
  alpn: Uint8Array,
  timeoutMs: number,
): Promise<IrohConnection> {
  const dialPromise = endpoint.connect(nodeAddr, alpn);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new DialTimeoutError(nodeAddr.nodeId, timeoutMs));
    }, timeoutMs);
  });

  dialPromise.then(
    (conn) => {
      if (timedOut) {
        try { conn.close(0n, new Uint8Array()); } catch { /* ignore */ }
      }
    },
    () => { /* error already surfaced via race */ },
  );

  try {
    return await Promise.race([dialPromise, timeoutPromise]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export async function dialWithTimeout(
  endpoint: IrohEndpoint,
  nodeAddr: IrohNodeAddr,
  alpn: Uint8Array,
  timeoutMs: number = DEFAULT_DIAL_TIMEOUT_MS,
): Promise<IrohConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let attempt = 0;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      return await raceOneDial(endpoint, nodeAddr, alpn, remaining);
    } catch (err) {
      lastErr = err;
      if (!isTransientDiscoveryError(err)) throw err;
      const backoff = RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)];
      attempt += 1;
      if (Date.now() + backoff >= deadline) break;
      console.warn(
        `[iroh] discovery miss for ${nodeAddr.nodeId.slice(0, 12)}…, retrying in ${backoff}ms (attempt ${attempt})`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastErr ?? new DialTimeoutError(nodeAddr.nodeId, timeoutMs);
}
