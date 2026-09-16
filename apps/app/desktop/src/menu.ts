/**
 * Application menu builder.
 *
 * Builds a full macOS/Windows/Linux menu with File, Edit, View, Window,
 * Agent, and Help menus. The Window menu includes a dynamic list of open
 * windows that stays in sync as windows open, close, and change focus.
 */

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';
import {
  getAllWindows,
  getPrimaryWindow,
  focusWindow,
  closeWindow,
  getWindowCount,
  getCreateWindowFactory,
  type WindowInfo,
} from './window-manager';
import { safeExternalHttpUrl } from './security/renderer-url-policy';
import { sendToTrustedRenderer } from './security/trusted-renderers';
import { configureAutoUpdater } from './update-policy';

// ── Helpers ──

const isMac = process.platform === 'darwin';

/** Send an IPC message to the focused window's renderer. */
function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) {
    sendToTrustedRenderer(win.webContents, channel, ...args);
  }
}

/** Send to primary window (fallback if no focused window). */
function sendToPrimary(channel: string, ...args: unknown[]): void {
  const primary = getPrimaryWindow();
  if (primary && !primary.isDestroyed()) {
    sendToTrustedRenderer(primary.webContents, channel, ...args);
  }
}

/** Send to all renderers. */
function sendToAll(channel: string, ...args: unknown[]): void {
  for (const entry of getAllWindows()) {
    if (!entry.win.isDestroyed()) {
      sendToTrustedRenderer(entry.win.webContents, channel, ...args);
    }
  }
}

/**
 * Build the dynamic window list submenu for the Window menu.
 * Lists all non-destroyed windows, checkmarks the focused one.
 */
function buildWindowListSubmenu(): MenuItemConstructorOptions[] {
  const all = getAllWindows().filter((e) => !e.win.isDestroyed());
  const focusedId = BrowserWindow.getFocusedWindow()?.webContents.id ?? -1;

  if (all.length === 0) {
    return [{ label: 'No Open Windows', enabled: false }];
  }

  return all.map((entry, index) => {
    const label = entry.title || 'OpenAgent';
    const isFocused = entry.id === focusedId;
    const typeIndicator = entry.type === 'primary'
      ? ''
      : entry.type === 'standalone-agent'
        ? ` [${entry.accountId ?? 'agent'}]`
        : '';

    return {
      label: `${index + 1}  ${label}${typeIndicator}`,
      type: 'checkbox',
      checked: isFocused,
      click: () => focusWindow(entry.id),
    };
  });
}

// ── Menu template factory ──

/**
 * Build the full application menu template.
 * Called on startup and whenever the window list changes.
 */
