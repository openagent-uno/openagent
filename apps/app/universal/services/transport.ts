/**
 * Platform transport — desktop / web variant.
 *
 * Checks ``window.desktop`` for the Electron preload bridge. Returns
 * null on web (no transport available). Metro selects the
 * ``.native.ts`` variant for iOS / Android builds.
 */

interface DesktopBridge {
  clientInstanceId?: string;
  startLoopback: (args: any) => Promise<any>;
  startRememberedLoopback?: (args: any) => Promise<any>;
  stopLoopback: (args: any) => Promise<void>;
  getLoopbackPort: (accountId: string) => Promise<number | null>;
  credentialsAvailable?: () => Promise<boolean>;
  forgetCredential?: (accountId: string) => Promise<void>;
  releaseLoopbackAttempt?: (args: any) => Promise<void>;
  setRelayAgent?: (id: string | null) => void;
  wsRelayBroadcast?: (payload: string, id: string) => void;
  openAgentWindow?: (accountId: string, attemptToken?: number, sourceAccountId?: string) => Promise<void>;
}

let cached: DesktopBridge | null | undefined;

export function getTransport(): DesktopBridge | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined') { cached = null; return null; }
  const d = (window as any).desktop;
  if (!d || typeof d.startLoopback !== 'function') { cached = null; return null; }
  cached = d as DesktopBridge;
  return cached;
}
