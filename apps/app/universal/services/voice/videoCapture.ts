/**
 * videoCapture — webcam + screen-share capture loops for the realtime
 * session.
 *
 * Each helper opens a media stream, attaches a hidden ``<video>``
 * element to it, and runs a frame-grab loop that draws into a
 * ``<canvas>`` and emits a base64 JPEG via ``onFrame``. The Voice
 * screen ships each frame to the gateway via ``ws.sendVideoFrame``;
 * server-side, ``StreamSession`` keeps a ring of the last 8 frames per
 * named stream and snapshots the latest one as an image attachment at
 * turn-trigger time.
 *
 * Web/Electron only — React Native doesn't expose ``getUserMedia`` /
 * ``getDisplayMedia`` consistently and the Voice tab already gates
 * itself on ``Platform.OS === 'web'``. Mobile capture would need the
 * native camera APIs and is out of scope.
 *
 * Cost & privacy guardrails:
 *   - Default 1 fps. The LLM path only samples the latest frame per
 *     stream at turn-trigger time, so higher rates are wasted bandwidth.
 *   - JPEG quality defaults to 0.7 — well below noise-floor for vision
 *     models, but small enough to keep the WS frames under ~50 KB on
 *     a 1080p webcam.
 *   - ``stop()`` releases tracks via ``track.stop()`` so the browser's
 *     hardware-in-use indicator clears immediately.
 */

export interface VideoStreamHandle {
  /** Releases the stream and stops the frame-grab loop. */
  stop(): void;
  /** Underlying ``MediaStream`` — exposed so the caller can attach a
   *  preview ``<video>`` element if desired. */
  readonly stream: MediaStream;
}

export interface VideoCaptureOptions {
  /** Frames per second to push to the gateway. Default 1. */
  fps?: number;
  /** JPEG quality 0..1. Default 0.7. */
  quality?: number;
  /** Override for the canvas downscale; useful for very high-res
   *  webcams where the default would blow the wire-frame budget. */
  maxWidth?: number;
}

const DEFAULTS = {
  fps: 1,
  quality: 0.7,
  maxWidth: 1280,
};

/** Start the webcam capture loop. ``onFrame`` is invoked at ~``fps`` Hz
 *  with a base64 JPEG (no data-URI prefix) and the source dimensions. */
export async function startWebcamCapture(
  onFrame: (base64Jpeg: string, width: number, height: number) => void,
  opts: VideoCaptureOptions = {},
): Promise<VideoStreamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  return attachFrameGrab(stream, onFrame, opts);
}

/** Start the screen-share capture loop. The browser shows its native
 *  share-picker dialog; if the user cancels, this rejects. */
export async function startScreenCapture(
  onFrame: (base64Jpeg: string, width: number, height: number) => void,
  opts: VideoCaptureOptions = {},
): Promise<VideoStreamHandle> {
  // ``getDisplayMedia`` is the standard surface for screen sharing on
  // web / Electron. ``displaySurface: "monitor"`` is a hint — browsers
  // still show the picker.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor' } as MediaTrackConstraints,
  });
  return attachFrameGrab(stream, onFrame, opts);
}

function attachFrameGrab(
  stream: MediaStream,
  onFrame: (base64Jpeg: string, width: number, height: number) => void,
  opts: VideoCaptureOptions,
): VideoStreamHandle {
  const fps = opts.fps ?? DEFAULTS.fps;
  const quality = opts.quality ?? DEFAULTS.quality;
  const maxWidth = opts.maxWidth ?? DEFAULTS.maxWidth;

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Some browsers (notably Firefox + WebKit on certain hosts) refuse to
  // decode frames in a detached <video>. Park it off-screen instead so
  // requestAnimationFrame fires reliably and ``video.videoWidth`` /
  // ``readyState`` actually populate.
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '-9999px';
  video.style.width = '1px';
  video.style.height = '1px';
  video.style.opacity = '0';
  video.style.pointerEvents = 'none';
  document.body.appendChild(video);
  // ``play()`` returns a promise on modern browsers — fire-and-forget;
  // the readyState gate below skips draws until first frame anyway.
  void video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let stopped = false;
  let lastDrawAt = 0;

  const interval = setInterval(() => {
    if (stopped || !ctx) return;
    if (video.readyState < 2) return; // HAVE_CURRENT_DATA
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const now = Date.now();
    if (now - lastDrawAt < 1000 / fps - 5) return; // tolerate small drift
    lastDrawAt = now;

    let dw = w;
    let dh = h;
    if (dw > maxWidth) {
      const scale = maxWidth / dw;
      dw = maxWidth;
      dh = Math.round(h * scale);
    }
    if (canvas.width !== dw) canvas.width = dw;
    if (canvas.height !== dh) canvas.height = dh;
    try {
      ctx.drawImage(video, 0, 0, dw, dh);
    } catch {
      return; // first-paint races, etc.
    }
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    } catch {
      return;
    }
    // Strip ``data:image/jpeg;base64,`` prefix so the wire frame ships
    // pure base64 — matches the audio_chunk_in convention.
    const idx = dataUrl.indexOf(',');
    const base64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
    if (base64) {
      try {
        onFrame(base64, dw, dh);
      } catch {
        // Swallow handler errors so a bad WS doesn't kill the loop.
      }
    }
  }, Math.max(50, Math.floor(1000 / fps / 2))); // tick at 2× target rate

  // Stop loop if the underlying stream's tracks die (user revoked
  // sharing, hardware unplugged).
  const onTrackEnded = () => stop();
  stream.getTracks().forEach((t) => t.addEventListener('ended', onTrackEnded));

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    stream.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
      t.removeEventListener('ended', onTrackEnded);
    });
    try { video.srcObject = null; } catch { /* ignore */ }
    try { video.remove(); } catch { /* ignore */ }
  }

  return { stop, stream };
}
