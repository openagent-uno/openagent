import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from 'electron';
import {
  type RendererUrlPolicy,
  isTrustedRendererUrl,
  safeExternalHttpUrl,
} from './renderer-url-policy';

interface TrustedRendererRegistration {
  readonly contents: WebContents;
  readonly policy: RendererUrlPolicy;
}

type IpcSenderEvent = IpcMainEvent | IpcMainInvokeEvent;
type ExternalOpener = (url: string) => void | Promise<void>;

const registrations = new Map<number, TrustedRendererRegistration>();

export class UntrustedRendererError extends Error {
  constructor(message = 'IPC rejected: sender is not the trusted main renderer frame') {
    super(message);
    this.name = 'UntrustedRendererError';
  }
}

/**
 * Register one BrowserWindow before loading its first document. Navigation
 * and redirects are restricted to its assigned exact origin; webviews are
 * denied entirely. Unexpected committed navigation destroys the window and
 * revokes its IPC authority.
 */
export function registerTrustedRenderer(
  win: BrowserWindow,
  policy: RendererUrlPolicy,
  openExternal: ExternalOpener,
): void {
  const contents = win.webContents;
  const existing = registrations.get(contents.id);
  if (existing && existing.contents !== contents) {
    throw new Error(`Renderer id ${contents.id} is already registered to different WebContents`);
  }
  registrations.set(contents.id, { contents, policy });

  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, policy)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, policy)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event, webPreferences) => {
    // Defense in depth if webviewTag is accidentally re-enabled later.
    webPreferences.preload = undefined;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalHttpUrl(url);
    if (safe) void Promise.resolve(openExternal(safe)).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('did-navigate', (_event, url) => {
    if (isTrustedRendererUrl(url, policy)) return;
    registrations.delete(contents.id);
    if (!win.isDestroyed()) win.destroy();
  });
  contents.once('destroyed', () => {
    const current = registrations.get(contents.id);
    if (current?.contents === contents) registrations.delete(contents.id);
  });
}

export function unregisterTrustedRenderer(contents: WebContents): void {
  const current = registrations.get(contents.id);
  if (current?.contents === contents) registrations.delete(contents.id);
}

export function isTrustedRenderer(contents: WebContents): boolean {
  const registered = registrations.get(contents.id);
  if (!registered || registered.contents !== contents || contents.isDestroyed()) return false;
  return isTrustedRendererUrl(contents.mainFrame.url, registered.policy);
}

/** Exact WebContents, exact main frame identity, and current exact origin. */
export function assertTrustedMainFrame(event: IpcSenderEvent): void {
  const registered = registrations.get(event.sender.id);
  if (
    !registered ||
    registered.contents !== event.sender ||
    event.sender.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, registered.policy)
  ) {
    throw new UntrustedRendererError();
  }
}

/** Send only while the target still owns a trusted same-origin main frame. */
export function sendToTrustedRenderer(
  contents: WebContents,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!isTrustedRenderer(contents)) return false;
  contents.send(channel, ...args);
  return true;
}

/** Test-only reset for this process-global authority registry. */
export function clearTrustedRenderersForTests(): void {
  registrations.clear();
}
