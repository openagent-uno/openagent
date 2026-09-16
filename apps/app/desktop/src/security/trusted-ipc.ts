import {
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { assertTrustedMainFrame, UntrustedRendererError } from './trusted-renderers';

type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => any;
type EventListener = (event: IpcMainEvent, ...args: any[]) => void;

/** ipcMain.handle wrapper that admits only the registered exact main frame. */
export function handleTrustedIpc(channel: string, listener: InvokeListener): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedMainFrame(event);
    return listener(event, ...args);
  });
}

/** ipcMain.on wrapper that silently drops untrusted fire-and-forget input. */
export function onTrustedIpc(channel: string, listener: EventListener): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedMainFrame(event);
    } catch (error) {
      if (error instanceof UntrustedRendererError) {
        console.warn(`[ipc] rejected untrusted renderer event on ${channel}`);
        return;
      }
      throw error;
    }
    listener(event, ...args);
  });
}