export function buildMenu(): Menu {
  // The templates that don't change between rebuilds.
  const template: MenuItemConstructorOptions[] = [];

  // ── App menu (macOS only) ──
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendToAll('menu:openSettings') },
        { type: 'separator' },
        { label: 'Hide OpenAgent', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  // ── File ──
  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Window',
        accelerator: 'CmdOrCtrl+N',
        click: () => {
          const factory = getCreateWindowFactory();
          if (factory) { factory({ markChild: true }); rebuildMenu(); }
        },
      },
      {
        label: 'New Agent Window',
        accelerator: 'CmdOrCtrl+Shift+N',
        click: () => {
          const factory = getCreateWindowFactory();
          if (factory) { factory({}); rebuildMenu(); }
        },
      },
      { type: 'separator' },
      {
        label: 'Close Window',
        accelerator: 'CmdOrCtrl+W',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) closeWindow(win.webContents.id);
        },
      },
      {
        label: 'Close All Child Windows',
        accelerator: 'CmdOrCtrl+Shift+W',
        click: () => sendToPrimary('menu:closeAllChildren'),
      },
      // Quit only appears here on non-mac (mac has it in the app menu)
      ...(isMac
        ? []
        : [
            { type: 'separator' as const },
            { label: 'Quit', accelerator: 'Ctrl+Q', role: 'quit' as const },
          ]),
    ],
  });

  // ── Edit ──
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  });

  // ── Navigate (app navigation) ──
  template.push({
    label: 'Navigate',
    submenu: [
      {
        label: 'Memory Vault',
        accelerator: 'CmdOrCtrl+Shift+V',
        click: () => sendToFocused('menu:navigate', '/vault'),
      },
      {
        label: 'Scheduled Tasks',
        accelerator: 'CmdOrCtrl+Shift+T',
        click: () => sendToFocused('menu:navigate', '/scheduled'),
      },
      {
        label: 'Workflows',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => sendToFocused('menu:navigate', '/workflows'),
      },
      {
        label: 'Active Sessions',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => sendToFocused('menu:navigate', '/sessions'),
      },
      {
        label: 'Connectors & MCPs',
        accelerator: 'CmdOrCtrl+Shift+C',
        click: () => sendToFocused('menu:navigate', '/connectors'),
      },
      { type: 'separator' },
      {
        label: 'Settings',
        accelerator: 'CmdOrCtrl+,',
        click: () => sendToAll('menu:openSettings'),
      },
      { type: 'separator' },
      {
        label: 'Quick Jump…',
        accelerator: 'CmdOrCtrl+J',
        click: () => sendToFocused('menu:quickJump'),
      },
      {
        label: 'Quick Create…',
        accelerator: 'CmdOrCtrl+Shift+K',
        click: () => sendToFocused('menu:quickCreate'),
      },
    ],
  });

  // ── View ──
  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) win.reload();
        },
      },
      {
        label: 'Force Reload',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
        },
      },
      {
        label: 'Toggle DevTools',
        accelerator: 'CmdOrCtrl+Shift+I',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.isDevToolsOpened()
              ? win.webContents.closeDevTools()
              : win.webContents.openDevTools();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+=',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
          }
        },
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
          }
        },
      },
      {
        label: 'Reset Zoom',
        accelerator: 'CmdOrCtrl+0',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.setZoomLevel(0);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Toggle Fullscreen',
        accelerator: isMac ? 'Ctrl+Cmd+F' : 'CmdOrCtrl+Shift+F',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && !win.isDestroyed()) {
            win.setFullScreen(!win.isFullScreen());
          }
        },
      },
    ],
  });

  // ── Window ──
  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? [
            { type: 'separator' as const },
            { role: 'front' as const },
          ]
        : []),
      { type: 'separator' },
      // Dynamic window list — rebuilt on each call
      ...buildWindowListSubmenu(),
    ],
  });

  // ── Agent ──
  template.push({
    label: 'Agent',
    submenu: [
      {
        label: 'Switch Agent…',
        accelerator: 'CmdOrCtrl+Shift+A',
        click: () => sendToFocused('menu:switchAgent'),
      },
      {
        label: 'Open Agent in New Window',
        click: () => {
          const factory = getCreateWindowFactory();
          if (factory) { factory({}); rebuildMenu(); }
        },
      },
      {
        label: 'Active Sessions',
        click: () => sendToFocused('menu:navigate', '/sessions'),
      },
      { type: 'separator' },
      {
        label: 'Agent Settings',
        click: () => sendToAll('menu:openSettings'),
      },
    ],
  });

  // ── Help ──
  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'About OpenAgent',
        click: () => {
          // Show Electron's about panel (configured in main.ts).
          app.showAboutPanel();
        },
      },
      {
        label: 'Check for Updates',
        click: () => {
          // Trigger the auto-updater check. The renderer can surface the
          // result, but we fire the native check here too.
          sendToPrimary('menu:checkForUpdates');
          try {
            const { autoUpdater } = require('electron-updater');
            const policy = configureAutoUpdater(autoUpdater, app.getVersion());
            // This path is explicitly initiated by the user. A beta may
            // download here, but choosing "Later" must never install it on
            // quit without launch-crash recovery.
            autoUpdater.autoDownload = true;
            autoUpdater.autoInstallOnAppQuit = policy.installOnQuit;
            autoUpdater.checkForUpdatesAndNotify();
          } catch {
            // Not available in dev — silently ignore.
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Keyboard Shortcuts',
        accelerator: 'CmdOrCtrl+/',
        click: () => sendToAll('menu:openShortcuts'),
      },
      { type: 'separator' },
      {
        label: 'OpenAgent Website',
        click: () => {
          const url = safeExternalHttpUrl('https://openagent.uno/');
          if (url) void shell.openExternal(url);
        },
      },
    ],
  });

  return Menu.buildFromTemplate(template);
}

/**
 * Rebuild the application menu and set it.
 * Call after any window open, close, or focus change to keep the
 * Window menu's dynamic window list up to date.
 */
export function rebuildMenu(): void {
  const menu = buildMenu();
  Menu.setApplicationMenu(menu);
}

/**
 * Register event listeners that auto-rebuild the menu when window
 * focus changes. Call once on app ready.
 */
export function setupMenuAutoRebuild(): void {
  app.on('browser-window-focus', () => {
    rebuildMenu();
  });
}
