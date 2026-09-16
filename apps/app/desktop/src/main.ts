/**
 * Electron main process.
 *
 * Dev:  loads from Expo web dev server (localhost:8081)
 * Prod: serves web-build via a local HTTP server (Expo Router needs
 *       proper URL routing which file:// can't provide)
 *
 * Integrates window-manager, shortcuts, menu, tray, and dock modules
 * for a complete desktop-window management experience.
 */

import { app, BrowserWindow, shell, dialog, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { registerStorageHandlers } from './services/storage';
import {
  configureLoopbackLifecycleHooks,
  getVerifiedLoopbackTarget,
  installTestLoopback,
  registerLoopbackHandlers,
  releaseLoopbackReservation,
  stopAllLoopbacks,
  transferLoopbackAttempt,
} from './services/loopback';
import { registerCredentialHandlers } from './services/credentials';
import { findWindowForVerifiedTarget } from './network/agent-window-routing';
import { decodeTicket } from './network/ticket';
import { CapabilityConsentStore } from './capabilities/consent-store';
import { discoverHostTools } from './capabilities/host-bridge';
import { broadcastCapabilityStatus, registerCapabilityHandlers } from './capabilities/ipc';
import { CapabilityManager } from './capabilities/manager';
import {
  buildRendererTarget,
  createRendererUrlPolicy,
} from './security/renderer-url-policy';
import { resolveStaticFile } from './security/static-file-policy';
import {
  registerTrustedRenderer,
  sendToTrustedRenderer,
  unregisterTrustedRenderer,
} from './security/trusted-renderers';
import { handleTrustedIpc, onTrustedIpc } from './security/trusted-ipc';
import {
  applyLocalE2EProfile,
  desktopRuntimePolicy,
  resolveLocalE2EProfile,
} from './local-e2e-profile';

// ── New desktop-controls modules ──
import {
  registerWindow,
  unregisterWindow,
  getPrimaryWindow as getPrimaryFromRegistry,
  getAllWindows,
  getWindowsByAccount,
  focusWindow,
  closeWindow,
  getWindowCount,
  setCreateWindowFactory,
} from './window-manager';
import { registerAllShortcuts, unregisterAllShortcuts, getShortcutsMap } from './shortcuts';
import { buildMenu, rebuildMenu, setupMenuAutoRebuild } from './menu';
import {
  configureCapabilityTray,
  createTray,
  updateTrayAgentList,
  updateTrayCapabilityStatus,
  destroyTray,
} from './tray';
import { setupDockMenu, updateDockAgentList } from './dock';
import { configureAutoUpdater, shouldAcceptUpdate } from './update-policy';
import {
  PRODUCTION_CSP,
  resolveDevServerUrl,
} from './security-policy';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tiff']);
// Random for every Electron-main boot, shared by every window and every
// account tunnel in this process. The server binds interactive turns to this
// exact instance; automatic/server-originated turns never receive it.
const CLIENT_INSTANCE_ID = randomUUID();

// Hard cap on ``dialog:readFile`` IPC payloads so a single runaway attachment
// can't OOM the renderer. The renderer streams these into a Blob before the
// HTTP upload; 200 MB covers any normal user attachment (PDFs, images, short
// videos) without letting the user accidentally paste their whole Downloads
// folder into memory.
const MAX_READ_BYTES = 200 * 1024 * 1024;

// Paths the user has explicitly picked through ``dialog:pickFiles`` in this
// session — ``dialog:readFile`` only accepts paths that show up here. This is
// defense-in-depth: we don't *believe* the renderer is hostile, but we also
// don't want a malicious page loaded via file:// in dev mode (or a compromised
// third-party script) to read ~/.ssh/id_rsa just because the renderer can
// send arbitrary IPC args.
const pickedPaths = new Set<string>();

function registerDialogHandlers(): void {
  handleTrustedIpc('dialog:pickFiles', async () => {
    const focused = BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
    };
    const result = focused
      ? await dialog.showOpenDialog(focused, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths.length) return [];
    for (const p of result.filePaths) pickedPaths.add(p);
    // Return size alongside the path so the renderer can reject files
    // over MAX_READ_BYTES *before* it triggers the IPC readFile (which
    // would otherwise fail with a generic "readFile: too big" string
    // mid-upload). For files we can't stat (broken symlink, etc.) we
    // fall back to size=-1 and let the readFile guard surface the real
    // error.
    return Promise.all(result.filePaths.map(async (p) => {
      let size = -1;
      try {
        const st = await fs.promises.stat(p);
        if (st.isFile()) size = st.size;
      } catch { /* fall through with -1 */ }
      return {
        path: p,
        filename: path.basename(p),
        kind: IMAGE_EXTS.has(path.extname(p).toLowerCase()) ? 'image' : 'file',
        size,
        maxBytes: MAX_READ_BYTES,
      };
    }));
  });

  // Read a file's bytes so the renderer can upload it via /api/upload.
  //
  // The **only** way the renderer can get bytes for an arbitrary local file
  // is via this IPC — Electron renderers with contextIsolation + no
  // nodeIntegration don't have ``fs``. We restrict reads to paths the user
  // has actually picked via the native dialog in this session, so the path
  // string is effectively a capability token issued by the OS file picker
  // rather than a free-form argument.
  handleTrustedIpc('dialog:readFile', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') {
      throw new Error('readFile: path must be a string');
    }
    if (!pickedPaths.has(filePath)) {
      throw new Error('readFile: path was not picked via the native dialog');
    }
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`readFile: ${filePath} is not a regular file`);
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(
        `readFile: ${filePath} is ${stat.size} bytes (limit ${MAX_READ_BYTES})`,
      );
    }
    // Buffer crosses the IPC boundary as a Node Buffer which Electron
    // structured-clones into the renderer as a Uint8Array. No base64.
    return fs.promises.readFile(filePath);
  });

  // Deep-link the OS privacy pane so the user can grant mic access
  // without hunting through System Settings. Each platform exposes a
  // different URL scheme; falls back to ``no-op`` on platforms we
  // don't have a target for (the renderer should still log + show
  // instructions).
  handleTrustedIpc('app:openMicSettings', async () => {
    try {
      if (process.platform === 'darwin') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
        return true;
      }
      if (process.platform === 'win32') {
        await shell.openExternal('ms-settings:privacy-microphone');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });
}

