/**
 * Centralised window registry.
 *
 * Tracks every BrowserWindow the app manages — primary, relay children,
 * and standalone agent windows — and provides lookup/control helpers so
 * other modules (menu, tray, shortcuts, dock) never touch window sets
 * directly.
 */

import { BrowserWindow } from 'electron';

// ── Types ──

export type WindowType = 'primary' | 'relay-child' | 'standalone-agent';

export interface WindowInfo {
  /** The Electron BrowserWindow instance. */
  win: BrowserWindow;
  /** The window's webContents.id (immutable, the canonical key). */
  id: number;
  /** Role this window plays in the app. */
  type: WindowType;
  /** For standalone agent windows, the bound account id. */
  accountId?: string;
  /** Window title (defaults to 'OpenAgent'). Updated on page-title-changed. */
  title: string;
  /** The route this window loaded (home page if empty). */
  route?: string;
}

// ── Registry ──

/** Map keyed by webContents.id for O(1) lookups. */
const registry = new Map<number, WindowInfo>();

// ── Helpers ──

/**
 * Register a window into the central registry.
 * Returns the assigned WindowInfo (mutated in-place for future updates).
 */
export function registerWindow(
  win: BrowserWindow,
  info: Omit<WindowInfo, 'id' | 'win'>,
): WindowInfo {
  const id = win.webContents.id;
  const entry: WindowInfo = {
    win,
    id,
    type: info.type,
    accountId: info.accountId,
    title: info.title || 'OpenAgent',
    route: info.route,
  };
  registry.set(id, entry);

  // Keep title in sync as pages change it.
  const onTitleChange = (_event: unknown, title: string) => {
    const existing = registry.get(id);
    if (existing) existing.title = title;
  };
  win.on('page-title-updated', onTitleChange);

  // Auto-unregister on close.
  win.on('closed', () => {
    registry.delete(id);
    win.removeListener('page-title-updated', onTitleChange);
  });

  return entry;
}

/**
 * Remove a window from the registry by its webContents id.
 * Safe to call multiple times for the same id.
 */
export function unregisterWindow(webContentsId: number): void {
  registry.delete(webContentsId);
}

/** Return a snapshot of every tracked window. */
export function getAllWindows(): WindowInfo[] {
  return Array.from(registry.values());
}

/** Return the primary window, or null if none exists. */
export function getPrimaryWindow(): BrowserWindow | null {
  for (const entry of registry.values()) {
    if (entry.type === 'primary' && !entry.win.isDestroyed()) {
      return entry.win;
    }
  }
  return null;
}

/** Look up a window by its webContents id. */
export function getWindowById(id: number): BrowserWindow | null {
  const entry = registry.get(id);
  if (!entry || entry.win.isDestroyed()) return null;
  return entry.win;
}

/** Return all windows bound to a specific account (standalone agents). */
export function getWindowsByAccount(accountId: string): WindowInfo[] {
  const results: WindowInfo[] = [];
  for (const entry of registry.values()) {
    if (entry.accountId === accountId && !entry.win.isDestroyed()) {
      results.push(entry);
    }
  }
  return results;
}

/** Total number of live (non-destroyed) windows. */
export function getWindowCount(): number {
  let count = 0;
  for (const entry of registry.values()) {
    if (!entry.win.isDestroyed()) count++;
  }
  return count;
}

/** Bring a window to front and focus it. */
export function focusWindow(id: number): void {
  const entry = registry.get(id);
  if (!entry || entry.win.isDestroyed()) return;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.show();
  entry.win.focus();
}

/**
 * Close a window by id. Will NOT close the primary window on non-mac
 * platforms (where closing the last window quits the app).
 */
export function closeWindow(id: number): void {
  const entry = registry.get(id);
  if (!entry || entry.win.isDestroyed()) return;

  // On non-mac, closing the primary window would quit the app.
  if (
    entry.type === 'primary' &&
    process.platform !== 'darwin'
  ) {
    entry.win.minimize();
    return;
  }

  entry.win.close();
}

/**
 * Return the WindowInfo for a given webContents id, or null.
 */
export function getWindowInfo(id: number): WindowInfo | null {
  const entry = registry.get(id);
  if (!entry || entry.win.isDestroyed()) return null;
  return entry;
}

/**
 * Find which window type a given webContents id belongs to.
 * Shorthand for getWindowInfo(id)?.type ?? null.
 */
export function getWindowType(id: number): WindowType | null {
  const entry = registry.get(id);
  if (!entry || entry.win.isDestroyed()) return null;
  return entry.type;
}

/**
 * Update the route stored for a window (e.g. after renderer navigates).
 */
export function updateWindowRoute(id: number, route: string): void {
  const entry = registry.get(id);
  if (entry) entry.route = route;
}

// ── Cross-module bridge: window creation ──
// menu.ts and shortcuts.ts need to create windows but can't import the
// `createWindow` function from main.ts (circular).  main.ts registers
// its `createWindow` here once it's ready; consumers call the getter.

type CreateWindowFn = (opts: {
  route?: string;
  markChild?: boolean;
  connectAccountId?: string;
}) => import('electron').BrowserWindow;

let _createWindow: CreateWindowFn | null = null;

/** Register the createWindow factory from main.ts. */
export function setCreateWindowFactory(fn: CreateWindowFn): void {
  _createWindow = fn;
}

/** Return the registered factory, or null if not yet registered. */
export function getCreateWindowFactory(): CreateWindowFn | null {
  return _createWindow;
}
