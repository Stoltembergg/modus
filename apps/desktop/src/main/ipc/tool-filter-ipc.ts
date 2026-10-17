import { BrowserWindow } from "electron";
import type { ToolFilterState } from "../../shared/tool-filter";
import { IPC_CHANNELS } from "./channels";
import type { TrustedSenderEvent } from "./trusted-sender";

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

export type ToolFilterIpcController = {
  getState(): ToolFilterState;
  enable(): Promise<ToolFilterState>;
  disable(): Promise<ToolFilterState>;
  cancelDownload(): Promise<ToolFilterState>;
  subscribe(listener: (state: ToolFilterState) => void): () => void;
};

export function registerToolFilterIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  controller: ToolFilterIpcController,
): () => void {
  ipcMain.handle(IPC_CHANNELS.toolFilterGet, (event) => {
    assertTrustedSender(event);
    return controller.getState();
  });
  ipcMain.handle(IPC_CHANNELS.toolFilterEnable, async (event) => {
    assertTrustedSender(event);
    return await controller.enable();
  });
  ipcMain.handle(IPC_CHANNELS.toolFilterDisable, async (event) => {
    assertTrustedSender(event);
    return await controller.disable();
  });
  ipcMain.handle(IPC_CHANNELS.toolFilterCancelDownload, async (event) => {
    assertTrustedSender(event);
    return await controller.cancelDownload();
  });

  return controller.subscribe((state: ToolFilterState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.toolFilterEvent, state);
      }
    }
  });
}
