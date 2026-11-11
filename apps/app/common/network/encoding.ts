/**
 * Portable binary encoding helpers. Replaces ``Buffer.from(hex, 'hex')``
 * and ``buf.toString('hex')`` so the protocol code works in both Node.js
 * (desktop) and React Native (Hermes) without a ``Buffer`` polyfill.
 */

const HEX_TABLE = '0123456789abcdef';

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += HEX_TABLE[b[i] >> 4] + HEX_TABLE[b[i] & 0xf];
  }
  return s;
}

export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex length is odd: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < b.length; i++) binary += String.fromCharCode(b[i]);
    return btoa(binary);
  }
  return Buffer.from(b).toString('base64');
}

export function base64ToBytes(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}
