import type { IpcMain } from "electron";
import type { HarnessInsightsQuery, HarnessInsightsResult } from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import { getWorkspace } from "../workspace/workspace-store";
import { IPC_CHANNELS } from "./channels";
import { harnessInsightsQuerySchema, parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";
import { getSelectedWorkspace } from "./workspace-selection";

type IpcMainLike = Pick<IpcMain, "handle">;
type HarnessInsightsService = {
  getHarnessInsights(input: HarnessInsightsQuery & { workspaceId: string }): HarnessInsightsResult;
};
type IpcHandler = (event: TrustedSenderEvent, input?: unknown) => unknown;

export function registerHarnessInsightsIpcHandlers(
  ipcMain: IpcMainLike,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: HarnessInsightsService,
  workspaceExists: (workspaceId: string) => boolean = (workspaceId) =>
    Boolean(getWorkspace(workspaceId)),
  selectedWorkspace: (
    sender: NonNullable<TrustedSenderEvent["sender"]>,
  ) => string | undefined = getSelectedWorkspace,
): void {
  ipcMain.handle(IPC_CHANNELS.harnessInsights, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(harnessInsightsQuerySchema, input, IPC_CHANNELS.harnessInsights);
    if (!event.sender) throw new Error("Harness Insights requires a selected workspace sender.");
    const selected = selectedWorkspace(event.sender);
    const workspaceId = parsed.workspaceId ?? selected;
    if (
      !workspaceId ||
      workspaceId === CHATS_WORKSPACE_ID ||
      !workspaceExists(workspaceId) ||
      selected !== workspaceId
    ) {
      throw new Error("Harness Insights is outside the current workspace scope.");
    }
    return service.getHarnessInsights({
      workspaceId,
      since: parsed.since,
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    });
  }) as IpcHandler);
}
