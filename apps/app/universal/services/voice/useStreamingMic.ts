/**
 * useStreamingMic — shared continuous-mic plumbing for Voice + Chat tabs.
 *
 * Wires up a {@link VoiceLoop} (mic + VAD + PCM streaming) plus an
 * {@link AudioQueuePlayer} that plays back the assistant's TTS reply
 * for the same session. Both tabs need exactly the same plumbing —
 * before this hook the chat tab and the voice tab each carried a
 * ~90-line ``useFocusEffect`` clone.
 *
 * The hook activates when ``enabled && ws && sessionId`` and the tab
 * is focused. On any of those flipping false (or on unmount) it tears
 * down the mic + player so the OS hardware indicator clears.
 *
 * Callbacks are read through refs so the caller can pass new closures
 * each render without forcing a mount/unmount cycle. Voice tunables
 * are snapshotted at mount — changing one in Settings while the loop
 * is live takes effect on next mount (toggle off + on, or focus blur).
 * That's the Voice tab's existing behaviour and matches the lack of a
 * runtime config API on ``VoiceLoop``.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform } from 'react-native';

import type { ServerMessage } from '../../../common/types';
import type { VoiceConfig } from '../../stores/voice';
import type { OpenAgentWS } from '../ws';

import { AudioQueuePlayer } from './audioPlayer';
import { bytesToBase64, blobToBase64 } from './encoding';
import { VoiceLoop } from './voiceLoop';

export interface StreamingMicOptions {
  ws: OpenAgentWS | null;
  sessionId: string | null;
  /** Master switch. When false the loop tears down regardless of focus. */
  enabled: boolean;
  voiceConfig: VoiceConfig;
  /** Settings forwarded to ``ws.sendSessionOpen`` at mount.
   *
   * The send is idempotent (no-op when the session is already open on
   * this WS) so callers can pass their preferred profile / speak /
   * language without worrying about double-opens. Without this the
   * gateway would lazily create the session from the first audio
   * frame using realtime defaults — wrong for chat-tab usage where
   * typed replies should stay silent. */
  sessionOpen?: Parameters<OpenAgentWS['sendSessionOpen']>[1];
  /** Fired when the server commits a TextFinal(source='stt') for this session. */
  onTranscript?: (text: string) => void;
  /** Optional structured logger for devtools traces. */
  onLog?: (event: string, data?: Record<string, unknown>) => void;
  /** Voice-tab pcm.first_frame echo so callers can show the "live" indicator. */
  onFirstPcmFrame?: (info: { sampleRate: number; bytes: number }) => void;
}

export interface StreamingMicState {
  vadState: 'idle' | 'listening';
  audioState: 'idle' | 'playing';
  /** Smoothed mic RMS, 0..1. Drives the SoundWaves equalizer on Voice. */
  energy: number;
  /** Stable reason string when getUserMedia errors out. */
  micError: string | null;
}

const noop = () => {};

function browserAvailable(): boolean {
  return (
    Platform.OS === 'web'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined'
  );
}

