/**
 * VoiceLoop — always-on mic with simple energy-based VAD.
 *
 * Browser-only (web + Electron). Native RN doesn't have a battle-tested
 * VAD library yet, so the chat UI hides the voice-mode toggle on
 * non-web platforms.
 *
 * Approach: ``getUserMedia`` with browser AEC enabled, fed into an
 * ``AnalyserNode`` we sample every ~30ms for RMS energy. A small state
 * machine tracks "silent → speech → silent" transitions.
 *
 * Two capture pipelines, picked at construction time:
 *
 *   - **PCM streaming (preferred)**: when ``onPcmChunk`` is supplied
 *     and ``AudioWorklet`` is available, the same MediaStream feeds an
 *     AudioWorkletNode that emits 16 kHz mono Int16 frames. ``onPcmChunk``
 *     fires live during speech windows. Server-side StreamSession either
 *     wraps these in a WAV header (Whisper/LiteLLM) or passes them
 *     straight to Deepgram WS for sub-1 s TTFA partials.
 *   - **WebM full-blob fallback**: when ``onPcmChunk`` is absent (or
 *     AudioWorklet isn't supported), VoiceLoop uses MediaRecorder
 *     without timeslice — ``onUtterance`` fires once at speech_end with
 *     the complete WebM blob. Reliable across all backends, no live
 *     partials.
 *
 * Echo handling is the caller's responsibility: while the agent's TTS
 * reply is playing, call ``setMuted(true)`` so loud speakers don't
 * trigger speech-start despite the browser's AEC. Mute also pauses PCM
 * forwarding so the assistant's voice doesn't bleed into Deepgram.
 *
 * If the mic is denied or yanked mid-conversation, ``onMicError`` fires
 * once with a stable reason; the caller surfaces a toast and falls back
 * to the text input.
 */
import { PCMStreamCapture, type PCMStreamHandle } from './pcmCapture';

export interface VoiceLoopOptions {
  /** RMS energy above which a frame is considered "loud". 0..1.
   * Default 0.025 — works for most laptop mics in quiet rooms. */
  speechThreshold?: number;
  /** RMS energy below which a frame is considered "quiet". 0..1. */
  silenceThreshold?: number;
  /** Consecutive frames above ``speechThreshold`` to fire speech-start. */
  speechFrames?: number;
  /** Consecutive frames below ``silenceThreshold`` to fire speech-end. */
  silenceFrames?: number;
  /** Hard cap on a single utterance (ms). Helps if VAD wedges. */
  maxUtteranceMs?: number;
  /** Discard utterances shorter than this (ms). Filters out clicks. */
  minUtteranceMs?: number;

  onUtterance: (blob: Blob) => void | Promise<void>;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onMicError?: (reason: 'permission' | 'disconnected' | 'unavailable', error?: unknown) => void;
  /** Smoothed mic RMS (0..1), fired ~every tick (30ms). The Voice screen
   * uses this to drive the SoundWaves equalizer. ``muted`` ticks emit 0
   * so the bars settle while TTS is playing. */
  onEnergy?: (level: number) => void;
  /** When set AND AudioWorklet is supported, VoiceLoop uses raw PCM
   * streaming instead of MediaRecorder. ``onPcmChunk`` fires during
   * speech windows with ~64 ms of 16 kHz mono Int16 samples. The Voice
   * screen ships each frame as ``audio_chunk_in`` (encoding=pcm16) so
   * Deepgram WS gets live frames for sub-1 s TTFA partials, while
   * Whisper-class backends server-side buffer the whole utterance and
   * wrap with a WAV header before transcribing. Falls back to the
   * MediaRecorder/onUtterance path automatically when AudioWorklet is
   * unavailable. */
  onPcmChunk?: (chunk: Int16Array, info: { sampleRate: number; first: boolean }) => void | Promise<void>;
}

// Conservative defaults tuned for a quiet desk mic with typing/fan
// noise — bumped from the original 0.025/0.012/3/25 after early users
// reported false starts on keyboard clicks. Override per-instance via
// VoiceLoopOptions (the Settings tab exposes these as live tunables).
const DEFAULTS = {
  speechThreshold: 0.050,
  silenceThreshold: 0.020,
  speechFrames: 5,        // ~150ms above threshold
  silenceFrames: 35,      // ~1050ms below threshold (natural sentence end)
  maxUtteranceMs: 30_000,
  minUtteranceMs: 350,
};

