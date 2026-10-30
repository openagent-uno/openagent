import { getMcpAppLoopback } from '../services/loopback';
import { performBrowserDecision } from './browser-operator';
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

  handleTrustedIpc('browser:inventory', (event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('invalid_browser_account');
    getMcpAppLoopback(accountId,event.sender.id);
    return manager.browserInventory(accountId);
  });
  handleTrustedIpc('browser:decision', async (event, input:unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_browser_decision');
    const raw=input as Record<string,unknown>;
    if (Object.keys(raw).some(key=>!['accountId','requestId','action'].includes(key)) || typeof raw.accountId !== 'string') throw new Error('invalid_browser_decision');
    const accountId=raw.accountId, loopback=getMcpAppLoopback(accountId,event.sender.id), generation=manager.getStatus().generation;
    const check=()=>{if(getMcpAppLoopback(accountId,event.sender.id)!==loopback || manager.getStatus().generation!==generation)throw new Error('browser_connection_changed')};
    return performBrowserDecision(async()=>{check();return manager.browserInventory(accountId)},async decision=>{check();return manager.browserDecision(accountId,decision,generation)},
      {requestId:raw.requestId,action:raw.action},async detail=>{
        const owner=BrowserWindow.fromWebContents(event.sender);
        const options:Electron.MessageBoxOptions={type:'question',title:'Browser control',message:'Confirm browser decision',detail:`Account: ${accountId}\n${detail}`,buttons:['Cancel','Confirm'],defaultId:0,cancelId:0,noLink:true};
        const response=owner&&!owner.isDestroyed()?await dialog.showMessageBox(owner,options):await dialog.showMessageBox(options);
        return response.response===1;
      });
  });

  handleTrustedIpc('capabilities:emergencyDisable', () => manager.emergencyDisable());
}
