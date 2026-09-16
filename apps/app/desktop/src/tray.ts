/**
 * System tray icon and menu.
 *
 * Provides a persistent tray icon with quick actions: show/hide main
 * window, open new windows, list recent agents, and quit.
 */

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, nativeImage, NativeImage, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  getPrimaryWindow,
  getWindowCount,
  getAllWindows,
  focusWindow,
  getCreateWindowFactory,
} from './window-manager';
import type { DesktopCapabilityStatus } from './capabilities/protocol';
import { sendToTrustedRenderer } from './security/trusted-renderers';

// ── Globals ──

let tray: Tray | null = null;

/** Cached agent list shared between tray and dock. */
let recentAgentList: string[] = [];
let capabilityStatus: DesktopCapabilityStatus | null = null;
let emergencyDisable: (() => void | Promise<void>) | null = null;

// ── Icon ──

/**
 * Resolve the tray icon path across dev and production environments.
 *
 * In dev, the icon lives in ``universal/assets/openagent-icon.png``.
 * In production, the bundle script copies it into ``dist/tray-icon.png``
 * so it ships inside the asar alongside the compiled JS.
 */
function resolveTrayIconPath(): string {
  // Production: tray icon copied into dist/ by the bundle script.
  const prodPath = path.join(__dirname, 'tray-icon.png');
  try {
    if (fs.existsSync(prodPath)) return prodPath;
  } catch { /* fall through */ }

  // Dev: icon in the universal assets directory.
  return path.join(__dirname, '..', '..', 'universal', 'assets', 'openagent-icon.png');
}

/**
 * Load the OpenAgent icon as a macOS template tray icon.
 *
 * On macOS template images are rendered by the system in the correct
 * colour for the current menu-bar appearance (dark in light mode,
 * white in dark mode). We resize to tray-native size (22pt macOS,
 * 16px Windows) and avoid pixel-level manipulation — the source PNG
 * is already crisp at these dimensions.
 */
function generateTrayIcon(): NativeImage {
  const iconPath = resolveTrayIconPath();
  const sourceImg = nativeImage.createFromPath(iconPath);

  if (sourceImg.isEmpty()) {
    console.error(`[tray] failed to load icon from ${iconPath}`);
    return nativeImage.createEmpty();
  }

  const traySize = process.platform === 'win32' ? 16 : 22;
  const resized = sourceImg.resize({ width: traySize, height: traySize });

  // Template mode: macOS draws the icon's alpha channel, ignoring
  // RGB, so it automatically looks correct in light AND dark menu bars.
  if (process.platform === 'darwin') {
    resized.setTemplateImage(true);
  }

  return resized;
}

// ── Tray menu builder ──

/**
 * Build the tray context menu from current state.
 */
