/**
 * macOS dock menu.
 *
 * Sets a custom dock menu with quick actions: New Window, New Agent
 * Window, and a dynamic list of recent agents. No-op on non-mac.
 */

import { app, BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { getPrimaryWindow, getCreateWindowFactory } from './window-manager';
import { sendToTrustedRenderer } from './security/trusted-renderers';

// ── Globals ──

/** Shared agent list (mirrors the tray's list for consistency). */
let recentAgentList: string[] = [];

// ── Menu builder ──

function buildDockMenu(): Menu {
  const items: MenuItemConstructorOptions[] = [
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
        const primary = getPrimaryWindow();
        if (primary && !primary.isDestroyed()) {
          sendToTrustedRenderer(primary.webContents, 'menu:navigate', '/vault');
        }
      },
    },
    {
      label: 'Scheduled Tasks',
      click: () => {
        const primary = getPrimaryWindow();
        if (primary && !primary.isDestroyed()) {
          sendToTrustedRenderer(primary.webContents, 'menu:navigate', '/scheduled');
        }
      },
    },
  ];

  if (recentAgentList.length > 0) {
    items.push({ type: 'separator' });
    for (const agent of recentAgentList) {
      items.push({
        label: agent,
        click: () => {
          const primary = getPrimaryWindow();
          if (primary && !primary.isDestroyed()) {
            sendToTrustedRenderer(primary.webContents, 'menu:openAgent', agent);
          }
        },
      });
    }
  }

  return Menu.buildFromTemplate(items);
}

// ── Public API ──

/**
 * Set up the macOS dock menu.
 * No-op on non-mac platforms.
 */
export function setupDockMenu(): void {
  if (process.platform !== 'darwin') return;

  const menu = buildDockMenu();
  app.dock?.setMenu(menu);
}

/**
 * Update the recent agents list shown in the dock menu.
 */
export function updateDockAgentList(agents: string[]): void {
  recentAgentList = agents;

  if (process.platform === 'darwin') {
    const menu = buildDockMenu();
    app.dock?.setMenu(menu);
  }
}