const isDev = !app.isPackaged;
const packagedSmoke = process.argv.includes('--packaged-smoke');
const localE2EProfile = resolveLocalE2EProfile(process.argv);
const localE2E = localE2EProfile != null;
const runtimePolicy = desktopRuntimePolicy({
  isPackaged: app.isPackaged,
  packagedSmoke,
  localE2E,
});
const expectedSmokeVersion = process.argv
  .find((value) => value.startsWith('--expected-version='))
  ?.slice('--expected-version='.length);

if (localE2EProfile) {
  applyLocalE2EProfile(localE2EProfile, (value) => app.setPath('userData', value));
}

app.setAboutPanelOptions({
  applicationName: 'OpenAgent',
  applicationVersion: app.getVersion(),
  website: 'https://openagent.uno/',
});

if (process.platform === 'win32') {
  app.setAppUserModelId('ai.openagent.desktop');
}

const gotLock = runtimePolicy.bypassSingleInstanceLock || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
// Every secondary window (relay-child OR standalone agent window). Tracked so
// closing the primary can tear them all down.
const childWindows = new Set<BrowserWindow>();
// webContents ids of *relay* children only — the ones that tunnel their WS
// through the primary window (opened with ``markChild``). Standalone agent
// windows (own loopback + own WS) are deliberately excluded so the primary's
// broadcast never leaks another agent's frames into them.
const relayChildIds = new Set<number>();
let primaryWindowId: number | null = null;
let staticServer: http.Server | null = null;
let staticPort = 0;
let capabilityManager: CapabilityManager | null = null;
let shutdownInProgress = false;
let shutdownComplete = false;

// ── Static file server for production ──

function startStaticServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    // When packaged, web-build is shipped as an extraResource (outside the
    // asar), because electron-builder's default file filter strips any path
    // containing `node_modules` — which Expo's export uses for vendored
    // asset paths (e.g. `assets/node_modules/@react-navigation/.../*.png`).
    const webBuildDir = app.isPackaged
      ? path.join(process.resourcesPath, 'web-build')
      : path.resolve(__dirname, '..', 'web-build');

    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.map': 'application/json',
    };

    if (!fs.existsSync(webBuildDir)) {
      console.error(`[openagent] web-build directory missing: ${webBuildDir}`);
      return reject(new Error(`web-build directory missing at ${webBuildDir}`));
    }

    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Method not allowed');
        return;
      }
      // Strip query strings & fragments, decode percent-encoded chars
      const rawUrl = (req.url || '/').split('?')[0].split('#')[0];
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(rawUrl);
      } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }

      const resolution = resolveStaticFile(webBuildDir, urlPath);
      if (resolution.kind === 'forbidden') {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (resolution.kind === 'not_found') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const filePath = resolution.path;
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Security-Policy': PRODUCTION_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch (err) {
        console.error(`[openagent] 404 ${req.url} -> ${filePath}`);
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      staticServer = server;
      console.log(`[openagent] static server listening on 127.0.0.1:${port} serving ${webBuildDir}`);
      resolve(port);
    });

    server.on('error', reject);
  });
}

// ── Window ──

/** Extract a terminal id from a detached route like ``terminal/<id>?cwd=…``. */
function terminalIdFromRoute(route?: string): string | null {
  if (!route) return null;
  const m = route.match(/^terminal\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

interface CreateWindowOptions {
  /** Relative route to load (no leading slash). Omitted → app root. */
  route?: string;
  /** Mark as a relay child: tunnels its WS through the primary window's
   *  live socket (shared agent). Used for same-agent detached views. */
  markChild?: boolean;
  /** Standalone agent window: boots at ``/?connect=<id>`` and opens its
   *  OWN connection to that account's already-running loopback. Mutually
   *  exclusive with ``markChild`` — a standalone window is never a relay
   *  child. */
  connectAccountId?: string;
}

function createWindow(opts: CreateWindowOptions = {}): BrowserWindow {
  const { route, markChild = false, connectAccountId } = opts;
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    title: 'OpenAgent',
    // Frameless on every desktop OS: the renderer draws its own
    // WindowControls (in the sidebar's top-left on macOS, in the chrome
    // Header on Win/Linux). Native macOS traffic lights are pushed
    // off-screen so they don't double up with the custom ones.
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: -200, y: 0 } }
      : { frame: false }),
    show: true,
    backgroundColor: '#050810',  // match JARVIS dark theme bg
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      additionalArguments: [`--openagent-client-instance-id=${CLIENT_INSTANCE_ID}`],
    },
  });
  // Electron 43 invalidates BrowserWindow.webContents before emitting
  // `closed`. Retain the exact registered object now so lifecycle cleanup
  // never dereferences a destroyed BrowserWindow.
  const trustedContents = win.webContents;
  const webContentsId = trustedContents.id;

  const testRendererUrl = isDev && process.env.NODE_ENV === 'test'
    && process.env.OPENAGENT_DESKTOP_E2E === '1'
    ? process.env.OPENAGENT_DESKTOP_E2E_RENDERER_URL?.trim()
    : undefined;
  const baseUrl = testRendererUrl
    || (runtimePolicy.useStaticRenderer
      ? `http://127.0.0.1:${staticPort}`
      : resolveDevServerUrl(process.env.OPENAGENT_DEV_SERVER_PORT));
  const rendererPolicy = createRendererUrlPolicy(baseUrl);
  // Register authority and navigation guards before the first document load.
  registerTrustedRenderer(win, rendererPolicy, (url) => shell.openExternal(url));
  // An explicit route is rooted at the trusted origin; when omitted, retain
  // the configured base path (the E2E fixture and future embedded exports can
  // boot directly into a route such as /settings).
  const target = route === undefined
    ? new URL(baseUrl)
    : buildRendererTarget(rendererPolicy, route);
  if (connectAccountId) target.searchParams.set('connect', connectAccountId);
  if (markChild) target.searchParams.set('child', '1');
  void win.loadURL(target.toString());

  if (markChild) relayChildIds.add(webContentsId);

  // ── Register with the central window manager ──
  const windowType = connectAccountId
    ? 'standalone-agent'
    : markChild
      ? 'relay-child'
      : 'primary';
  registerWindow(win, {
    type: windowType,
    accountId: connectAccountId,
    title: 'OpenAgent',
    route,
  });

  win.on('closed', () => {
    unregisterTrustedRenderer(trustedContents);
    childWindows.delete(win);
    relayChildIds.delete(webContentsId);
    // Also unregister from the central registry.
    unregisterWindow(webContentsId);

    // Rebuild the menu so the Window list updates.
    rebuildMenu();

    // Closing an OS window destroys its renderer without running React
    // cleanup, so a terminal window can't send its own ``terminal_close``.
    // Relay one through the primary window's gateway socket here so the
    // PTY on the host is reaped instead of lingering until app exit.
    const terminalId = terminalIdFromRoute(route);
    if (terminalId && primaryWindowId) {
      const primary = BrowserWindow.fromId(primaryWindowId);
      if (primary && !primary.isDestroyed() && primary.webContents.id !== webContentsId) {
        sendToTrustedRenderer(
          primary.webContents,
          'ws:relay-from-child',
          JSON.stringify({ type: 'terminal_close', terminal_id: terminalId }),
        );
      }
    }
  });

  childWindows.add(win);

  if (!mainWindow) {
    mainWindow = win;
    mainWindow.on('closed', () => {
      mainWindow = null;
      primaryWindowId = null;
      closeAllChildWindows();
    });
  }

  if (!primaryWindowId) {
    primaryWindowId = webContentsId;
  }

  return win;
}

