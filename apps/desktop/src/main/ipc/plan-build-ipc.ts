import type { BrowserWindow as BrowserWindowType, IpcMain, IpcMainInvokeEvent } from "electron";
import { BrowserWindow } from "electron";
import type { PlanSourceSnapshot } from "../../shared/contracts";
import { getAgentSession } from "../agent/agent-store";
import {
  getPlanBuildOwnerEpoch,
  getPlanBuildOwnerEpochIdentity,
  getPlanBuildStartOperation,
  runPlanBuildStartOperation,
} from "../agent/harness/plan-build-store";
import { getDefaultModelId, isUsableModelId } from "../agent/model-service";
import type { PlanBuildStart } from "../agent/runtime";
import { getAgentRuntime } from "../agent/runtime-registry";
import { plansRoot } from "../agent/tools/plan-tools";
import { resolveAgentTurnModel } from "../agent/user-turn-model";
import { getAgent, requireAgentChatWritable } from "../agents/agents-store";
import { fingerprintPlanSource, readPlanById } from "../plan/plan-store";
import { IPC_CHANNELS } from "./channels";
import { agentStartPlanBuildSchema, parseIpcInput } from "./schemas";
import { assertTrustedSender } from "./trusted-sender";

function getSenderWindow(event: IpcMainInvokeEvent): BrowserWindowType {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error("Unable to resolve sender window.");
  return window;
}
export function registerPlanBuildIpcHandlers(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle(IPC_CHANNELS.agentStartPlanBuild, async (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentStartPlanBuildSchema,
      input,
      IPC_CHANNELS.agentStartPlanBuild,
    );
    requireAgentChatWritable(parsed.sessionId);
    const ownerId = event.sender.id;
    const ownerEpoch = getPlanBuildOwnerEpoch(ownerId);
    if (!ownerEpoch) throw new Error("PlanBuild build owner incarnation is no longer active.");
    const epochIdentity = getPlanBuildOwnerEpochIdentity(ownerEpoch);
    if (!epochIdentity) throw new Error("PlanBuild build owner incarnation is no longer active.");
    const previous = getPlanBuildStartOperation({
      ownerId,
      ownerEpoch,
      requestId: parsed.requestId,
    });
    if (
      previous &&
      (previous.kind !== "original" ||
        previous.sessionId !== parsed.sessionId ||
        previous.planId !== parsed.planId ||
        previous.planFingerprint !==
          fingerprintPlanSource(parsed.sourceSnapshot as PlanSourceSnapshot))
    )
      throw new Error("PlanBuild build start request conflict.");
    if (previous?.state === "started" && previous.result) {
      return runPlanBuildStartOperation({
        ownerId,
        ownerEpoch,
        requestId: parsed.requestId,
        kind: "original",
        sessionId: previous.sessionId,
        planId: previous.planId,
        planFingerprint: previous.planFingerprint,
        start: async () => previous.result as PlanBuildStart,
      });
    }
    const session = getAgentSession(parsed.sessionId);
    const plan = readPlanById(plansRoot(), parsed.planId);
    if (
      !session ||
      !plan ||
      plan.sessionId !== session.id ||
      plan.workspaceId !== session.workspaceId
    ) {
      throw new Error(
        "The requested original plan is missing or not owned by this session workspace.",
      );
    }
    const expectedFingerprint = fingerprintPlanSource(parsed.sourceSnapshot as PlanSourceSnapshot);
    if (fingerprintPlanSource(plan) !== expectedFingerprint) {
      throw new Error("The original plan source fingerprint changed since it was reviewed.");
    }
    const planFingerprint = expectedFingerprint;
    const model = resolveAgentTurnModel(
      session.agentId ? getAgent(session.agentId)?.modelId : undefined,
      session.model,
      session.agentId !== undefined,
      { defaultModelId: getDefaultModelId, isUsable: isUsableModelId },
    );
    const runtime = getAgentRuntime();
    if (!previous) runtime.assertPlanBuildSessionAvailable(session.id);
    return runPlanBuildStartOperation({
      ownerId,
      ownerEpoch,
      requestId: parsed.requestId,
      kind: "original",
      sessionId: session.id,
      planId: plan.id,
      planFingerprint,
      start: (operation, markRunCreated) =>
        runtime.startPlanBuild(getSenderWindow(event), {
          ownerId,
          ownerEpoch,
          ...(model !== undefined ? { model } : {}),
          requestId: parsed.requestId,
          sessionId: session.id,
          planId: plan.id,
          planFingerprint,
          idempotencyKey: `original:${ownerId}:${epochIdentity}:${parsed.requestId}`,
          ...(operation.runId ? { existingRunId: operation.runId } : {}),
          onRunCreated: markRunCreated,
        }),
    });
  });
}
