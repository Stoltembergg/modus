import type { UpdateState } from "../../shared/contracts";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput, updateNoInputSchema } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

export type UpdateIpcService = {
  getState(): UpdateState;
  install(): Promise<void>;
  retry(): Promise<void>;
  dismiss(): void;
  openReleasePage(): Promise<void>;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

/** Commands resolve once accepted; progress arrives on IPC_CHANNELS.updateStateEvent. */
export function registerUpdateIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: UpdateIpcService,
): void {
  const handle = (channel: string, run: () => unknown) => {
    ipcMain.handle(channel, (event, input) => {
      assertTrustedSender(event);
      parseIpcInput(updateNoInputSchema, input, channel);
      return run();
    });
  };
  handle(IPC_CHANNELS.updateGetState, () => service.getState());
  // install/retry can span a long download and end in a restart: don't hold the
  // renderer's invoke open for that; state events report progress and failures.
  handle(IPC_CHANNELS.updateInstall, () => {
    void service.install();
  });
  handle(IPC_CHANNELS.updateRetry, () => {
    void service.retry();
  });
  handle(IPC_CHANNELS.updateDismiss, () => {
    service.dismiss();
  });
  handle(IPC_CHANNELS.updateOpenReleasePage, () => service.openReleasePage());
}