function closeAllChildWindows(): void {
  for (const win of [...childWindows]) {
    if (!win.isDestroyed() && win.webContents.id !== primaryWindowId) {
      win.close();
    }
  }
}

/** Bind the deterministic loopback supplied by the Playwright harness.
 *
 * No renderer method can install or select this target. The hook is accepted
 * only by an unpackaged, explicit test process and only for a loopback URL,
 * so production authentication and Iroh routing remain the sole path.
 */
function installConfiguredTestLoopback(): void {
  if (
    !isDev || process.env.NODE_ENV !== 'test' ||
    process.env.OPENAGENT_DESKTOP_E2E !== '1'
  ) return;
  const raw = process.env.OPENAGENT_DESKTOP_E2E_LOOPBACK?.trim();
  if (!raw) return;

  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch {
    throw new Error('OPENAGENT_DESKTOP_E2E_LOOPBACK must be a JSON object');
  }
  const required = [
    'account_id', 'base_url', 'network_name', 'network_id', 'device_id',
    'handle', 'coordinator_node_id', 'agent_node_id', 'agent_handle',
  ] as const;
  for (const key of required) {
    if (typeof value[key] !== 'string' || !(value[key] as string).length) {
      throw new Error(`OPENAGENT_DESKTOP_E2E_LOOPBACK.${key} must be a non-empty string`);
    }
  }
  const baseUrl = new URL(value.base_url as string);
  if (
    baseUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname) ||
    !baseUrl.port
  ) {
    throw new Error('Desktop E2E loopback must be an explicit loopback http URL with a port');
  }
  const port = Number(baseUrl.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Desktop E2E loopback port is invalid');
  }
  installTestLoopback(value.account_id as string, {
    port,
    baseUrl: baseUrl.origin,
    wsUrl: `${baseUrl.origin.replace(/^http:/, 'ws:')}/ws`,
    networkId: value.network_id as string,
    deviceId: value.device_id as string,
    agentNodeId: value.agent_node_id as string,
    agentHandle: value.agent_handle as string,
    verifiedTarget: {
      networkName: value.network_name as string,
      networkId: value.network_id as string,
      handle: value.handle as string,
      coordinatorNodeId: value.coordinator_node_id as string,
      agentHandle: value.agent_handle as string,
      agentNodeId: value.agent_node_id as string,
    },
    stop: async () => {},
  });
}

// Register the factory so menu/shortcuts/tray can create windows.
setCreateWindowFactory(createWindow);

// ── Auto-updater ──

