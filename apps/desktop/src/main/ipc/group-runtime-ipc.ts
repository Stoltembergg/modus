import type {
  GroupMessage,
  GroupMessageCursor,
  PostGroupMessageInput,
} from "../../shared/contracts";
import { IPC_CHANNELS } from "./channels";
import { toGroupIpcError } from "./group-ipc";
import { groupListMessagesSchema, groupPostMessageSchema, parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

/** The room operations the renderer needs (the GroupRuntime plus the message store). */
export type GroupRuntimeIpcService = {
  postUserMessage(input: PostGroupMessageInput): GroupMessage;
  listGroupMessages(
    groupId: string,
    options: { before?: GroupMessageCursor; after?: GroupMessageCursor; limit?: number },
  ): GroupMessage[];
  workingGroupIds(): string[];
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

/**
 * `group:post-message`, `group:list-messages` and `group:working`. Live updates
 * are pushed on `group:event` (see GroupRuntimeEvent in shared/contracts).
 */
export function registerGroupRuntimeIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: GroupRuntimeIpcService,
): void {
  const handle: HandlerRegistration["handle"] = (channel, listener) => {
    ipcMain.handle(channel, (event, input) => {
      try {
        return listener(event, input);
      } catch (error) {
        throw toGroupIpcError(error);
      }
    });
  };

  handle(IPC_CHANNELS.groupPostMessage, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupPostMessageSchema, input, IPC_CHANNELS.groupPostMessage);
    return service.postUserMessage({
      groupId: parsed.groupId,
      body: parsed.body,
      ...(parsed.mentions ? { mentions: parsed.mentions } : {}),
      ...(parsed.replyToMessageId ? { replyToMessageId: parsed.replyToMessageId } : {}),
    });
  });

  handle(IPC_CHANNELS.groupListMessages, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupListMessagesSchema, input, IPC_CHANNELS.groupListMessages);
    return service.listGroupMessages(parsed.groupId, {
      ...(parsed.before ? { before: parsed.before } : {}),
      ...(parsed.after ? { after: parsed.after } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    });
  });

  handle(IPC_CHANNELS.groupWorking, (event, input) => {
    assertTrustedSender(event);
    if (input !== undefined) {
      throw new Error(`Invalid IPC payload for ${IPC_CHANNELS.groupWorking}: expected no input`);
    }
    return service.workingGroupIds();
  });
}
