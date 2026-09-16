/**
 * Voice tunables — client-side VAD thresholds for the Voice tab.
 *
 * Persisted to localStorage on web so you don't need to re-tune on
 * every reload. Native RN ignores persistence (the Voice tab degrades
 * to text-only there anyway). Defaults match
 * ``services/voice/voiceLoop.ts:DEFAULTS`` — keep in sync if you tune
 * one without the other.
 */

import { create } from 'zustand';

export interface VoiceConfig {
  /** RMS energy above which a frame is "loud" (0..1). */
  speechThreshold: number;
  /** RMS energy below which a frame is "quiet" (0..1). */
  silenceThreshold: number;
  /** Consecutive loud frames to fire speech-start (~30ms each). */
  speechFrames: number;
  /** Consecutive quiet frames to fire speech-end. */
  silenceFrames: number;
  /** Hard cap on a single utterance, ms. */
  maxUtteranceMs: number;
  /** Discard utterances shorter than this, ms. Filters out clicks. */
  minUtteranceMs: number;
  /** ISO-639-1 code passed to the STT backend, or empty for auto-detect.
   * Whisper's auto-detect on the ``base`` model is unreliable for short
   * utterances and has misidentified Italian as Cyrillic — set this if
   * you always speak the same language. */
  language: string;
  /** When true, the Chat tab mounts the same continuous mic + VAD loop
   * the Voice tab uses. Each utterance lands in the active chat as a
   * ``text_final(source='stt')`` so the StreamSession routes it through
   * the instant-barge-in path AND speaks the reply (mirror-modality
   * rule on the server side). Off by default — explicit opt-in. */
  chatAlwaysListen: boolean;
}

export const VOICE_DEFAULTS: VoiceConfig = {
  speechThreshold: 0.050,
  silenceThreshold: 0.020,
  speechFrames: 5,
  silenceFrames: 35,
  maxUtteranceMs: 30_000,
  minUtteranceMs: 350,
  // Intentionally empty as the *fallback* default — `loadFromStorage`
  // overrides this with `detectBrowserLanguage()` on first run so an
  // Italian/Spanish/French user gets the right language hint without
  // visiting Settings → Voice. Empty here only kicks in when the
  // browser has no resolvable locale (rare; private mode + no APIs).
  language: '',
  chatAlwaysListen: false,
};

/** Map a browser `navigator.language` value to a Whisper-supported
 * ISO-639-1 code. Returns `''` when the locale isn't in our picker
 * — falling back to auto-detect rather than silently picking the
 * wrong language. */
export function detectBrowserLanguage(): string {
  if (typeof navigator === 'undefined') return '';
  const raw = (navigator.language || (navigator as { userLanguage?: string }).userLanguage || '').toLowerCase();
  if (!raw) return '';
  // `navigator.language` returns 'it-IT' / 'en-US' / 'it' etc.
  // Strip the region tag and match against the picker.
  const code = raw.split('-')[0];
  return VOICE_LANGUAGES.some((l) => l.code === code) ? code : '';
}

// ISO-639-1 codes for the picker. Order matches Whisper's stated
// best-supported languages first, then a long tail.
//
// The ``'auto'`` option means "user explicitly wants Whisper to
// auto-detect" — semantically distinct from ``''`` (which
// `loadFromStorage` treats as "never picked, derive from browser
// locale"). voice.tsx forwards `'auto'` as `undefined` to the
// backend, same as ``''``, so both end up as faster-whisper auto.
export const VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'auto', label: 'Auto-detect (unreliable for short utterances)' },
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italian' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
];

const STORAGE_KEY = 'oa-voice-config-v1';

function loadFromStorage(): VoiceConfig {
  // First-run language default comes from the browser locale so an
  // Italian user transcribing Italian gets `it` automatically rather
  // than Whisper auto-detect (which routinely misidentifies Italian
  // as Cyrillic on the small models). Empty saved language is also
  // treated as "not set" — old localStorage entries from before this
  // change carried `language: ''`, which we want to migrate to the
  // browser default rather than honor verbatim.
  const browserLang = detectBrowserLanguage();
  const initial: VoiceConfig = {
    ...VOICE_DEFAULTS,
    language: browserLang || VOICE_DEFAULTS.language,
  };
  if (typeof window === 'undefined' || !window.localStorage) return initial;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initial;
    const parsed = JSON.parse(raw);
    const merged = { ...initial, ...parsed };
    // Empty string in storage = "user never picked". Resolve to the
    // browser locale instead so a v1 install upgrades silently.
    if (!merged.language) merged.language = browserLang;
    return merged;
  } catch {
    return initial;
  }
}

function saveToStorage(cfg: VoiceConfig): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // quota exceeded / private mode — ignore
  }
}

interface VoiceConfigState {
  config: VoiceConfig;
  setConfig: (patch: Partial<VoiceConfig>) => void;
  reset: () => void;
}

export const useVoiceConfig = create<VoiceConfigState>((set) => ({
  config: loadFromStorage(),
  setConfig: (patch) => set((s) => {
    const next = { ...s.config, ...patch };
    saveToStorage(next);
    return { config: next };
  }),
  reset: () => set(() => {
    saveToStorage(VOICE_DEFAULTS);
    return { config: VOICE_DEFAULTS };
  }),
}));