function buildTrayMenu(): Menu {
  const primary = getPrimaryWindow();
  const isVisible = primary !== null && primary.isVisible() && !primary.isMinimized();

  const items: MenuItemConstructorOptions[] = [
    {
      label: isVisible ? 'Hide OpenAgent' : 'Show OpenAgent',
      click: () => {
        if (primary && !primary.isDestroyed()) {
          if (primary.isVisible() && !primary.isMinimized()) {
            primary.hide();
          } else {
            if (primary.isMinimized()) primary.restore();
            primary.show();
            primary.focus();
          }
        }
      },
    },
    { type: 'separator' },
    {
      label: capabilityTrayLabel(capabilityStatus),
      enabled: false,
    },
    {
      label: 'Emergency Disable Local Access',
      enabled: !!capabilityStatus?.consent.enabled,
      click: () => { void emergencyDisable?.(); },
    },
    { type: 'separator' },
    {
      label: 'New Window',
      click: () => {
        const factory = getCreateWindowFactory();
        if (factory) factory({ markChild: true });
      },
    },
    {
      label: 'New Agent Window',
      click: () => {
        const factory = getCreateWindowFactory();
        if (factory) factory({});
      },
    },
    { type: 'separator' },
    {
      label: 'Memory Vault',
      click: () => {
        const focused = BrowserWindow.getFocusedWindow();
        const target = focused ?? primary;
        if (target && !target.isDestroyed()) {
          sendToTrustedRenderer(target.webContents, 'menu:navigate', '/vault');
        }
      },
    },
    {
      label: 'Scheduled Tasks',
      click: () => {
        const focused = BrowserWindow.getFocusedWindow();
        const target = focused ?? primary;
        if (target && !target.isDestroyed()) {
          sendToTrustedRenderer(target.webContents, 'menu:navigate', '/scheduled');
        }
      },
    },
    {
      label: 'Workflows',
      click: () => {
        const focused = BrowserWindow.getFocusedWindow();
        const target = focused ?? primary;
        if (target && !target.isDestroyed()) {
          sendToTrustedRenderer(target.webContents, 'menu:navigate', '/workflows');
        }
      },
    },
    {
      label: 'Active Sessions',
      click: () => {
        const focused = BrowserWindow.getFocusedWindow();
        const target = focused ?? primary;
        if (target && !target.isDestroyed()) {
          sendToTrustedRenderer(target.webContents, 'menu:navigate', '/sessions');
        }
      },
    },
  ];

  // Recent Agents submenu
  if (recentAgentList.length > 0) {
    items.push({
      label: 'Recent Agents',
      submenu: recentAgentList.map((agent) => ({
        label: agent,
        click: () => {
          const focused = BrowserWindow.getFocusedWindow();
          const target = focused ?? primary;
          if (target && !target.isDestroyed()) {
            sendToTrustedRenderer(target.webContents, 'menu:openAgent', agent);
          }
        },
      })),
    });
    items.push({ type: 'separator' });
  }

  items.push({
    label: 'Quit',
    click: () => {
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

// ── Public API ──

/**
 * Create the system tray icon and menu.
 * Call once on app ready. No-op if a tray already exists.
 */
export function createTray(): Tray | null {
  if (tray) return tray;

  try {
    const icon = generateTrayIcon();
    if (icon.isEmpty()) {
      console.error('[tray] cannot create tray: icon is empty');
      return null;
    }

    tray = new Tray(icon);
    tray.setToolTip('OpenAgent');

    const menu = buildTrayMenu();
    tray.setContextMenu(menu);

    // Click on tray icon toggles the primary window.
    tray.on('click', () => {
      const primary = getPrimaryWindow();
      if (primary && !primary.isDestroyed()) {
        if (primary.isVisible() && !primary.isMinimized()) {
          primary.hide();
        } else {
          if (primary.isMinimized()) primary.restore();
          primary.show();
          primary.focus();
        }
      }
    });

    console.log('[tray] created successfully');
  } catch (err) {
    console.error('[tray] creation failed:', err);
    tray = null;
  }

  return tray;
}

/**
 * Update the recent agents list shown in the tray submenu.
 * Call when the user switches agents or when the agent list changes.
 */
export function updateTrayAgentList(agents: string[]): void {
  recentAgentList = agents;
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

/** Configure the tray's device-access kill switch once main is ready. */
export function configureCapabilityTray(onEmergencyDisable: () => void | Promise<void>): void {
  emergencyDisable = onEmergencyDisable;
  refreshTrayMenu();
}

/** Reflect capability connectivity/activity without exposing execution IPC. */
export function updateTrayCapabilityStatus(status: DesktopCapabilityStatus): void {
  capabilityStatus = status;
  if (tray) {
    const suffix = status.phase === 'active'
      ? ` — ${status.activeCalls} local tool${status.activeCalls === 1 ? '' : 's'} active`
      : status.consent.enabled ? ` — local access ${status.phase}` : ' — local access disabled';
    tray.setToolTip(`OpenAgent${suffix}`);
    tray.setContextMenu(buildTrayMenu());
  }
}

/**
 * Get the current tray instance (null if not created).
 */
export function getTray(): Tray | null {
  return tray;
}

/**
 * Refresh the tray menu (e.g. after window visibility changes).
 */
export function refreshTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

/**
 * Destroy the tray (called on quit or when cleaning up).
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function capabilityTrayLabel(status: DesktopCapabilityStatus | null): string {
  if (!status) return 'Local Access: Loading…';
  if (!status.consent.enabled) return 'Local Access: Disabled';
  if (status.phase === 'active') return `Local Access: ${status.activeCalls} Active`;
  if (status.phase === 'connected') return 'Local Access: Connected';
  if (status.phase === 'unavailable') return 'Local Access: Unavailable';
  if (status.phase === 'starting' || status.phase === 'connecting') return 'Local Access: Connecting…';
  return 'Local Access: Ready';
}
