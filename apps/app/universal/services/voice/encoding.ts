/**
 * Byte-encoding helpers shared by the voice + chat tabs.
 *
 * AudioWorklet PCM frames are ~2 KB each so the chunked loop never
 * approaches the call-stack limit, but the chunked guard stays as
 * insurance for the WebM-fallback path which ships full-utterance
 * blobs that can be multi-MB on long voice notes.
 */

/** Encode raw bytes to base64 (no data-URI prefix). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

/** Encode a Blob's bytes to base64 (no data-URI prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}
