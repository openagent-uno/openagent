/**
 * pcmCapture — AudioWorklet-based raw 16 kHz mono PCM capture.
 *
 * The MediaRecorder path produces WebM/Opus chunks that only concatenate
 * cleanly when ``.stop()`` flushes the full file — partial timeslice
 * chunks miss the EBML header on every frame after the first, so
 * ffmpeg/Whisper can't parse them. PCM is the opposite: every byte is
 * standalone audio data, chunks concatenate trivially, and the server
 * can either wrap them in a 44-byte WAV header for batch STT (Whisper /
 * LiteLLM) or pass them straight to Deepgram's WS with
 * ``encoding=linear16&sample_rate=16000`` for live partials in ~150 ms.
 *
 * The worklet runs in a dedicated audio thread (no main-thread jank),
 * downsamples from the AudioContext's native rate (typically 48 kHz)
 * to 16 kHz, converts Float32 → Int16, and posts ~64 ms chunks back
 * via ``port.postMessage``. The processor source is inlined as a Blob
 * URL so we don't need a static asset served by the dev server.
 *
 * Web/Electron only — React Native AudioContext doesn't expose
 * AudioWorklet. ``isSupported()`` lets the caller fall back cleanly.
 */

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1024; // 64 ms at 16 kHz

// Worklet source — runs in a dedicated audio thread (AudioWorkletGlobalScope).
// We build it as a joined-array string rather than a TS template literal: the
// JS body uses ``${...}`` placeholders for the substituted constants, but
// those would be interpreted as TS template-literal substitutions (whose
// expressions then have to be parseable TS), turning the whole worklet body
// into a TS expression context. Plain strings keep the worklet content
// opaque to the TS parser. The 16000 / 1024 constants are duplicated below
// intentionally — they're the values from ``TARGET_SAMPLE_RATE`` /
// ``FRAME_SAMPLES`` at the top of this file.
const WORKLET_SOURCE = [
  "class PCMProcessor extends AudioWorkletProcessor {",
  "  constructor(options) {",
  "    super();",
  "    const opts = (options && options.processorOptions) || {};",
  "    this.target = opts.target || 16000;",
  "    this.frame = opts.frame || 1024;",
  "    // sampleRate is a global in AudioWorkletGlobalScope reflecting",
  "    // the parent AudioContext's rate (typically 48000).",
  "    this.ratio = sampleRate / this.target;",
  "    this.buffer = new Int16Array(this.frame);",
  "    this.idx = 0;",
  "    this.accum = 0;",
  "  }",
  "  process(inputs) {",
  "    const input = inputs[0];",
  "    if (!input || !input[0]) return true;",
  "    const ch = input[0];",
  "    for (let i = 0; i < ch.length; i++) {",
  "      this.accum += 1;",
  "      if (this.accum >= this.ratio) {",
  "        this.accum -= this.ratio;",
  "        const s = Math.max(-1, Math.min(1, ch[i]));",
  "        this.buffer[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7fff;",
  "        if (this.idx >= this.buffer.length) {",
  "          this.port.postMessage(this.buffer.slice(0));",
  "          this.idx = 0;",
  "        }",
  "      }",
  "    }",
  "    return true;",
  "  }",
  "}",
  "registerProcessor('pcm-processor', PCMProcessor);",
].join("\n");

export interface PCMStreamHandle {
  /** Toggle live forwarding. The worklet keeps emitting frames in the
   *  background; ``setActive(true)`` enables the onChunk callback,
   *  ``false`` silently discards. Used by VAD: enable on speech_start,
   *  disable on speech_end (or while TTS plays, to prevent echo). */
  setActive(active: boolean): void;
  /** Tear down the worklet + source nodes. The shared AudioContext is
   *  not closed — the caller (VoiceLoop) owns it. */
  detach(): void;
  readonly sampleRate: number;
}

export class PCMStreamCapture {
  static readonly TARGET_SAMPLE_RATE = TARGET_SAMPLE_RATE;

  /** ``AudioWorkletNode`` is the gating capability. Browsers without it
   *  (very old Safari, some webviews) fall back to the MediaRecorder
   *  full-blob path in voice.tsx. */
  static isSupported(): boolean {
    return (
      typeof AudioWorkletNode !== 'undefined'
      && typeof AudioContext !== 'undefined'
    );
  }

  /** Attach to an existing MediaStream + AudioContext. Returns a
   *  handle for live control. The context is NOT closed on detach —
   *  the caller (VoiceLoop) created it and owns its lifecycle. */
  static async attach(
    stream: MediaStream,
    context: AudioContext,
    onChunk: (frame: Int16Array) => void,
  ): Promise<PCMStreamHandle> {
    // Inline the worklet source via Blob URL so we don't need a static
    // asset served by Expo's dev server. ``addModule`` resolves once
    // the worker has loaded the processor.
    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    try {
      await context.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, 'pcm-processor', {
      processorOptions: { target: TARGET_SAMPLE_RATE, frame: FRAME_SAMPLES },
    });

    let active = false;
    worklet.port.onmessage = (e: MessageEvent) => {
      if (!active) return;
      try {
        onChunk(e.data as Int16Array);
      } catch {
        // Don't let a slow handler back-pressure the audio thread.
      }
    };

    source.connect(worklet);
    // The worklet doesn't need to connect to ``context.destination`` —
    // we only want the postMessage stream, not playback.

    return {
      sampleRate: TARGET_SAMPLE_RATE,
      setActive: (on: boolean) => {
        active = on;
      },
      detach: () => {
        active = false;
        try { worklet.port.onmessage = null; } catch { /* ignore */ }
        try { source.disconnect(); } catch { /* ignore */ }
        try { worklet.disconnect(); } catch { /* ignore */ }
      },
    };
  }
}
