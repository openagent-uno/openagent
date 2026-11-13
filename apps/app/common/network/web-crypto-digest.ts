/**
 * Pure-JS ``SubtleCrypto.digest`` for runtimes without Web Crypto (Hermes).
 *
 * ``@windwalker-io/srp`` hashes with ``crypto.subtle.digest`` whenever it
 * is not running under Node, so React Native needs this polyfill.
 * Kept free of native imports so it can be tested under Node.
 */
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';

const DIGESTS: Record<string, (data: Uint8Array) => Uint8Array> = {
  'SHA-1': sha1,
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512,
};

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data as ArrayBuffer);
}

export async function digest(
  algorithm: AlgorithmIdentifier,
  data: BufferSource,
): Promise<ArrayBuffer> {
  const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
  const fn = DIGESTS[name];
  if (!fn) throw new Error(`Unsupported digest algorithm: ${name}`);
  const out = fn(toBytes(data));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
