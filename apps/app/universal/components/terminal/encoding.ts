/**
 * Base64 ⇆ bytes helpers for the terminal wire.
 *
 * Terminal I/O is binary (UTF-8 plus raw control sequences), so the
 * gateway carries it as base64 strings on the JSON WebSocket. These
 * helpers convert between a JS string / Uint8Array and base64 without
 * depending on ``Buffer`` (absent in the browser) — they prefer the
 * platform ``btoa``/``atob`` + ``TextEncoder`` when present (web,
 * Electron, Hermes) and fall back to pure-JS implementations so the
 * native bundle works even where those globals are missing.
 */

const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const _textEncoder: TextEncoder | null =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** Encode a JS string as UTF-8 bytes. */
function utf8Bytes(str: string): Uint8Array {
  if (_textEncoder) return _textEncoder.encode(str);
  // Manual UTF-8 fallback (covers the BMP + surrogate pairs).
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** Encode raw bytes as a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const CHUNK = 0x8000; // avoid blowing the arg stack on big outputs
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  // Pure-JS fallback.
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

/** Decode a base64 string back into raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Pure-JS fallback.
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const e0 = B64_CHARS.indexOf(clean[i]);
    const e1 = B64_CHARS.indexOf(clean[i + 1]);
    const e2 = B64_CHARS.indexOf(clean[i + 2]);
    const e3 = B64_CHARS.indexOf(clean[i + 3]);
    out[p++] = (e0 << 2) | (e1 >> 4);
    if (e2 !== -1) out[p++] = ((e1 & 0x0f) << 4) | (e2 >> 2);
    if (e3 !== -1) out[p++] = ((e2 & 0x03) << 6) | e3;
  }
  return out;
}

/** Encode a JS string (terminal keystrokes) as base64 of its UTF-8 bytes. */
export function stringToBase64(str: string): string {
  return bytesToBase64(utf8Bytes(str));
}
