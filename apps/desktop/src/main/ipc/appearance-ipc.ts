import type { AppearanceController } from "../appearance/appearance-controller";
import { appearanceSetInputSchema } from "../appearance/appearance-schemas";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

export function registerAppearanceIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  appearance: Pick<AppearanceController, "getState" | "set">,
): void {
  ipcMain.handle(IPC_CHANNELS.appearanceGet, (event) => {
    assertTrustedSender(event);
    return appearance.getState();
  });
  ipcMain.handle(IPC_CHANNELS.appearanceSet, (event, input) => {
    assertTrustedSender(event);
    return appearance.set(
      parseIpcInput(appearanceSetInputSchema, input, IPC_CHANNELS.appearanceSet),
    );
  });
}
