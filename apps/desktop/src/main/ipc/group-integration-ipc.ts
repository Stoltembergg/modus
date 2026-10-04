import { z } from "zod";
import type { GroupRuntimeEvent } from "../../shared/contracts";
import type {
  GroupIntegrationPreview,
  GroupIntegrationRecord,
  GroupIntegrationState,
} from "../../shared/group-work-state";
import { IPC_CHANNELS } from "./channels";
import { toGroupIpcError } from "./group-ipc";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

const taskId = z.string().trim().min(1).max(128);
const previewSchema = z.object({ taskId }).strict();
const applySchema = z
  .object({
    taskId,
    previewId: z.string().trim().min(1).max(128),
    confirmedByUser: z.literal(true),
  })
  .strict();
const abortSchema = z.object({ taskId }).strict();
const stateSchema = z.object({ taskId }).strict();
const refreshSchema = z.object({ taskId }).strict();

export type GroupIntegrationIpcService = {
  previewGroupTaskIntegration(taskId: string): Promise<GroupIntegrationPreview>;
  applyGroupTaskIntegration(input: {
    taskId: string;
    previewId: string;
    confirmedByUser: true;
  }): Promise<GroupIntegrationRecord>;
  abortGroupTaskIntegration(taskId: string): Promise<GroupIntegrationRecord>;
  getIntegrationState(taskId: string): GroupIntegrationState;
  refreshGroupTaskIntegrationState(taskId: string): Promise<GroupIntegrationState>;
  onIntegrationChanged(listener: (record: GroupIntegrationRecord) => void): () => void;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

export function integrationChangedEvent(
  record: GroupIntegrationRecord,
): Extract<GroupRuntimeEvent, { type: "group.integration-changed" }> {
  return {
    type: "group.integration-changed",
    groupId: record.groupId,
    taskId: record.taskId,
    record,
    version: record.version,
  };
}

/** Main-process integration IPC. The renderer supplies IDs and confirmation only. */
export function registerGroupIntegrationIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: GroupIntegrationIpcService,
  emitEvent: (event: GroupRuntimeEvent) => void = () => undefined,
): void {
  service.onIntegrationChanged((record) => emitEvent(integrationChangedEvent(record)));

  const handle: HandlerRegistration["handle"] = (channel, listener) => {
    ipcMain.handle(channel, (event, input) => {
      try {
        const result = listener(event, input);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          return Promise.resolve(result).catch((error: unknown) => {
            throw toGroupIpcError(error);
          });
        }
        return result;
      } catch (error) {
        throw toGroupIpcError(error);
      }
    });
  };

  handle(IPC_CHANNELS.groupIntegrationPreview, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(previewSchema, input, IPC_CHANNELS.groupIntegrationPreview);
    return service.previewGroupTaskIntegration(parsed.taskId);
  });

  handle(IPC_CHANNELS.groupIntegrationApply, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(applySchema, input, IPC_CHANNELS.groupIntegrationApply);
    return service.applyGroupTaskIntegration(parsed);
  });

  handle(IPC_CHANNELS.groupIntegrationAbort, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(abortSchema, input, IPC_CHANNELS.groupIntegrationAbort);
    return service.abortGroupTaskIntegration(parsed.taskId);
  });

  handle(IPC_CHANNELS.groupIntegrationState, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(stateSchema, input, IPC_CHANNELS.groupIntegrationState);
    return service.getIntegrationState(parsed.taskId);
  });

  handle(IPC_CHANNELS.groupIntegrationRefresh, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(refreshSchema, input, IPC_CHANNELS.groupIntegrationRefresh);
    return service.refreshGroupTaskIntegrationState(parsed.taskId);
  });
}
