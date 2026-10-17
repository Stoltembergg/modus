import { z } from "zod";
import { UI_LANGUAGE_PREFERENCES, type UiLanguagePreference } from "../../shared/ui-language";
import type { UiLanguageController } from "../locale/ui-language-controller";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

export const uiLanguageSetInputSchema = z
  .object({
    preference: z.enum(
      UI_LANGUAGE_PREFERENCES as [UiLanguagePreference, ...UiLanguagePreference[]],
    ),
  })
  .strict();

export function registerUiLanguageIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  uiLanguage: Pick<UiLanguageController, "getState" | "set">,
): void {
  ipcMain.handle(IPC_CHANNELS.uiLanguageGet, (event) => {
    assertTrustedSender(event);
    return uiLanguage.getState();
  });
  ipcMain.handle(IPC_CHANNELS.uiLanguageSet, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(uiLanguageSetInputSchema, input, IPC_CHANNELS.uiLanguageSet);
    return uiLanguage.set(parsed.preference);
  });
}
