/**
 * Shared types for the terminal view + its platform variants.
 */

export type TerminalStatus =
  | 'connecting' // waiting for the gateway ws / first frame
  | 'open' // PTY ready, streaming
  | 'exited' // shell ended
  | 'error'; // failed to open

export interface TerminalViewProps {
  /** Stable id for this PTY — also the route param of its window. */
  terminalId: string;
  /** Optional working directory + shell to launch (defaults on the host). */
  cwd?: string;
  shell?: string;
  /** Bubble status changes up so the screen chrome can show "exited" etc. */
  onStatusChange?: (status: TerminalStatus, detail?: string) => void;
}
