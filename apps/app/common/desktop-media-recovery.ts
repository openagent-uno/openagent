/** Viewing-only overload recovery. No input operation is ever resubmitted. */
export type DesktopMediaRecovery = { fps: number; generation: number; restarts: number[] };
export function recoverDesktopMedia(state: DesktopMediaRecovery, now: number, message: string): DesktopMediaRecovery | null {
  if (!Number.isFinite(now) || !['Video decoder is too slow', 'The desktop connection is too slow. Reopen the view.'].includes(message)) return null;
  const recent = state.restarts.filter(time => time <= now && now - time < 30_000);
  if (recent.length >= 3) return null;
  return { fps: Math.max(5, Math.floor(state.fps / 2)), generation: state.generation + 1, restarts: [...recent, now] };
}
