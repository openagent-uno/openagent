/**
 * Coordinator RPC over a bi-directional stream — portable edition.
 *
 * Uses the abstract ``TransportConnection`` interface so the same code
 * runs over both the Node.js ``@number0/iroh`` addon (desktop) and the
 * Swift iroh-ffi bridge (iOS native module).
 *
 * Wire format: u32(4, big-endian length) || CBOR{id, method, params}.
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor2';
import type { TransportConnection, TransportSendStream, TransportRecvStream } from './transport-types';

export const COORDINATOR_ALPN = new TextEncoder().encode('openagent/coordinator/1');
export const GATEWAY_ALPN = new TextEncoder().encode('openagent/gateway/1');

const DEFAULT_MAX_RESPONSE = 1 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'RpcError';
  }
}

export interface RpcOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

export async function rpcCall(
  connection: TransportConnection,
  method: string,
  params: Record<string, unknown>,
  opts: RpcOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE;
  const bi = await connection.openBi();
  const send = bi.send;
  const recv = bi.recv;

  try {
    const requestId = generateRequestId();
    const requestPayload = cborEncode({ id: requestId, method, params });
    await writeFrame(send, requestPayload);
    if (typeof send.finish === 'function') {
      await send.finish();
    }
    const responseBytes = await withTimeout(
      readFrame(recv, maxResponseBytes),
      timeoutMs,
      `RPC ${method} timed out after ${timeoutMs}ms`,
    );
    let decoded: unknown;
    try {
      decoded = cborDecode(responseBytes);
    } catch (e) {
      throw new RpcError('decode_error', `coordinator response isn't valid CBOR: ${(e as Error).message}`);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || decoded instanceof Uint8Array) {
      throw new RpcError('protocol_error', `coordinator returned non-map response (${typeof decoded})`);
    }
    const map = decoded as Record<string, unknown>;
    if ('error' in map) {
      const err = (map.error ?? {}) as Record<string, unknown>;
      throw new RpcError(
        String(err.code ?? 'unknown'),
        String(err.message ?? ''),
      );
    }
    if (!('result' in map)) {
      throw new RpcError('protocol_error', "coordinator response had neither 'result' nor 'error'");
    }
    const result = map.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) || result instanceof Uint8Array) {
      throw new RpcError('protocol_error', `coordinator result is not a map (${typeof result})`);
    }
    return result as Record<string, unknown>;
  } finally {
    try {
      connection.close(0n, new Uint8Array());
    } catch {
      // ignore
    }
  }
}

async function writeFrame(send: TransportSendStream, payload: Uint8Array): Promise<void> {
  const buf = new Uint8Array(4 + payload.length);
  new DataView(buf.buffer).setUint32(0, payload.length, false);
  buf.set(payload, 4);
  await send.writeAll(buf);
}

async function readFrame(
  recv: TransportRecvStream,
  maxBytes: number,
): Promise<Uint8Array> {
  const lenBuf = await readExact(recv, 4);
  const length = new DataView(lenBuf.buffer).getUint32(0, false);
  if (length > maxBytes) {
    throw new RpcError('protocol_error', `coordinator response too large: ${length} > ${maxBytes}`);
  }
  return readExact(recv, length);
}

async function readExact(
  recv: TransportRecvStream,
  n: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let written = 0;
  while (written < n) {
    const chunk = new Uint8Array(n - written);
    const got = await recv.read(chunk);
    if (got === null || got === 0n) {
      throw new RpcError('protocol_error', 'coordinator stream closed mid-frame');
    }
    const gotN = Number(got);
    out.set(chunk.subarray(0, gotN), written);
    written += gotN;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new RpcError('timeout', label)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
