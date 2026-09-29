import type { IpcMain } from "electron";
import { z } from "zod";
import type { HarnessInsight } from "../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../shared/contracts";
import {
  clearFailureBlacklist,
  listActiveFailureBlacklist,
} from "../agent/harness/failure-blacklist";
import {
  listHarnessPromotions,
  promoteHarnessInsight,
  proposeHarnessPromotion,
  rejectHarnessPromotion,
} from "../agent/harness/harness-learning-promotion";
import { getWorkspace } from "../workspace/workspace-store";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";
import { getSelectedWorkspace } from "./workspace-selection";

type IpcMainLike = Pick<IpcMain, "handle">;
type IpcHandler = (event: TrustedSenderEvent, input?: unknown) => unknown;

const workspaceScoped = z.object({
  workspaceId: z.string().trim().min(1).max(128).optional(),
});

const promoteSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128).optional(),
  insight: z.object({
    id: z.string().trim().min(1).max(128),
    kind: z.string().trim().min(1).max(64),
    claim: z.string().trim().min(1).max(500),
    recommendation: z.string().trim().min(1).max(800),
    hypothesis: z.literal(true),
    period: z.object({ since: z.string(), until: z.string() }),
    sampleCount: z.number().int().nonnegative(),
    confidence: z.enum(["low", "medium", "high"]),
    limitations: z.array(z.string().max(240)).max(24),
    sourceRefs: z
      .array(z.object({ runId: z.string().max(128), eventId: z.string().max(128).optional() }))
      .max(24),
  }),
  confirmedByUser: z.literal(true),
});

const rejectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128).optional(),
  promotionId: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(200).optional(),
});

const clearBlacklistSchema = z.object({
  workspaceId: z.string().trim().min(1).max(128).optional(),
  strategyCode: z.string().trim().max(96).optional(),
  clearAll: z.boolean().optional(),
});

function resolveWorkspace(
  event: TrustedSenderEvent,
  requested: string | undefined,
  workspaceExists: (id: string) => boolean,
  selectedWorkspace: (sender: NonNullable<TrustedSenderEvent["sender"]>) => string | undefined,
): string {
  if (!event.sender) throw new Error("Adaptive harness IPC requires a selected workspace sender.");
  const selected = selectedWorkspace(event.sender);
  const workspaceId = requested ?? selected;
  if (
    !workspaceId ||
    workspaceId === CHATS_WORKSPACE_ID ||
    !workspaceExists(workspaceId) ||
    selected !== workspaceId
  ) {
    throw new Error("Adaptive harness action is outside the current workspace scope.");
  }
  return workspaceId;
}

export function registerAdaptiveHarnessIpcHandlers(
  ipcMain: IpcMainLike,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  workspaceExists: (workspaceId: string) => boolean = (workspaceId) =>
    Boolean(getWorkspace(workspaceId)),
  selectedWorkspace: (
    sender: NonNullable<TrustedSenderEvent["sender"]>,
  ) => string | undefined = getSelectedWorkspace,
): void {
  ipcMain.handle(IPC_CHANNELS.harnessPromotionsList, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(workspaceScoped, input, IPC_CHANNELS.harnessPromotionsList);
    const workspaceId = resolveWorkspace(
      event,
      parsed.workspaceId,
      workspaceExists,
      selectedWorkspace,
    );
    return listHarnessPromotions(workspaceId);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.harnessPromotionPromote, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(promoteSchema, input, IPC_CHANNELS.harnessPromotionPromote);
    const workspaceId = resolveWorkspace(
      event,
      parsed.workspaceId,
      workspaceExists,
      selectedWorkspace,
    );
    proposeHarnessPromotion(workspaceId, parsed.insight as HarnessInsight);
    return promoteHarnessInsight({
      workspaceId,
      insight: parsed.insight as HarnessInsight,
      confirmedByUser: true,
    });
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.harnessPromotionReject, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(rejectSchema, input, IPC_CHANNELS.harnessPromotionReject);
    const workspaceId = resolveWorkspace(
      event,
      parsed.workspaceId,
      workspaceExists,
      selectedWorkspace,
    );
    return {
      ok: rejectHarnessPromotion(workspaceId, parsed.promotionId, parsed.reason),
    };
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.harnessFailureBlacklistList, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(workspaceScoped, input, IPC_CHANNELS.harnessFailureBlacklistList);
    const workspaceId = resolveWorkspace(
      event,
      parsed.workspaceId,
      workspaceExists,
      selectedWorkspace,
    );
    return listActiveFailureBlacklist(workspaceId);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.harnessFailureBlacklistClear, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      clearBlacklistSchema,
      input,
      IPC_CHANNELS.harnessFailureBlacklistClear,
    );
    const workspaceId = resolveWorkspace(
      event,
      parsed.workspaceId,
      workspaceExists,
      selectedWorkspace,
    );
    return {
      cleared: clearFailureBlacklist(workspaceId, {
        ...(parsed.strategyCode ? { strategyCode: parsed.strategyCode } : {}),
        ...(parsed.clearAll ? { clearAll: true } : {}),
      }),
    };
  }) as IpcHandler);
}