export function useStreamingMic(opts: StreamingMicOptions): StreamingMicState {
  const [vadState, setVadState] = useState<'idle' | 'listening'>('idle');
  const [audioState, setAudioState] = useState<'idle' | 'playing'>('idle');
  const [energy, setEnergy] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  // Stash callbacks in refs so re-renders don't tear down the loop.
  const cbsRef = useRef({
    onTranscript: opts.onTranscript ?? noop,
    onLog: opts.onLog ?? noop,
    onFirstPcmFrame: opts.onFirstPcmFrame ?? noop,
  });
  cbsRef.current = {
    onTranscript: opts.onTranscript ?? noop,
    onLog: opts.onLog ?? noop,
    onFirstPcmFrame: opts.onFirstPcmFrame ?? noop,
  };

  // Tunables are snapshotted into a ref at mount via the body below;
  // this ref is what changes between renders without a remount.
  const cfgRef = useRef(opts.voiceConfig);
  cfgRef.current = opts.voiceConfig;

  useFocusEffect(
    useCallback(() => {
      const { ws, sessionId, enabled } = opts;
      if (!enabled || !ws || !sessionId) return;
      if (!browserAvailable()) return;

      const sid = sessionId;
      const cfg = cfgRef.current;
      const log = cbsRef.current.onLog;
      log('mic.mount', { sessionId: sid });

      // Idempotent — sendSessionOpen no-ops if the session is already
      // open on this WS. Ensures the gateway gets caller-provided
      // settings (e.g. chat-tab's speak=false) before audio_chunk_in
      // would otherwise lazily create the session with defaults.
      if (opts.sessionOpen) ws.sendSessionOpen(sid, opts.sessionOpen);

      let cancelled = false;
      const player = new AudioQueuePlayer({
        onStateChange: (state) => {
          setAudioState(state);
        },
        onPlayingChange: (playing) => loop.setMuted(playing),
      });

      const offWs = ws.onMessage((msg: ServerMessage) => {
        const m = msg as { session_id?: string; type?: string };
        if (m.session_id !== sid) return;
        if (m.type === 'audio_start') {
          player.start((msg as { mime?: string }).mime || 'audio/mpeg');
        } else if (m.type === 'audio_chunk') {
          player.enqueue(
            (msg as { seq: number }).seq,
            (msg as { data: string }).data,
          );
        } else if (m.type === 'audio_end') {
          player.end((msg as { total_chunks?: number }).total_chunks ?? 0);
        } else if (
          m.type === 'text_final'
          && (msg as { source?: string }).source === 'stt'
        ) {
          const text = ((msg as { text?: string }).text ?? '').trim();
          if (text) cbsRef.current.onTranscript(text);
        }
      });

      const loop = new VoiceLoop({
        speechThreshold: cfg.speechThreshold,
        silenceThreshold: cfg.silenceThreshold,
        speechFrames: cfg.speechFrames,
        silenceFrames: cfg.silenceFrames,
        maxUtteranceMs: cfg.maxUtteranceMs,
        minUtteranceMs: cfg.minUtteranceMs,
        onPcmChunk: (frame, info) => {
          if (cancelled) return;
          const bytes = new Uint8Array(
            frame.buffer, frame.byteOffset, frame.byteLength,
          );
          ws.sendAudioChunkIn(sid, bytesToBase64(bytes), {
            encoding: 'pcm16',
            sampleRate: info.sampleRate,
          });
          if (info.first) {
            cbsRef.current.onFirstPcmFrame({
              sampleRate: info.sampleRate, bytes: frame.byteLength,
            });
          }
        },
        onUtterance: async (blob) => {
          if (cancelled) return;
          try {
            ws.sendAudioChunkIn(sid, await blobToBase64(blob), { encoding: 'webm' });
            ws.sendAudioEndIn(sid);
          } catch (e) {
            log('utterance.encode_error', { error: String(e) });
          }
        },
        onSpeechStart: () => {
          if (cancelled) return;
          setVadState('listening');
        },
        onSpeechEnd: () => {
          if (cancelled) return;
          setVadState('idle');
          // PCM path: tell the server the utterance is over so the STT
          // pump closes the window. WebM path sends audio_end_in inside
          // onUtterance after MediaRecorder.stop() flushes.
          if (loop.usingPcmStream) ws.sendAudioEndIn(sid);
        },
        onEnergy: (level) => { if (!cancelled) setEnergy(level); },
        onMicError: (reason) => {
          log('mic.error', { reason });
          if (!cancelled) {
            setVadState('idle');
            setEnergy(0);
            setMicError(reason);
          }
        },
      });
      void loop.start().then((ok) => log('mic.start', { ok }));

      return () => {
        log('mic.unmount');
        cancelled = true;
        offWs();
        loop.stop();
        player.stop();
        setVadState('idle');
        setEnergy(0);
        setAudioState('idle');
        setMicError(null);
      };
      // Only remount when the binding identity changes — voice tunable
      // tweaks read through cfgRef without tearing down the mic.
    }, [opts.ws, opts.sessionId, opts.enabled]),
  );

  // When the parent unmounts (not just blurs), reset surface state.
  useEffect(() => () => {
    setVadState('idle');
    setAudioState('idle');
    setEnergy(0);
    setMicError(null);
  }, []);

  return { vadState, audioState, energy, micError };
}