export class VoiceLoop {
  private opts: Required<Pick<VoiceLoopOptions,
    'speechThreshold' | 'silenceThreshold' | 'speechFrames' | 'silenceFrames'
    | 'maxUtteranceMs' | 'minUtteranceMs'>>;
  private onUtterance: VoiceLoopOptions['onUtterance'];
  private onSpeechStart?: () => void;
  private onSpeechEnd?: () => void;
  private onMicError?: VoiceLoopOptions['onMicError'];
  private onEnergy?: VoiceLoopOptions['onEnergy'];
  private onPcmChunk?: VoiceLoopOptions['onPcmChunk'];
  private pcm: PCMStreamHandle | null = null;
  private pcmFirstSent = false;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array | null = null;
  private rafId: number | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recordingMime = 'audio/webm';
  private recordingStartedAt = 0;

  private inSpeech = false;
  private aboveCount = 0;
  private belowCount = 0;
  private muted = false;
  private running = false;
  private trackEndedListener: (() => void) | null = null;
  private errored = false;

  constructor(options: VoiceLoopOptions) {
    this.opts = {
      speechThreshold: options.speechThreshold ?? DEFAULTS.speechThreshold,
      silenceThreshold: options.silenceThreshold ?? DEFAULTS.silenceThreshold,
      speechFrames: options.speechFrames ?? DEFAULTS.speechFrames,
      silenceFrames: options.silenceFrames ?? DEFAULTS.silenceFrames,
      maxUtteranceMs: options.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs,
      minUtteranceMs: options.minUtteranceMs ?? DEFAULTS.minUtteranceMs,
    };
    this.onUtterance = options.onUtterance;
    this.onSpeechStart = options.onSpeechStart;
    this.onSpeechEnd = options.onSpeechEnd;
    this.onMicError = options.onMicError;
    this.onEnergy = options.onEnergy;
    this.onPcmChunk = options.onPcmChunk;
  }

  /** True iff the live PCM streaming path is active for this loop.
   * False means the loop falls back to MediaRecorder + onUtterance. */
  get usingPcmStream(): boolean {
    return this.pcm !== null;
  }

  async start(): Promise<boolean> {
    if (this.running) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.fail('unavailable');
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.fail('permission', err);
      return false;
    }

    const tracks = this.stream.getAudioTracks();
    if (tracks.length === 0) {
      this.fail('unavailable');
      return false;
    }
    this.trackEndedListener = () => {
      // Mic yanked mid-conversation (USB unplug, OS revocation, etc.).
      this.fail('disconnected');
    };
    tracks[0].addEventListener('ended', this.trackEndedListener);

