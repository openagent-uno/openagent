/**
 * Minimal ``crypto`` shim for React Native (Hermes).
 *
 * ``@windwalker-io/srp``'s bundled UMD has two code paths:
 *   1. Node — ``require('crypto').randomBytes``
 *   2. Browser — ``window.crypto.getRandomValues``
 *
 * On React Native neither ``require('crypto')`` (Node) nor
 * ``window.crypto`` (browser) exist out of the box. Metro redirects
 * ``require('crypto')`` to this file (covering path 1), and the
 * side-effect block below patches ``globalThis.crypto`` (covering
 * path 2) using expo-crypto's native random source.
 *
 * Additionally this file provides a synchronous ``createHash('sha256')``
 * and ``timingSafeEqual`` for the SRP protocol layer.
 */

import { getRandomBytes } from 'expo-crypto';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Hermes has no crypto.subtle; @noble/ed25519's *Async helpers need SHA-512.
ed25519.hashes.sha512 = sha512;
ed25519.hashes.sha512Async = async (message: Uint8Array) => sha512(message);

// Patch globalThis.crypto so the browser branch of @windwalker-io/srp
// (``window.crypto.getRandomValues``) works on React Native.
if (typeof globalThis.crypto === 'undefined') {
  (globalThis as any).crypto = {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const bytes = getRandomBytes(array.byteLength);
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
      return array;
    },
    randomUUID(): string {
      const b = getRandomBytes(16);
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const h = Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
}

export function randomBytes(n: number): Uint8Array {
  return getRandomBytes(n);
}

export function timingSafeEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
}

interface HashState {
  _data: number[];
  update(data: string | Uint8Array, encoding?: string): HashState;
  digest(encoding?: string): string | Uint8Array;
}

export function createHash(algorithm: string): HashState {
  if (algorithm !== 'sha256') {
    throw new Error(`crypto-shim: unsupported hash algorithm "${algorithm}"`);
  }
  const state: HashState = {
    _data: [],
    update(data: string | Uint8Array, _encoding?: string): HashState {
      if (typeof data === 'string') {
        for (let i = 0; i < data.length; i++) {
          state._data.push(data.charCodeAt(i));
        }
      } else {
        for (let i = 0; i < data.length; i++) {
          state._data.push(data[i]!);
        }
      }
      return state;
    },
    digest(encoding?: string): string | Uint8Array {
      const bytes = new Uint8Array(state._data);
      const hash = sha256sync(bytes);
      if (encoding === 'hex') {
        return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      return hash;
    },
  };
  return state;
}

function sha256sync(data: Uint8Array): Uint8Array {
  const K: number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = data.length * 8;
  const padLen = (data.length + 9 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  if (bitLen > 0xffffffff) {
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  }

  const W = new Int32Array(64);
  const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getInt32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(W[i - 15]!, 7) ^ ror(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = ror(W[i - 2]!, 17) ^ ror(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false);
  rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false); rv.setUint32(20, h5, false);
  rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
  return result;
}