function setupAutoUpdater(): void {
  if (!runtimePolicy.enableAutoUpdater) return;
  const { autoUpdater } = require('electron-updater');
  const installedVersion = app.getVersion();
  const policy = configureAutoUpdater(autoUpdater, installedVersion);
  autoUpdater.autoDownload = policy.automaticCheck;
  autoUpdater.autoInstallOnAppQuit = policy.installOnQuit;

  autoUpdater.on('update-downloaded', (info: any) => {
    if (!shouldAcceptUpdate(installedVersion, info.version)) {
      // A stale or malformed provider response must never become a queued
      // downgrade on quit, even if electron-updater's own guard changes.
      autoUpdater.autoInstallOnAppQuit = false;
      console.error(`Rejected updater candidate ${info.version} for ${installedVersion}`);
      return;
    }
    autoUpdater.autoInstallOnAppQuit = policy.installOnQuit;
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `OpenAgent ${info.version} is ready to install.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }: { response: number }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err: Error) => {
    console.error('Auto-updater error:', err.message);
  });

  // Beta builds stay on an explicit, user-initiated update path until the
  // desktop app has launch-crash recovery. Stable behavior is unchanged.
  if (policy.automaticCheck) autoUpdater.checkForUpdatesAndNotify();
}

// ── IPC: Window-control handlers (module-level so they're registered
// before ``activate`` can fire and create a window on macOS). ──

handleTrustedIpc('app:quit', () => {
  app.quit();
});

handleTrustedIpc('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.minimize();
});

handleTrustedIpc('window:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }
});

handleTrustedIpc('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

handleTrustedIpc('window:isMaximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win.isMaximized() : false;
});

// ── IPC: Menu-initiated actions ──

// Renderer requests a new relay-child window at root.
handleTrustedIpc('menu:newWindow', () => {
  createWindow({ route: '', markChild: true });
  rebuildMenu();
});

// Renderer requests a new standalone agent window.
// The renderer sends a connectAccountId if known, else we prompt.
handleTrustedIpc('menu:newAgentWindow', (_event, accountId?: string) => {
  if (typeof accountId === 'string' && accountId.length > 0) {
    createWindow({ connectAccountId: accountId });
  } else {
    // Open a standalone window without a pre-bound account.
    // It will prompt the user to pick an agent on its own.
    createWindow({});
  }
  rebuildMenu();
});

// Renderer triggers the agent switcher (primary window will show the
// agent selection UI).
handleTrustedIpc('menu:switchAgent', () => {
  const primary = getPrimaryFromRegistry();
  if (primary && !primary.isDestroyed()) {
    sendToTrustedRenderer(primary.webContents, 'menu:switchAgent');
  }
});

// Renderer wants to open the Settings route.
handleTrustedIpc('menu:openSettings', () => {
  const primary = getPrimaryFromRegistry();
  if (primary && !primary.isDestroyed()) {
    sendToTrustedRenderer(primary.webContents, 'menu:openSettings');
  }
});

// Renderer wants to open the Keyboard Shortcuts documentation.
handleTrustedIpc('menu:openShortcuts', () => {
  const primary = getPrimaryFromRegistry();
  if (primary && !primary.isDestroyed()) {
    sendToTrustedRenderer(primary.webContents, 'menu:openShortcuts');
  }
});

// Focus a specific window by its webContents id.
handleTrustedIpc('menu:focusWindow', (_event, id: number) => {
  if (typeof id === 'number') {
    focusWindow(id);
  }
});

// Cycle focus through all open windows (next in the list).
handleTrustedIpc('menu:cycleWindows', () => {
  const all = getAllWindows().filter((e) => !e.win.isDestroyed());
  if (all.length === 0) return;

  const focusedId = BrowserWindow.getFocusedWindow()?.webContents.id ?? -1;
  const currentIndex = all.findIndex((e) => e.id === focusedId);
  const nextIndex = (currentIndex + 1) % all.length;
  const next = all[nextIndex];
  if (next) focusWindow(next.id);
});

// Note: shortcuts:getMap is registered inside registerAllShortcuts() in shortcuts.ts.

// Quick actions that need main-process side effects
handleTrustedIpc('menu:quickJump', () => {
  // The menu already sent the IPC to the focused renderer.
  return true;
});

handleTrustedIpc('menu:quickCreate', () => {
  return true;
});

// ── IPC: Window open/close ──

// Renderer asks the main process to open a new window for a tab route.
// These are *relay* children — they share the primary window's agent
// connection (WS tunnelled through the primary).
handleTrustedIpc('window:open', (_event, route: string) => {
  if (typeof route !== 'string' || !route) {
    throw new Error('window:open requires a non-empty route string');
  }
  const win = createWindow({ route, markChild: true });
  rebuildMenu();
  return win.webContents.id;
});

// Renderer asks the main process to open a *standalone* agent window: a
// full app window bound to a specific account that opens its OWN
// connection (its own loopback + WS), independent of the primary. This is
// what powers "open another agent in a new window" from the switcher.
handleTrustedIpc('window:openAgent', async (
  event,
  accountId: string,
  attemptToken?: number,
  sourceAccountId?: string,
) => {
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('window:openAgent requires a non-empty accountId string');
  }
  if (
    attemptToken !== undefined &&
    (!Number.isSafeInteger(attemptToken) || attemptToken <= 0)
  ) {
    throw new Error('window:openAgent attemptToken must be a positive safe integer');
  }
  if (sourceAccountId !== undefined && (typeof sourceAccountId !== 'string' || !sourceAccountId)) {
    throw new Error('window:openAgent sourceAccountId must be a non-empty string');
  }

  const requestedTarget = getVerifiedLoopbackTarget(accountId);
  const targetMatch = findWindowForVerifiedTarget(
    requestedTarget,
    getAllWindows()
      .filter((entry) => !entry.win.isDestroyed())
      .map((entry) => {
        const boundAccountId = entry.id === event.sender.id
          ? sourceAccountId ?? entry.accountId
          : entry.accountId;
        return {
          value: entry,
          target: boundAccountId ? getVerifiedLoopbackTarget(boundAccountId) : null,
        };
      }),
  );
  // A target may be temporarily unavailable during an older/manual flow;
  // retain the pre-existing same-account guard as a conservative fallback.
  const existing = targetMatch ?? getWindowsByAccount(accountId)[0] ?? null;
  if (existing) {
    focusWindow(existing.id);
    const sourceAlreadyUsesThisAccount = existing.id === event.sender.id
      && sourceAccountId === accountId;
    if (!sourceAlreadyUsesThisAccount) {
      await releaseLoopbackReservation(accountId, event.sender.id, attemptToken);
    }
    rebuildMenu();
    return existing.id;
  }

  const win = createWindow({ connectAccountId: accountId });
  // Both remembered/manual opens (session reservation) and background joins
  // (numbered attempt reservation) hand ownership to the destination. The
  // source window was only the launcher and must not pin the loopback alive.
  transferLoopbackAttempt(accountId, event.sender.id, attemptToken, win.webContents);
  rebuildMenu();
  return win.webContents.id;
});

// Renderer asks the main process to close all sub-windows.
handleTrustedIpc('window:closeAllChildren', () => {
  closeAllChildWindows();
  rebuildMenu();
});

// ── IPC: Multi-window WS relay ──

// Primary window's WS is shared with its *relay* children only.
// Standalone agent windows carry their own connection and are never part
// of this fan-out (their ids are not in ``relayChildIds``), so agent A's
// frames can't leak into an agent-B window.
onTrustedIpc('ws:relay-out', (event, payload: string) => {
  if (!relayChildIds.has(event.sender.id)) return;
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > 16 * 1024 * 1024) return;
  const primary = primaryWindowId
    ? BrowserWindow.fromId(primaryWindowId)
    : null;
  if (primary && !primary.isDestroyed()) {
    sendToTrustedRenderer(primary.webContents, 'ws:relay-from-child', payload);
  }
});

onTrustedIpc('ws:relay-broadcast', (event, payload: string) => {
  if (event.sender.id !== primaryWindowId) return;
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > 16 * 1024 * 1024) return;
  for (const id of relayChildIds) {
    const win = BrowserWindow.fromId(id);
    if (win && !win.isDestroyed()) {
      sendToTrustedRenderer(win.webContents, 'ws:relay-to-child', payload);
    }
  }
});

// ── IPC: Network ──

// Decode an invite ticket for the join form so it can auto-fill
// the bound handle (and show the user what they're joining). On
// any decode error, return null so the renderer falls back to
// manual entry — the loopback step will surface a clearer error
// if the ticket really is malformed.
handleTrustedIpc('network:decode-ticket', (_event, ticket: unknown) => {
  if (typeof ticket !== 'string' || ticket.length < 8) return null;
  try {
    const t = decodeTicket(ticket);
    return {
      role: t.role,
      bindTo: t.bindTo,
      networkName: t.networkName,
    };
  } catch {
    return null;
  }
});

// ── Lifecycle ──

app.whenReady().then(async () => {
  if (packagedSmoke) {
    try {
      if (!app.isPackaged) throw new Error('packaged smoke was started from an unpackaged app');
      if (!expectedSmokeVersion || app.getVersion() !== expectedSmokeVersion) {
        throw new Error(`version mismatch: expected ${expectedSmokeVersion || '<missing>'}, got ${app.getVersion()}`);
      }
      for (const required of [
        path.join(process.resourcesPath, 'app.asar'),
        path.join(process.resourcesPath, 'web-build', 'index.html'),
      ]) {
        if (!fs.existsSync(required)) throw new Error(`missing packaged resource: ${required}`);
      }
      console.log(`packaged-smoke ok ${app.getVersion()} ${process.platform} ${process.arch}`);
      app.exit(0);
    } catch (error) {
      console.error(`packaged-smoke failed: ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    }
    return;
  }

  registerStorageHandlers();
  registerCredentialHandlers();
  registerDialogHandlers();

  capabilityManager = new CapabilityManager({
    clientInstanceId: CLIENT_INSTANCE_ID,
    deviceLabel: `${os.hostname()} (OpenAgent Desktop)`,
    hostLaunch: discoverHostTools({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      manifestPath: path.join(__dirname, 'host-tools-manifest.json'),
    }),
    consentStore: new CapabilityConsentStore(),
    onStatus: (status) => {
      updateTrayCapabilityStatus(status);
      broadcastCapabilityStatus(status);
    },
  });
  registerCapabilityHandlers(capabilityManager);
  configureLoopbackLifecycleHooks({
    onStarted: (accountId, loopback) => capabilityManager?.addLoopback(
      accountId,
      loopback.baseUrl,
      loopback.agentNodeId,
      loopback.networkId,
      loopback.deviceId,
    ),
    onStopping: (accountId) => capabilityManager?.removeLoopback(accountId),
  });
  installConfiguredTestLoopback();
  registerLoopbackHandlers();

  // ── Desktop controls setup ──

  // Register global keyboard shortcuts.
  registerAllShortcuts();

  // Build and set the initial application menu.
  const menu = buildMenu();
  Menu.setApplicationMenu(menu);

  // Auto-rebuild the menu on window focus changes (updates the Window list).
  setupMenuAutoRebuild();

  // Create the system tray.
  createTray();
  configureCapabilityTray(async () => { await capabilityManager?.emergencyDisable(); });

  // Set up the macOS dock menu.
  setupDockMenu();

  // In production, start a local HTTP server for the web build
  // (Expo Router needs proper URL routing that file:// can't do)
  if (runtimePolicy.useStaticRenderer) {
    staticPort = await startStaticServer();
  }

  createWindow();
  // Status discovery is asynchronous so a missing/outdated optional host
  // binary never delays the first window. Any persisted canonical grant is
  // read from host-tools before a capability socket can be advertised.
  void capabilityManager.start();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  // Close capability admission before loopback callbacks run. In particular,
  // an emergency-stop retry must not reopen host-tools while Electron is
  // already committed to quitting.
  capabilityManager?.beginShutdown();
  void (async () => {
    try {
      // Await local-principal release before Electron tears down the main
      // process. Otherwise sidecar/browser state could outlive its account.
      await stopAllLoopbacks();
      await capabilityManager?.shutdown();
    } catch (error) {
      console.warn('[openagent] graceful capability shutdown failed:', error);
    } finally {
      if (staticServer) staticServer.close();
      destroyTray();
      unregisterAllShortcuts();
      shutdownComplete = true;
      // Re-enter Electron's quit flow only after every owned service and shim
      // has drained. `shutdownComplete` makes the second before-quit event
      // pass through without cancelling it again.
      app.quit();
    }
  })();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Notify renderers of focus changes ──

app.on('browser-window-focus', (_event, win) => {
  if (!win.isDestroyed()) {
    const id = win.webContents.id;
    for (const entry of getAllWindows()) {
      if (!entry.win.isDestroyed()) {
        sendToTrustedRenderer(entry.win.webContents, 'window:focusChanged', id);
      }
    }
  }
});
