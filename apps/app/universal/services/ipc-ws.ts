/**
 * IPC WebSocket transport — used by Electron child windows to relay
 * WebSocket messages through the primary window. Implements the same
 * interface as the browser WebSocket API so OpenAgentWS can use it
 * without changes to its core logic.
 *
 * This file is only meaningful in Electron desktop child windows.
 * On web / React Native the native WebSocket is used directly.
 */

function desktop(): any {
  if (typeof window === 'undefined') return undefined;
  return (window as any).desktop;
}

export class IpcWebSocket {
  readyState: number = 0; // CONNECTING = 0
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private _cleanupMessage: (() => void) | null = null;
  private _closed = false;

  constructor() {
    const d = desktop();
    if (!d || !d.isChild) {
      throw new Error('IpcWebSocket: only available in Electron child windows');
    }
  }

  /**
   * Wire up IPC listeners. Called after the constructor so that onopen
   * / onmessage handlers can be attached before the first message arrives.
   */
  init(): void {
    if (this._closed) return;

    const d = desktop();
    if (!d) return;

    // Double-init guard. Defensive: if a caller wires this up twice
    // (e.g. retry on reconnect that forgets the previous transport),
    // the first ``cleanupMessage`` closure would be lost and the IPC
    // listener it represents would leak — surfacing as duplicate
    // server frames in the renderer. Drop the prior listener first.
    if (this._cleanupMessage) {
      try { this._cleanupMessage(); } catch { /* ignore */ }
      this._cleanupMessage = null;
    }

    this._cleanupMessage = d.onWsRelayToChild((data: string) => {
      if (this._closed) return;
      this.onmessage?.({ data });
    });

    // The transport is ready immediately — there's no TCP handshake.
    // The primary window's WebSocket is already connected and authed.
    queueMicrotask(() => {
      if (this._closed) return;
      this.readyState = IpcWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (this._closed || this.readyState !== IpcWebSocket.OPEN) return;
    desktop()?.wsRelayOut(data);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.readyState = IpcWebSocket.CLOSED;
    this._cleanupMessage?.();
    this._cleanupMessage = null;
  }
}
