/**
 * Global and local keyboard shortcuts.
 *
 * Uses Electron's globalShortcut for shortcuts that must work when the
 * app is focused (most Cmd/Ctrl-based actions), and IPC forwarding to
 * the focused window for renderer-side actions (DevTools, reload, zoom).
 */

import { app, BrowserWindow, globalShortcut } from 'electron';
import {
  getAllWindows,
  focusWindow,
  closeWindow,
  getCreateWindowFactory,
} from './window-manager';
import { handleTrustedIpc } from './security/trusted-ipc';
import { sendToTrustedRenderer } from './security/trusted-renderers';

// ── Types ──

interface ShortcutDef {
  /** Electron accelerator string. */
  accelerator: string;
  /** Human-readable label shown in menus / documentation. */
  label: string;
  /** Handler invoked when the shortcut fires. */
  action: () => void;
}

// ── Shortcut definitions ──

let registered = false;

/**
 * Build the canonical list of all keyboard shortcuts.
 * Not exported directly — consumers use the registry functions.
 */
function buildShortcutDefs(): ShortcutDef[] {
  const isMac = process.platform === 'darwin';

  /** Return the focused BrowserWindow, or null. */
  const focusedWin = (): BrowserWindow | null => {
    return BrowserWindow.getFocusedWindow();
  };

  /** Send an IPC message to the focused window's renderer. */
  const sendToFocused = (channel: string, ...args: unknown[]): void => {
    const win = focusedWin();
    if (win && !win.isDestroyed()) {
      sendToTrustedRenderer(win.webContents, channel, ...args);
    }
  };

  /** Toggle DevTools on the focused window. */
  const toggleDevTools = (): void => {
    const win = focusedWin();
    if (win && !win.isDestroyed()) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools();
      }
    }
  };

  /** Reload the focused window. */
  const reloadFocused = (hard: boolean): void => {
    const win = focusedWin();
    if (win && !win.isDestroyed()) {
      hard ? win.webContents.reloadIgnoringCache() : win.reload();
    }
  };

  const defs: ShortcutDef[] = [
    // ── Window management ──
    {
      accelerator: 'CmdOrCtrl+N',
      label: 'New Window',
      action: () => {
        const factory = getCreateWindowFactory();
        if (factory) factory({ markChild: true });
      },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+N',
      label: 'New Agent Window',
      action: () => {
        const factory = getCreateWindowFactory();
        if (factory) factory({});
      },
    },
    {
      accelerator: 'CmdOrCtrl+W',
      label: 'Close Window',
      action: () => {
        const win = focusedWin();
        if (win && !win.isDestroyed()) {
          const id = win.webContents.id;
          closeWindow(id);
        }
      },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+W',
      label: 'Close All Child Windows',
      action: () => {
        const all = getAllWindows().filter((e) => !e.win.isDestroyed());
        for (const entry of all) {
          if (entry.type !== 'primary') {
            closeWindow(entry.id);
          }
        }
      },
    },
    {
      accelerator: isMac ? 'Cmd+Q' : 'Ctrl+Q',
      label: 'Quit',
      action: () => {
        app.quit();
      },
    },

    // ── Developer ──
    {
      accelerator: 'CmdOrCtrl+Shift+I',
      label: 'Toggle DevTools',
      action: toggleDevTools,
    },
    {
      accelerator: 'CmdOrCtrl+R',
      label: 'Reload',
      action: () => reloadFocused(false),
    },
    {
      accelerator: 'CmdOrCtrl+Shift+R',
      label: 'Hard Reload',
      action: () => reloadFocused(true),
    },

    // ── Display ──
    {
      accelerator: 'CmdOrCtrl+Shift+F',
      label: 'Toggle Fullscreen',
      action: () => {
        const win = focusedWin();
        if (win && !win.isDestroyed()) {
          win.setFullScreen(!win.isFullScreen());
        }
      },
    },
    {
      accelerator: 'CmdOrCtrl+=',
      label: 'Zoom In',
      action: () => {
        const win = focusedWin();
        if (win && !win.isDestroyed()) {
          win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
        }
      },
    },
    {
      accelerator: 'CmdOrCtrl+-',
      label: 'Zoom Out',
      action: () => {
        const win = focusedWin();
        if (win && !win.isDestroyed()) {
          win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
        }
      },
    },
    {
      accelerator: 'CmdOrCtrl+0',
      label: 'Reset Zoom',
      action: () => {
        const win = focusedWin();
        if (win && !win.isDestroyed()) {
          win.webContents.setZoomLevel(0);
        }
      },
    },

    // ── Window cycling ──
    {
      accelerator: isMac ? 'Cmd+`' : 'Ctrl+`',
      label: 'Cycle Through Windows',
      action: () => {
        const all = getAllWindows().filter((e) => !e.win.isDestroyed());
        if (all.length === 0) return;
        const focusedId = BrowserWindow.getFocusedWindow()?.webContents.id ?? -1;
        const currentIndex = all.findIndex((e) => e.id === focusedId);
        const nextIndex = (currentIndex + 1) % all.length;
        const next = all[nextIndex];
        if (next) focusWindow(next.id);
      },
    },

    // ── Window quick-switch (indexed) ──
    ...(Array.from({ length: 9 }, (_, i) => ({
      accelerator: `CmdOrCtrl+${i + 1}`,
      label: `Focus Window ${i + 1}`,
      action: () => {
        const all = getAllWindows().filter((e) => !e.win.isDestroyed());
        const target = all[i];
        if (target) focusWindow(target.id);
      },
    })) as ShortcutDef[]),

    // ── Settings ──
    {
      accelerator: 'CmdOrCtrl+,',
      label: 'Open Settings',
      action: () => {
        sendToFocused('menu:openSettings');
      },
    },

    // ── App navigation ──
    {
      accelerator: 'CmdOrCtrl+Shift+V',
      label: 'Open Memory Vault',
      action: () => { sendToFocused('menu:navigate', '/vault'); },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+T',
      label: 'Open Scheduled Tasks',
      action: () => { sendToFocused('menu:navigate', '/scheduled'); },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+O',
      label: 'Open Workflows',
      action: () => { sendToFocused('menu:navigate', '/workflows'); },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+S',
      label: 'Open Sessions',
      action: () => { sendToFocused('menu:navigate', '/sessions'); },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+C',
      label: 'Open Connectors',
      action: () => { sendToFocused('menu:navigate', '/connectors'); },
    },
    {
      accelerator: 'CmdOrCtrl+J',
      label: 'Quick Jump',
      action: () => { sendToFocused('menu:quickJump'); },
    },
    {
      accelerator: 'CmdOrCtrl+Shift+K',
      label: 'Quick Create',
      action: () => { sendToFocused('menu:quickCreate'); },
    },
  ];

  return defs;
}