    const Ctor = (window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) {
      this.fail('unavailable');
      return false;
    }
    this.context = new Ctor();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    this.buffer = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);

    // Try the AudioWorklet PCM path first (live frames → server STT).
    // Fall back to MediaRecorder when AudioWorklet is missing or the
    // caller didn't supply ``onPcmChunk``. Both pipelines share the same
    // MediaStream + AudioContext, so the PCM worklet runs in parallel
    // to the analyser without doubling the mic open.
    if (this.onPcmChunk && PCMStreamCapture.isSupported()) {
      try {
        this.pcm = await PCMStreamCapture.attach(
          this.stream,
          this.context,
          (frame) => {
            const cb = this.onPcmChunk;
            if (!cb) return;
            const first = !this.pcmFirstSent;
            this.pcmFirstSent = true;
            try {
              void cb(frame, {
                sampleRate: PCMStreamCapture.TARGET_SAMPLE_RATE,
                first,
              });
            } catch {
              // Don't let a slow handler stall the worklet thread.
            }
          },
        );
      } catch (err) {
        // AudioWorklet attach failed (CSP, permissions, etc.) — fall
        // back to MediaRecorder. Surface as an error log but keep the
        // mic running; voice mode degrades gracefully.
        console.warn('[voice] PCM stream attach failed, falling back:', err);
        this.pcm = null;
      }
    }

    this.recordingMime = pickRecorderMime();
    this.running = true;
    this.timerId = setInterval(() => this.tick(), 30);
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this.recorder = null;
    this.chunks = [];
    if (this.pcm) {
      try { this.pcm.detach(); } catch { /* ignore */ }
      this.pcm = null;
    }
    this.pcmFirstSent = false;
    if (this.stream) {
      const tracks = this.stream.getAudioTracks();
      if (this.trackEndedListener && tracks[0]) {
        tracks[0].removeEventListener('ended', this.trackEndedListener);
      }
      tracks.forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      this.stream = null;
    }
    if (this.context && this.context.state !== 'closed') {
      try { void this.context.close(); } catch { /* ignore */ }
    }
    this.context = null;
    this.analyser = null;
    this.buffer = null;
    this.trackEndedListener = null;
    this.inSpeech = false;
    this.aboveCount = 0;
    this.belowCount = 0;
  }

  /** Pause speech detection while the agent's TTS is playing.
   * The mic stream stays open so re-arming has zero latency. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    // While muted, the PCM worklet keeps decoding frames in the
    // background but ``setActive(false)`` discards them — prevents
    // the assistant's own voice from bleeding into the STT pump.
    if (this.pcm) this.pcm.setActive(!muted && this.inSpeech);
    if (muted && this.inSpeech) {
      // Drop any in-flight utterance — we don't want to upload our own
      // playback as user speech.
      this.aboveCount = 0;
      this.belowCount = 0;
      this.inSpeech = false;
      if (this.recorder && this.recorder.state !== 'inactive') {
        try { this.recorder.stop(); } catch { /* ignore */ }
      }
      this.chunks = [];
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private fail(reason: 'permission' | 'disconnected' | 'unavailable', err?: unknown): void {
    if (this.errored) return;
    this.errored = true;
    this.stop();
    this.onMicError?.(reason, err);
  }

  private tick(): void {
    if (!this.running || !this.analyser || !this.buffer) return;
    if (this.muted) {
      // Settle the visualizer while TTS plays.
      this.onEnergy?.(0);
      return;
    }
    // The buffer is a Float32Array<ArrayBuffer> at runtime; TS strict
    // mode infers the wider ``ArrayBufferLike`` because typed-array
    // constructors accept SharedArrayBuffer. Cast for the API call.
    this.analyser.getFloatTimeDomainData(this.buffer as Float32Array<ArrayBuffer>);
    const rms = computeRMS(this.buffer);
    this.onEnergy?.(rms);
    if (rms >= this.opts.speechThreshold) {
      this.aboveCount += 1;
      this.belowCount = 0;
    } else if (rms <= this.opts.silenceThreshold) {
      this.belowCount += 1;
      this.aboveCount = 0;
    } else {
      // Hysteresis band — don't flip either way.
    }

    if (!this.inSpeech) {
      if (this.aboveCount >= this.opts.speechFrames) {
        this.inSpeech = true;
        this.recordingStartedAt = Date.now();
        if (this.pcm) {
          // PCM streaming path: just toggle the gate — the worklet has
          // been emitting frames in the background since start().
          this.pcmFirstSent = false;
          this.pcm.setActive(true);
        } else {
          this.beginRecording();
        }
        this.onSpeechStart?.();
      }
    } else {
      const elapsed = Date.now() - this.recordingStartedAt;
      if (this.belowCount >= this.opts.silenceFrames || elapsed >= this.opts.maxUtteranceMs) {
        this.inSpeech = false;
        this.onSpeechEnd?.();
        if (this.pcm) {
          // Stop forwarding live PCM. The Voice screen sends
          // ``audio_end_in`` itself in onSpeechEnd to close the STT
          // window server-side.
          this.pcm.setActive(false);
        } else {
          void this.endRecording(elapsed);
        }
      }
    }
  }

  private beginRecording(): void {
    if (!this.stream) return;
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType: this.recordingMime });
    } catch {
      // Some browsers reject explicit mimeType — fall back to default.
      try {
        this.recorder = new MediaRecorder(this.stream);
      } catch {
        return;
      }
    }
    const recorder = this.recorder;
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this.chunks.push(e.data);
    };
    // No timeslice: a single ``ondataavailable`` fires when ``stop()``
    // flushes the complete WebM file. Partial timeslice chunks omit
    // the EBML header on every frame after the first and don't
    // round-trip through ffmpeg cleanly.
    recorder.start();
  }

  private async endRecording(elapsedMs: number): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    if (recorder.state === 'inactive') {
      // Already stopped (e.g. mute mid-utterance). Drop chunks.
      this.chunks = [];
      return;
    }
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      try { recorder.stop(); } catch { resolve(); }
    });
    if (elapsedMs < this.opts.minUtteranceMs) {
      this.chunks = [];
      return;
    }
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: recorder.mimeType || this.recordingMime });
    this.chunks = [];
    try {
      await this.onUtterance(blob);
    } catch {
      // Caller decides how to surface upload errors. Keep listening.
    }
  }
}

function computeRMS(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = buf[i];
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  // Try a few in priority order — Whisper accepts all of these via
  // the existing /api/upload path.
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const mt of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mt)) return mt;
    } catch { /* ignore */ }
  }
  return 'audio/webm';
}
