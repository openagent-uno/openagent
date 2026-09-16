import { BrowserWindow, dialog } from 'electron';
import type { CapabilityManager } from './manager';
import type { DesktopCapabilityStatus } from './protocol';
import { handleTrustedIpc } from '../security/trusted-ipc';
import { sendToTrustedRenderer } from '../security/trusted-renderers';

/** Broadcast a read-only status snapshot to every isolated renderer. */
export function broadcastCapabilityStatus(status: DesktopCapabilityStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToTrustedRenderer(window.webContents, 'capabilities:status', status);
    }
  }
}

/**
 * Renderer control plane. Deliberately contains no invoke/list-tool method:
 * actual execution remains Electron-main-owned and only arrives over the
 * authenticated server capability socket.
 */
export function registerCapabilityHandlers(manager: CapabilityManager): void {
  handleTrustedIpc('capabilities:getStatus', () => manager.getStatus());

  handleTrustedIpc('capabilities:setEnabled', async (event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('capabilities:setEnabled expects a boolean');
    }
    const current = manager.getStatus();
    if (enabled && !current.consent.enabled) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'Allow full computer access?',
        message: 'OpenAgent will be able to operate this computer',
        detail:
          'This persistent device-level grant allows the agent to read and change files, run commands, control supported apps and browsers, and use explicitly configured local MCP plugins. There are no per-call prompts or folder restrictions. You can disable access at any time from Settings or the tray emergency switch.',
        buttons: ['Cancel', 'Enable Full Access'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = owner && !owner.isDestroyed()
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 1) return manager.getStatus();
    }
    return manager.setEnabled(enabled);
  });

  handleTrustedIpc('capabilities:emergencyDisable', () => manager.emergencyDisable());
}