/** Cache of built defs — built once on first register. */
let cachedDefs: ShortcutDef[] | null = null;

function getDefs(): ShortcutDef[] {
  if (!cachedDefs) cachedDefs = buildShortcutDefs();
  return cachedDefs;
}

// ── Public API ──

/**
 * Register all global keyboard shortcuts.
 * Call once on app ready.
 */
export function registerAllShortcuts(): void {
  if (registered) return;

  const defs = getDefs();
  for (const def of defs) {
    const success = globalShortcut.register(def.accelerator, def.action);
    if (!success) {
      console.warn(`[shortcuts] Failed to register ${def.accelerator}`);
    }
  }

  registered = true;

  // Also register IPC handler so the renderer can request the shortcuts
  // map for documentation / keyboard-shortcuts modal.
  handleTrustedIpc('shortcuts:getMap', () => {
    return getShortcutsMap();
  });
}

/**
 * Unregister all global shortcuts.
 * Call on will-quit to avoid leaving stale bindings.
 */
export function unregisterAllShortcuts(): void {
  if (!registered) return;
  globalShortcut.unregisterAll();
  registered = false;
}

/**
 * Return a record of accelerator → label for documentation purposes.
 */
export function getShortcutsMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const def of getDefs()) {
    map[def.accelerator] = def.label;
  }
  return map;
}

/**
 * Check whether any shortcuts are currently registered.
 */
export function isRegistered(): boolean {
  return registered;
}
