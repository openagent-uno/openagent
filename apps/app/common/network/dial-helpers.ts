/**
 * Dial timeout + retry for transient iroh discovery failures — portable.
 *
 * Uses the abstract ``TransportEndpoint`` / ``TransportConnection`` so
 * the same retry logic works over both the Node.js iroh addon and the
 * Swift iroh-ffi bridge.
 */
import type { TransportConnection, TransportEndpoint, TransportNodeAddr } from './transport-types';

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
  endpoint: TransportEndpoint,
  nodeAddr: TransportNodeAddr,
  alpn: Uint8Array,
  timeoutMs: number,
): Promise<TransportConnection> {
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
  endpoint: TransportEndpoint,
  nodeAddr: TransportNodeAddr,
  alpn: Uint8Array,
  timeoutMs: number = DEFAULT_DIAL_TIMEOUT_MS,
): Promise<TransportConnection> {
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
