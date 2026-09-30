import type {
  GroupMemberStates,
  GroupMessage,
  GroupMessageCursor,
  PostGroupMessageInput,
} from "../../shared/contracts";
import { IPC_CHANNELS } from "./channels";
import { toGroupIpcError } from "./group-ipc";
import {
  groupListMessagesSchema,
  groupPostMessageSchema,
  groupStopSchema,
  parseIpcInput,
} from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

/** The room operations the renderer needs (the GroupRuntime plus the message store). */
export type GroupRuntimeIpcService = {
  postUserMessage(input: PostGroupMessageInput): GroupMessage;
  listGroupMessages(
    groupId: string,
    options: { before?: GroupMessageCursor; after?: GroupMessageCursor; limit?: number },
  ): GroupMessage[];
  workingGroupIds(): string[];
  memberStates(): GroupMemberStates[];
  stopGroup(groupId: string): void;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

/**
 * `group:post-message`, `group:list-messages`, `group:working`,
 * `group:member-states` and `group:stop`. Live updates
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
    const contextItems = parsed.contextItems
      ?.filter(
        (item): item is { type: "file"; path: string } | { type: "folder"; path: string } =>
          (item.type === "file" || item.type === "folder") && typeof item.path === "string",
      )
      .map((item) =>
        item.type === "folder"
          ? { type: "folder" as const, path: item.path }
          : { type: "file" as const, path: item.path },
      );
    return service.postUserMessage({
      groupId: parsed.groupId,
      body: parsed.body,
      ...(parsed.mentions ? { mentions: parsed.mentions } : {}),
      ...(parsed.replyToMessageId ? { replyToMessageId: parsed.replyToMessageId } : {}),
      ...(parsed.attachments && parsed.attachments.length > 0
        ? { attachments: parsed.attachments }
        : {}),
      ...(contextItems && contextItems.length > 0 ? { contextItems } : {}),
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

  handle(IPC_CHANNELS.groupMemberStates, (event, input) => {
    assertTrustedSender(event);
    if (input !== undefined) {
      throw new Error(
        `Invalid IPC payload for ${IPC_CHANNELS.groupMemberStates}: expected no input`,
      );
    }
    return service.memberStates();
  });

  handle(IPC_CHANNELS.groupStop, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupStopSchema, input, IPC_CHANNELS.groupStop);
    service.stopGroup(parsed.groupId);
  });
}
