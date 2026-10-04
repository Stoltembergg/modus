import { z } from "zod";
import type { GroupTask } from "../../shared/contracts";
import type {
  GroupTaskDetails,
  GroupTaskTransitionEvent,
  GroupTaskUserDraft,
  GroupWorkState,
} from "../../shared/group-work-state";
import { IPC_CHANNELS } from "./channels";
import { toGroupIpcError } from "./group-ipc";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

const nonEmpty = z.string().trim().min(1).max(128);
const groupWorkStateSchema = z
  .object({
    groupId: nonEmpty,
    executionId: nonEmpty.optional(),
  })
  .strict();
const taskDetailsSchema = z.object({ groupId: nonEmpty, taskId: nonEmpty }).strict();
const taskTransitionsSchema = z.object({ taskId: nonEmpty }).strict();
const draftSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4_000).optional(),
    kind: z.enum(["legacy", "code", "docs", "design", "review", "research", "question"]),
    priority: z.enum(["low", "normal", "high"]),
    dependencyIds: z.array(nonEmpty).max(256),
    criteria: z
      .array(
        z
          .object({
            id: nonEmpty,
            description: z.string().trim().min(1).max(1_000),
            requiredCheckKinds: z.array(z.enum(["tests", "typecheck", "lint", "build"])).max(4),
          })
          .strict(),
      )
      .max(128),
    verificationPolicy: z
      .object({
        mode: z.enum(["none", "required"]),
        requireReview: z.boolean(),
      })
      .strict(),
    reviewerSessionId: nonEmpty.optional(),
  })
  .strict();
const updateTaskSchema = z
  .object({
    taskId: nonEmpty,
    draft: draftSchema,
    expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type GroupWorkIpcService = {
  getGroupWorkState(groupId: string, executionId?: string): GroupWorkState;
  getGroupTaskDetails(groupId: string, taskId: string): Promise<GroupTaskDetails>;
  listGroupTaskTransitions(taskId: string): GroupTaskTransitionEvent[];
  updateGroupTaskDraft(
    taskId: string,
    draft: GroupTaskUserDraft,
    expectedVersion: number,
  ): GroupTask;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

const MAX_TASK_TRANSITIONS = 100;

/** Read-only task snapshots/history plus optimistic user draft edits. */
export function registerGroupWorkIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: GroupWorkIpcService,
): void {
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

  handle(IPC_CHANNELS.groupGetWorkState, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(groupWorkStateSchema, input, IPC_CHANNELS.groupGetWorkState);
    return service.getGroupWorkState(parsed.groupId, parsed.executionId);
  });

  handle(IPC_CHANNELS.groupGetTaskDetails, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(taskDetailsSchema, input, IPC_CHANNELS.groupGetTaskDetails);
    return service.getGroupTaskDetails(parsed.groupId, parsed.taskId);
  });

  handle(IPC_CHANNELS.groupListTaskTransitions, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      taskTransitionsSchema,
      input,
      IPC_CHANNELS.groupListTaskTransitions,
    );
    return service.listGroupTaskTransitions(parsed.taskId).slice(-MAX_TASK_TRANSITIONS);
  });

  handle(IPC_CHANNELS.groupUpdateTask, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(updateTaskSchema, input, IPC_CHANNELS.groupUpdateTask);
    return service.updateGroupTaskDraft(
      parsed.taskId,
      parsed.draft as GroupTaskUserDraft,
      parsed.expectedVersion,
    );
  });
}
