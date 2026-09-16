/**
 * useAudioPlayback — listen for ``audio_*`` frames on a session and
 * play them through {@link AudioQueuePlayer}.
 *
 * Decoupled from {@link useStreamingMic} so screens that don't run a
 * mic loop can still hear spoken replies. The chat tab uses this for
 * voice notes (recorder → upload → STT → mirror-modality TTS reply)
 * — without it the server happily streams audio_chunk frames into the
 * void because no client-side handler is mounted.
 *
 * The voice tab gets audio playback through ``useStreamingMic`` (which
 * embeds the same player) so it does NOT need to mount this on top.
 *
 * Returns ``audioState`` so the caller can render a "speaking" badge
 * and an ``onPlayingChange`` ref the caller can wire to mute its mic
 * loop while the assistant is talking.
 */

import { useEffect, useRef, useState } from 'react';

import type { ServerMessage } from '../../../common/types';
import type { OpenAgentWS } from '../ws';

import { AudioQueuePlayer } from './audioPlayer';

export interface AudioPlaybackOptions {
  ws: OpenAgentWS | null;
  sessionId: string | null;
  /** Master switch. When false, no player is mounted and no events
   *  are consumed. Defaults to true. */
  enabled?: boolean;
  /** Mirrors the inner {@link AudioQueuePlayer} hook so callers can
   *  mute a separate mic loop while the reply is playing. */
  onPlayingChange?: (playing: boolean) => void;
}

export interface AudioPlaybackState {
  audioState: 'idle' | 'playing';
}

export function useAudioPlayback(opts: AudioPlaybackOptions): AudioPlaybackState {
  const [audioState, setAudioState] = useState<'idle' | 'playing'>('idle');
  const onPlayingRef = useRef(opts.onPlayingChange);
  onPlayingRef.current = opts.onPlayingChange;

  const enabled = opts.enabled ?? true;
  const { ws, sessionId } = opts;

  useEffect(() => {
    if (!enabled || !ws || !sessionId) return;

    const player = new AudioQueuePlayer({
      onStateChange: (state) => setAudioState(state),
      onPlayingChange: (playing) => onPlayingRef.current?.(playing),
    });

    const offWs = ws.onMessage((msg: ServerMessage) => {
      const m = msg as { session_id?: string; type?: string };
      if (m.session_id !== sessionId) return;
      if (m.type === 'audio_start') {
        player.start((msg as { mime?: string }).mime || 'audio/mpeg');
      } else if (m.type === 'audio_chunk') {
        player.enqueue(
          (msg as { seq: number }).seq,
          (msg as { data: string }).data,
        );
      } else if (m.type === 'audio_end') {
        player.end((msg as { total_chunks?: number }).total_chunks ?? 0);
      }
    });

    return () => {
      offWs();
      player.stop();
      setAudioState('idle');
    };
  }, [ws, sessionId, enabled]);

  return { audioState };
}
