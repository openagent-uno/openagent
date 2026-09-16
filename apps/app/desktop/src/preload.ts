/**
 * Preload script — exposes desktop-only APIs to the renderer via
 * contextBridge. The renderer accesses them as window.desktop.*.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopCapabilityStatus } from './capabilities/protocol';

const isChild = (() => {
  try {
    return new URLSearchParams(window.location.search).get('child') === '1';
  } catch { return false; }
})();

const clientInstanceId = (() => {
  const prefix = '--openagent-client-instance-id=';
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? '';
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(raw) ? raw : '';
})();

/**
 * Set up listeners for all known menu:* IPC channels and invoke a
 * single callback with the action name and any arguments.
 * Returns an unsubscribe function.
 */
function makeMenuActionSubscription(
  cb: (action: string, ...args: unknown[]) => void,
): () => void {
  // All menu channels that the main process may send.
  const channels = [
    'menu:newWindow',
    'menu:newAgentWindow',
    'menu:switchAgent',
    'menu:openSettings',
    'menu:openShortcuts',
    'menu:checkForUpdates',
    'menu:closeAllChildren',
    'menu:cycleWindows',
    'menu:focusWindow',
    'menu:openAgent',
    'menu:navigate',
    'menu:quickJump',
    'menu:quickCreate',
  ] as const;

  const handlers = channels.map((channel) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      cb(channel, ...args);
    };
    ipcRenderer.on(channel, handler);
    return { channel, handler };
  });

  return () => {
    for (const { channel, handler } of handlers) {
      ipcRenderer.removeListener(channel, handler);
    }
  };
}

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  isDesktop: true,
  isChild,
  // Read-only boot identity. It binds renderer-originated session_open frames
  // to the Electron-main capability channel; it grants no local authority.
  clientInstanceId,

  // Local capability control plane. No tool invocation method is exposed.
  getCapabilityStatus: (): Promise<DesktopCapabilityStatus> =>
    ipcRenderer.invoke('capabilities:getStatus'),
  setCapabilityEnabled: (enabled: boolean): Promise<DesktopCapabilityStatus> =>
    ipcRenderer.invoke('capabilities:setEnabled', enabled),
  emergencyDisableCapabilities: (): Promise<DesktopCapabilityStatus> =>
    ipcRenderer.invoke('capabilities:emergencyDisable'),
  onCapabilityStatus: (cb: (status: DesktopCapabilityStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopCapabilityStatus) => cb(status);
    ipcRenderer.on('capabilities:status', handler);
    return () => { ipcRenderer.removeListener('capabilities:status', handler); };
  },

  // Storage (electron-store based, persists across restarts)
  getItem: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('storage:get', key),
  setItem: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('storage:set', key, value),
  removeItem: (key: string): Promise<void> =>
    ipcRenderer.invoke('storage:remove', key),

  // Native file picker
  pickFiles: (): Promise<{
    path: string;
    filename: string;
    kind: 'image' | 'file';
    /** Bytes on disk, or -1 if stat failed. */
    size: number;
    /** Renderer-side cap mirror so the UI can pre-reject oversized files. */
    maxBytes: number;
  }[]> => ipcRenderer.invoke('dialog:pickFiles'),

  readFile: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('dialog:readFile', filePath),

  /** Deep-link to the OS microphone privacy pane. Returns false when
   *  the platform has no known URL (the UI should show instructions). */
  openMicSettings: (): Promise<boolean> => ipcRenderer.invoke('app:openMicSettings'),

  // Quit the app from the renderer.
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  // Custom window controls (cross-platform Jarvis-themed).
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),

  // Open a new window for a tab route (desktop-only multi-window). The new
  // window is a *relay child* — it shares this window's agent connection.
  openWindow: (route: string): Promise<void> => ipcRenderer.invoke('window:open', route),

  // Open a *standalone* agent window bound to ``accountId`` — a full app
  // window with its OWN connection (own loopback + WS), independent of this
  // one. Powers "open another agent in a new window" from the switcher.
  openAgentWindow: (
    accountId: string,
    attemptToken?: number,
    sourceAccountId?: string,
  ): Promise<void> =>
    ipcRenderer.invoke('window:openAgent', accountId, attemptToken, sourceAccountId),

  // Close all sub-windows (called on agent switch or main window close).
  closeAllChildren: (): Promise<void> => ipcRenderer.invoke('window:closeAllChildren'),

  // Retrieve an already-running loopback's port without a password.
  getLoopbackPort: (accountId: string): Promise<number | null> =>
    ipcRenderer.invoke('loopback:getPort', accountId),

  // ── Multi-window WS relay ──

  // Child → primary: send an outbound WS message.
  wsRelayOut: (payload: string): void => {
    ipcRenderer.send('ws:relay-out', payload);
  },

  // Primary → children: broadcast a server message.
  wsRelayBroadcast: (payload: string): void => {
    ipcRenderer.send('ws:relay-broadcast', payload);
  },

  // Child: subscribe to server messages from the primary.
  onWsRelayToChild: (cb: (data: string) => void): (() => void) => {
    const handler = (_event: any, data: string) => cb(data);
    ipcRenderer.on('ws:relay-to-child', handler);
    return () => { ipcRenderer.removeListener('ws:relay-to-child', handler); };
  },

  // Primary: subscribe to outbound messages from children.
  onWsRelayFromChild: (cb: (data: string) => void): (() => void) => {
    const handler = (_event: any, data: string) => cb(data);
    ipcRenderer.on('ws:relay-from-child', handler);
    return () => { ipcRenderer.removeListener('ws:relay-from-child', handler); };
  },

  // ── Network loopback (Iroh transport bridge) ──
  startLoopback: (args: {
    accountId: string;
    password: string;
    ticket?: string;
    handle?: string;
    network?: string;
    agent?: string;
    remember?: boolean;
    attemptToken?: number;
  }): Promise<{
    port: number;
    target: { network: string; handle: string; agentHandle: string };
  }> => ipcRenderer.invoke('loopback:start', args),

  // Remembered passwords are encrypted/decrypted in the main process. There
  // is deliberately no IPC getter that can return plaintext to the renderer.
  credentialsAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('credentials:isAvailable'),

  forgetCredential: (accountId: string): Promise<void> =>
    ipcRenderer.invoke('credentials:remove', accountId),

  startRememberedLoopback: (args: {
    accountId: string;
    ticket?: string;
    handle?: string;
    network?: string;
    agent?: string;
    attemptToken?: number;
  }): Promise<
    | {
        status: 'started'; port: number;
        target: { network: string; handle: string; agentHandle: string };
      }
    | { status: 'missing' }
    | {
        status: 'invalid'; error: string;
        target?: { network: string; handle: string; agentHandle: string };
      }
    | {
        status: 'retryable_error'; error: string;
        target?: { network: string; handle: string; agentHandle: string };
      }
  > => ipcRenderer.invoke('loopback:startRemembered', args),

  releaseLoopbackAttempt: (args: { accountId: string; attemptToken: number }): Promise<void> =>
    ipcRenderer.invoke('loopback:releaseAttempt', args),

  stopLoopback: (args: { accountId: string }): Promise<void> =>
    ipcRenderer.invoke('loopback:stop', args),

  // ── Ticket introspection ──
  // Decode an oa1… ticket so the join form can auto-fill the handle
  // when the ticket is bound (role=device). Returns ``null`` on any
  // parse error — the form falls back to manual entry. The renderer
  // doesn't ship the base32/CBOR libs, so we delegate to the same
  // ``decodeTicket`` the loopback bridge already uses.
  decodeTicket: (ticket: string): Promise<{
    role: 'user' | 'device' | 'agent';
    bindTo: string;
    networkName: string;
  } | null> => ipcRenderer.invoke('network:decode-ticket', ticket),

  // ── Menu actions (new) ──

  /**
   * Listen for menu-initiated actions. The callback receives the action
   * name (e.g. 'menu:switchAgent', 'menu:openSettings') and any
   * additional arguments passed by the menu handler.
   * Returns an unsubscribe function.
   */
  onMenuAction: (cb: (action: string, ...args: unknown[]) => void): (() => void) => {
    return makeMenuActionSubscription(cb);
  },

  // Navigate to a named route within the app (Memory Vault, Tasks, etc.)
  navigate: (route: string): void => {
    ipcRenderer.send('menu:navigate', route);
  },

  /**
   * Retrieve the keyboard shortcuts documentation map.
   * Returns a record of accelerator → label.
   */
  getShortcuts: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('shortcuts:getMap'),

  /**
   * Listen for window focus changes. The callback receives the
   * webContents id of the newly focused window.
   * Returns an unsubscribe function.
   */
  onWindowFocusChange: (cb: (windowId: number) => void): (() => void) => {
    const handler = (_event: any, id: number) => cb(id);
    ipcRenderer.on('window:focusChanged', handler);
    return () => {
      ipcRenderer.removeListener('window:focusChanged', handler);
    };
  },
});
