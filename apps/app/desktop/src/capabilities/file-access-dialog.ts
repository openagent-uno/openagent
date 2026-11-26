import { BaseWindow, dialog } from 'electron';
import type { FileAccessPicker } from './file-access';
import { CapabilityProtocolError } from './protocol';

interface FileAccessOwner {
  window: BaseWindow;
  agentHandle: string;
  current: () => boolean;
}

export function createFileAccessPicker(
  resolveOwner: (accountId: string) => FileAccessOwner | undefined,
): FileAccessPicker {
  let active: symbol | undefined;
  return async (request, signal) => {
    const owner = resolveOwner(request.accountId);
    if (!owner || active) {
      throw new CapabilityProtocolError('file_permission_unavailable',
        'The Mac cannot show this access request. Open the agent window or attach the file manually.');
    }
    if (signal.aborted || !owner.current()) return null;

    const token = Symbol();
    active = token;
    let panelOwner: BaseWindow | undefined;
    const current = () => active === token && !signal.aborted && owner.current();
    const release = () => {
      if (active === token) active = undefined;
      if (panelOwner && !panelOwner.isDestroyed()) {
        // On macOS hide ends the attached native sheet. Destroy alone can
        // leave showOpenDialog pending. This window owns only this request.
        panelOwner.hide();
        panelOwner.destroy();
      }
    };
    signal.addEventListener('abort', release, { once: true });
    owner.window.once('closed', release);
    try {
      const item = request.directory ? 'folder' : 'file';
      const { response } = await dialog.showMessageBox(owner.window, {
        type: 'question', title: 'OpenAgent file access',
        message: `Allow ${owner.agentHandle} to read a ${item}?`,
        detail: `${request.path}\n\nThis grants one-time access to the requested ${item} for this chat.`,
        buttons: [`Select ${item}…`, 'Deny'], defaultId: 1, cancelId: 1, signal,
      });
      if (response !== 0 || !current()) return null;

      // showOpenDialog has no AbortSignal. A frameless child anchors its
      // native sheet to the same chat and can be dismissed independently.
      const { x, y, width } = owner.window.getBounds();
      panelOwner = new BaseWindow({
        parent: owner.window, x, y, width, height: 1, show: false, frame: false,
        transparent: true, hasShadow: false, skipTaskbar: true,
      });
      panelOwner.showInactive();
      const choice = await dialog.showOpenDialog(panelOwner, {
        title: `Select the requested ${item}`, defaultPath: request.path,
        buttonLabel: 'Allow once',
        properties: [request.directory ? 'openDirectory' : 'openFile', 'dontAddToRecent'],
      });
      return current() && !choice.canceled ? choice.filePaths[0] ?? null : null;
    } finally {
      signal.removeEventListener('abort', release);
      owner.window.removeListener('closed', release);
      release();
    }
  };
}
