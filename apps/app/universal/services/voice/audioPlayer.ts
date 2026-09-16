/**
 * AudioQueuePlayer — sequential MP3 chunk playback for voice-mode replies.
 *
 * The gateway streams TTS audio as ``audio_chunk`` WS events, each a
 * base64 MP3 segment with a monotonically-increasing ``seq``. We
 * queue them in order and play one at a time using the browser's
 * built-in <audio> element + Blob URLs — robust, no MediaSource
 * Extensions gap-management bugs, ~150 LOC.
 *
 * State changes are surfaced via callbacks so the chat UI can
 * (a) soft-mute the mic while audio plays (echo cancellation isn't
 *     perfect when the speaker is loud) and
 * (b) show a "speaking" indicator on the assistant bubble.
 */

export interface AudioPlayerOptions {
  /** ``audio/mpeg`` by default — matches ElevenLabs ``mp3_44100_64``. */
  mime?: string;
  /** How many chunks to buffer before starting playback. Avoids stutter
   * on slow first-byte replies. */
  startupBuffer?: number;
  /** Called with ``true`` when playback starts, ``false`` when the
   * queue drains (or stop() is called). */
  onPlayingChange?: (playing: boolean) => void;
  /** Same edges as ``onPlayingChange`` but as a discriminated state —
   * the Voice screen reads this to switch SoundWaves into 'speaking'. */
  onStateChange?: (state: 'idle' | 'playing') => void;
  /** Per-chunk decode/playback failure. Receives the seq of the bad
   * chunk and the underlying MediaError code/message when available.
   * The player still advances to the next chunk; this callback exists
   * so the UI can flag degraded audio instead of confusing dead air. */
  onChunkError?: (info: { seq: number; reason: string }) => void;
}

interface _QueuedChunk {
  seq: number;
  blob: Blob;
}

export class AudioQueuePlayer {
  private mime: string;
  private startupBuffer: number;
  private onPlayingChange?: (playing: boolean) => void;
  private onStateChange?: (state: 'idle' | 'playing') => void;
  private onChunkError?: (info: { seq: number; reason: string }) => void;

  // Pending chunks indexed by seq so out-of-order deliveries (rare on
  // a single TCP WS but cheap to handle) play in the right order.
  private pending = new Map<number, Blob>();
  private nextSeq = 1;
  private endedAt = 0; // 0 means stream still open
  private totalChunks = 0;

  private current: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private isPlaying = false;
  private isStarted = false;

  constructor(opts: AudioPlayerOptions = {}) {
    this.mime = opts.mime ?? 'audio/mpeg';
    this.startupBuffer = Math.max(1, opts.startupBuffer ?? 2);
    this.onPlayingChange = opts.onPlayingChange;
    this.onStateChange = opts.onStateChange;
    this.onChunkError = opts.onChunkError;
  }

  /** Mark the start of a new turn. Resets state. */
  start(mime?: string) {
    this.stop(); // tear down anything still playing
    if (mime) this.mime = mime;
    this.pending.clear();
    this.nextSeq = 1;
    this.endedAt = 0;
    this.totalChunks = 0;
    this.isStarted = true;
  }

  /** Push a chunk into the queue. ``data`` is base64 of MP3 bytes. */
  enqueue(seq: number, data: string) {
    if (!this.isStarted) this.start();
    const bytes = decodeBase64(data);
    if (!bytes) return;
    // Cast: the Uint8Array we built holds an ArrayBuffer (not a
    // SharedArrayBuffer), but TS's strict typed-array generics
    // can't tell. Blob accepts the runtime value either way.
    const blob = new Blob([bytes as BlobPart], { type: this.mime });
    this.pending.set(seq, blob);
    void this.maybeAdvance();
  }

  /** Mark end of stream. Drain remaining chunks then fire onPlayingChange(false). */
  end(totalChunks: number) {
    this.endedAt = Date.now();
    this.totalChunks = totalChunks;
    void this.maybeAdvance();
  }

  /** Tear everything down — called on /stop, voice-mode-off, or new turn. */
  stop() {
    this.pending.clear();
    this.nextSeq = 1;
    this.endedAt = 0;
    this.totalChunks = 0;
    this.isStarted = false;
    if (this.current) {
      try {
        this.current.pause();
        this.current.src = '';
      } catch {
        // ignore
      }
      this.current = null;
    }
    if (this.currentUrl) {
      try { URL.revokeObjectURL(this.currentUrl); } catch { /* ignore */ }
      this.currentUrl = null;
    }
    if (this.isPlaying) {
      this.isPlaying = false;
      this.onPlayingChange?.(false);
      this.onStateChange?.('idle');
    }
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  // ── internals ─────────────────────────────────────────────────────

  private async maybeAdvance() {
    // Already playing one — onended will trigger the next call.
    if (this.current) return;
    // Honor the startup buffer: wait until we have ``startupBuffer``
    // chunks queued (or the stream ended, whichever comes first).
    if (
      !this.endedAt &&
      this.pending.size < this.startupBuffer &&
      this.nextSeq === 1
    ) {
      return;
    }

    const blob = this.pending.get(this.nextSeq);
    if (!blob) {
      // Sequence gap. If the stream ended and we've drained everything
      // we have, finalize. Otherwise wait — the chunk may still arrive.
      if (this.endedAt && this.pending.size === 0) {
        if (this.isPlaying) {
          this.isPlaying = false;
          this.onPlayingChange?.(false);
          this.onStateChange?.('idle');
        }
        this.isStarted = false;
      }
      return;
    }

    const playingSeq = this.nextSeq;
    this.pending.delete(this.nextSeq);
    this.nextSeq += 1;

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.onPlayingChange?.(true);
      this.onStateChange?.('playing');
    }

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.current = audio;
    this.currentUrl = url;
    audio.onended = () => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      this.current = null;
      this.currentUrl = null;
      void this.maybeAdvance();
    };
    audio.onerror = () => {
      const mediaErr = audio.error;
      const reason = mediaErr
        ? `MediaError code=${mediaErr.code}${mediaErr.message ? `: ${mediaErr.message}` : ''}`
        : 'audio element errored without a MediaError';
      console.warn(`[audio] chunk seq=${playingSeq} failed — ${reason}; skipping`);
      this.onChunkError?.({ seq: playingSeq, reason });
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      this.current = null;
      this.currentUrl = null;
      // Skip the bad chunk, keep going.
      void this.maybeAdvance();
    };
    try {
      await audio.play();
    } catch (err) {
      // Most likely a no-user-gesture rejection (Safari/Chrome
      // autoplay policy). Surface the failure so the user can see why
      // they hear nothing — the previous silent catch hid this for
      // months. Once the user clicks anywhere on the page audio plays
      // normally for the rest of the session.
      const name = (err as Error)?.name || 'PlaybackError';
      const reason = (err as Error)?.message || String(err);
      console.warn(
        `[audio] play() rejected (${name}): ${reason} — likely browser ` +
        'autoplay policy. Click anywhere on the page to enable audio.',
      );
    }
  }
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    }
    // Fallback for environments without atob (rare).
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  } catch {
    return null;
  }
}
