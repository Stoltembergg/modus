import type { BrowserWindow as BrowserWindowType, IpcMain, IpcMainInvokeEvent } from "electron";
import { BrowserWindow } from "electron";
import type { HyperPlanSourceSnapshot, PlanRef } from "../../shared/contracts";
import { recordAgentEvent } from "../agent/agent-event-store";
import { getAgentSession } from "../agent/agent-store";
import {
  runHyperPlanReview,
  runHyperPlanRevision,
  userFacingHyperPlanMessage,
} from "../agent/harness/hyperplan";
import {
  getHyperPlanChoiceReplay,
  getHyperPlanDraftOwnerEpoch,
  getHyperPlanOwnerEpochIdentity,
  getHyperPlanSelection,
  getHyperPlanStartOperation,
  type HyperPlanDraftOwnerEpoch,
  isHyperPlanChoicePublished,
  markHyperPlanChoicePublished,
  peekHyperPlanDraft,
  releaseHyperPlanSession,
  reserveHyperPlanSession,
  resolveHyperPlanDraftRequest,
  runHyperPlanStartOperation,
  storeHyperPlanDraft,
} from "../agent/harness/hyperplan-draft-store";
import type { HyperPlanBuildStart, HyperPlanBuildStartInput } from "../agent/runtime";
import { getAgentRuntime } from "../agent/runtime-registry";
import { plansRoot } from "../agent/tools/plan-tools";
import {
  fingerprintPlanSource,
  promotePlanRevision,
  readPlanById,
  updatePlanContentById,
} from "../plan/plan-store";
import { IPC_CHANNELS } from "./channels";
import {
  agentApplyHyperPlanRevisionSchema,
  agentCreateHyperPlanDraftSchema,
  agentResolveHyperPlanDraftChoiceSchema,
  agentReviewPlanWithHyperPlanSchema,
  agentStartOriginalPlanBuildSchema,
  agentStartPlanBuildSchema,
  parseIpcInput,
} from "./schemas";
import { assertTrustedSender } from "./trusted-sender";

type HyperPlanRuntime = ReturnType<typeof getAgentRuntime> & {
  assertHyperPlanSessionAvailable(sessionId: string): void;
  publishPlanUpdated(
    window: BrowserWindowType,
    sessionId: string,
    plan: PlanRef,
    idempotencyKey?: string,
  ): void;
  startPlanBuild(
    window: BrowserWindowType,
    input: HyperPlanBuildStartInput,
  ): Promise<HyperPlanBuildStart>;
  startOriginalPlanBuild(
    window: BrowserWindowType,
    input: HyperPlanBuildStartInput,
  ): Promise<HyperPlanBuildStart>;
};

function getHyperPlanRuntime(): HyperPlanRuntime {
  return getAgentRuntime() as HyperPlanRuntime;
}

function getSenderWindow(event: IpcMainInvokeEvent): BrowserWindowType {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    throw new Error("Unable to resolve sender window.");
  }
  return window;
}

type IpcMainLike = Pick<IpcMain, "handle">;

/** HyperPlan review/revision/draft/build IPC handlers. */
export function registerHyperPlanIpcHandlers(ipcMain: IpcMainLike): void {
  ipcMain.handle(IPC_CHANNELS.agentReviewPlanWithHyperPlan, async (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentReviewPlanWithHyperPlanSchema,
      input,
      IPC_CHANNELS.agentReviewPlanWithHyperPlan,
    );
    const session = getAgentSession(parsed.sessionId);
    if (!session) throw new Error("Agent session not found.");
    const plan = readPlanById(plansRoot(), parsed.planId);
    if (
      !plan?.spec ||
      plan.id !== parsed.planId ||
      plan.sessionId !== session.id ||
      plan.workspaceId !== session.workspaceId
    ) {
      throw new Error("Spec plan does not belong to this session.");
    }
    const modelId = parsed.model ?? session.model;
    try {
      return await runHyperPlanReview({
        planContent: plan.content,
        spec: plan.spec,
        ...(modelId ? { modelId } : {}),
      });
    } catch (error) {
      throw new Error(userFacingHyperPlanMessage(error));
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentApplyHyperPlanRevision, async (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentApplyHyperPlanRevisionSchema,
      input,
      IPC_CHANNELS.agentApplyHyperPlanRevision,
    );
    const session = getAgentSession(parsed.sessionId);
    if (!session) throw new Error("Agent session not found.");
    const plan = readPlanById(plansRoot(), parsed.planId);
    if (
      !plan?.spec ||
      plan.id !== parsed.planId ||
      plan.sessionId !== session.id ||
      plan.workspaceId !== session.workspaceId
    ) {
      throw new Error("Spec plan does not belong to this session.");
    }
    if (plan.hash !== parsed.planHash) {
      throw new Error("Plan changed since review; reload it before applying this revision.");
    }
    const senderWindow = getSenderWindow(event);
    let updatedEvent: { type: "plan.updated"; sessionId: string; plan: typeof plan } | undefined;
    const updated = updatePlanContentById(
      plansRoot(),
      plan.id,
      parsed.planHash,
      parsed.revisedContent,
      (persistedPlan) => {
        updatedEvent = { type: "plan.updated", sessionId: session.id, plan: persistedPlan };
        recordAgentEvent(updatedEvent);
      },
    );
    if (!updated) throw new Error("Spec plan not found.");
    if (!updatedEvent) throw new Error("Plan update event was not persisted.");
    try {
      senderWindow.webContents.send(IPC_CHANNELS.agentEvent, updatedEvent);
    } catch (error) {
      console.error("Failed to deliver committed plan.updated event to sender window.", error);
    }
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.agentCreateHyperPlanDraft, async (event, input) => {
    assertTrustedSender(event);
    let reservation:
      | { sessionId: string; ownerId: number; ownerEpoch: HyperPlanDraftOwnerEpoch }
      | undefined;
    try {
      const parsed = parseIpcInput(
        agentCreateHyperPlanDraftSchema,
        input,
        IPC_CHANNELS.agentCreateHyperPlanDraft,
      );
      const ownerId = event.sender.id;
      const ownerEpoch = getHyperPlanDraftOwnerEpoch(ownerId);
      if (!ownerEpoch) throw new Error("HyperPlan draft owner is not active.");
      const session = getAgentSession(parsed.sessionId);
      if (!session) throw new Error("Agent session not found.");
      const sourcePlan = readPlanById(plansRoot(), parsed.planId);
      if (
        !sourcePlan?.spec ||
        sourcePlan.id !== parsed.planId ||
        sourcePlan.sessionId !== session.id ||
        sourcePlan.workspaceId !== session.workspaceId
      ) {
        throw new Error("Spec plan does not belong to this session.");
      }
      const runtime = getHyperPlanRuntime();
      runtime.assertHyperPlanSessionAvailable(session.id);
      if (!reserveHyperPlanSession({ sessionId: session.id, ownerId, ownerEpoch })) {
        throw new Error("HyperPlan review is already active for this session.");
      }
      reservation = { sessionId: session.id, ownerId, ownerEpoch };
      const sourceFingerprint = fingerprintPlanSource(sourcePlan);
      const modelId = parsed.model ?? session.model;
      const revision = await runHyperPlanRevision(
        {
          title: sourcePlan.title,
          overview: sourcePlan.overview,
          content: sourcePlan.content,
          todos: sourcePlan.todos,
          spec: sourcePlan.spec,
        },
        modelId ? { modelId } : undefined,
      );
      const currentSession = getAgentSession(parsed.sessionId);
      const currentPlan = readPlanById(plansRoot(), parsed.planId);
      if (
        !currentSession ||
        currentSession.workspaceId !== session.workspaceId ||
        !currentPlan ||
        currentPlan.id !== parsed.planId ||
        currentPlan.sessionId !== session.id ||
        currentPlan.workspaceId !== session.workspaceId ||
        fingerprintPlanSource(currentPlan) !== sourceFingerprint
      ) {
        throw new Error("Plan source changed during HyperPlan generation; run a fresh review.");
      }
      return storeHyperPlanDraft({ ownerId, ownerEpoch, sourcePlan: currentPlan, revision });
    } catch (error) {
      throw new Error(userFacingHyperPlanMessage(error));
    } finally {
      if (reservation) releaseHyperPlanSession(reservation);
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentResolveHyperPlanDraftChoice, (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentResolveHyperPlanDraftChoiceSchema,
      input,
      IPC_CHANNELS.agentResolveHyperPlanDraftChoice,
    );
    const ownerId = event.sender.id;
    const ownerEpoch = getHyperPlanDraftOwnerEpoch(ownerId);
    if (!ownerEpoch) throw new Error("HyperPlan draft owner incarnation is no longer active.");
    const replay = getHyperPlanChoiceReplay({ ownerId, ownerEpoch, ...parsed });
    if (replay) {
      const current = readPlanById(plansRoot(), replay.plan.id);
      const session = getAgentSession(replay.plan.sessionId);
      if (
        !session ||
        !current ||
        current.id !== replay.plan.id ||
        current.sessionId !== replay.plan.sessionId ||
        current.workspaceId !== replay.plan.workspaceId ||
        session.workspaceId !== current.workspaceId ||
        fingerprintPlanSource(current) !== replay.planFingerprint
      ) {
        throw new Error("Plan source changed after the HyperPlan choice; retry is no longer safe.");
      }
      if (
        parsed.choice === "revision" &&
        !isHyperPlanChoicePublished({ ownerId, ownerEpoch, ...parsed })
      ) {
        getHyperPlanRuntime().publishPlanUpdated(
          getSenderWindow(event),
          replay.plan.sessionId,
          replay.plan,
          replay.selectionId,
        );
        markHyperPlanChoicePublished({ ownerId, ownerEpoch, ...parsed });
      }
      return replay;
    }

    const draft = peekHyperPlanDraft({ ownerId, ownerEpoch, draftId: parsed.draftId });
    if (!draft)
      throw new Error("HyperPlan draft is missing, expired, or belongs to another owner.");
    const session = getAgentSession(draft.sessionId);
    const sourcePlan = readPlanById(plansRoot(), draft.planId);
    if (
      !session ||
      !sourcePlan?.spec ||
      sourcePlan.id !== draft.planId ||
      sourcePlan.sessionId !== session.id ||
      sourcePlan.workspaceId !== session.workspaceId ||
      session.workspaceId !== draft.workspaceId
    ) {
      throw new Error("Spec plan does not belong to this session.");
    }
    const runtime = getHyperPlanRuntime();
    runtime.assertHyperPlanSessionAvailable(session.id);
    const selection = resolveHyperPlanDraftRequest({
      ownerId,
      ownerEpoch,
      ...parsed,
      sourcePlan,
      resolvePlan: (storedDraft) => {
        const latestSession = getAgentSession(storedDraft.sessionId);
        const latestPlan = readPlanById(plansRoot(), storedDraft.planId);
        if (
          !latestSession ||
          !latestPlan?.spec ||
          latestPlan.id !== storedDraft.planId ||
          latestPlan.sessionId !== storedDraft.sessionId ||
          latestPlan.workspaceId !== storedDraft.workspaceId ||
          latestSession.workspaceId !== storedDraft.workspaceId ||
          fingerprintPlanSource(latestPlan) !== storedDraft.sourceFingerprint
        ) {
          throw new Error("HyperPlan draft source is stale; run a fresh review.");
        }
        if (parsed.choice === "original") return latestPlan;
        return promotePlanRevision(plansRoot(), {
          planId: storedDraft.planId,
          expectedFingerprint: storedDraft.sourceFingerprint,
          revision: storedDraft.revision,
        });
      },
    });
    if (
      parsed.choice === "revision" &&
      !isHyperPlanChoicePublished({ ownerId, ownerEpoch, ...parsed })
    ) {
      runtime.publishPlanUpdated(
        getSenderWindow(event),
        session.id,
        getHyperPlanChoiceReplay({ ownerId, ownerEpoch, ...parsed })?.plan ?? sourcePlan,
        selection.selectionId,
      );
      markHyperPlanChoicePublished({ ownerId, ownerEpoch, ...parsed });
    }
    return selection;
  });

  ipcMain.handle(IPC_CHANNELS.agentStartPlanBuild, async (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentStartPlanBuildSchema,
      input,
      IPC_CHANNELS.agentStartPlanBuild,
    );
    const ownerId = event.sender.id;
    const ownerEpoch = getHyperPlanDraftOwnerEpoch(ownerId);
    if (!ownerEpoch) throw new Error("HyperPlan draft owner incarnation is no longer active.");
    const previous = getHyperPlanStartOperation({
      ownerId,
      ownerEpoch,
      requestId: parsed.requestId,
    });
    if (
      previous &&
      (previous.kind !== "selection" || previous.selectionId !== parsed.selectionId)
    ) {
      throw new Error("HyperPlan build start request conflict.");
    }
    if (previous?.state === "started" && previous.result) {
      return runHyperPlanStartOperation({
        ownerId,
        ownerEpoch,
        requestId: parsed.requestId,
        kind: "selection",
        selectionId: parsed.selectionId,
        sessionId: previous.sessionId,
        planId: previous.planId,
        planFingerprint: previous.planFingerprint,
        start: async () => previous.result as HyperPlanBuildStart,
      });
    }
    const selection = previous
      ? {
          selectionId: parsed.selectionId,
          sessionId: previous.sessionId,
          planId: previous.planId,
          planFingerprint: previous.planFingerprint,
        }
      : getHyperPlanSelection({ ownerId, ownerEpoch, selectionId: parsed.selectionId });
    if (!selection)
      throw new Error("HyperPlan selection is missing, expired, or belongs to another owner.");
    const session = getAgentSession(selection.sessionId);
    const plan = readPlanById(plansRoot(), selection.planId);
    if (
      !session ||
      !plan ||
      plan.id !== selection.planId ||
      plan.sessionId !== session.id ||
      plan.workspaceId !== session.workspaceId ||
      ("workspaceId" in selection && plan.workspaceId !== selection.workspaceId) ||
      (previous?.state !== "started" && fingerprintPlanSource(plan) !== selection.planFingerprint)
    )
      throw new Error("Plan fingerprint changed; this HyperPlan selection cannot be started.");

    const runtime = getHyperPlanRuntime();
    return runHyperPlanStartOperation({
      ownerId,
      ownerEpoch,
      requestId: parsed.requestId,
      kind: "selection",
      selectionId: parsed.selectionId,
      sessionId: session.id,
      planId: plan.id,
      planFingerprint: selection.planFingerprint,
      start: (operation, markRunCreated) =>
        runtime.startPlanBuild(getSenderWindow(event), {
          ownerId,
          ownerEpoch,
          requestId: parsed.requestId,
          sessionId: session.id,
          planId: plan.id,
          planFingerprint: selection.planFingerprint,
          selectionId: parsed.selectionId,
          idempotencyKey: parsed.selectionId,
          ...(operation.runId ? { existingRunId: operation.runId } : {}),
          onRunCreated: markRunCreated,
        }),
    });
  });

  ipcMain.handle(IPC_CHANNELS.agentStartOriginalPlanBuild, async (event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      agentStartOriginalPlanBuildSchema,
      input,
      IPC_CHANNELS.agentStartOriginalPlanBuild,
    );
    const ownerId = event.sender.id;
    const ownerEpoch = getHyperPlanDraftOwnerEpoch(ownerId);
    if (!ownerEpoch) throw new Error("HyperPlan draft owner incarnation is no longer active.");
    const epochIdentity = getHyperPlanOwnerEpochIdentity(ownerEpoch);
    if (!epochIdentity) throw new Error("HyperPlan draft owner incarnation is no longer active.");
    const previous = getHyperPlanStartOperation({
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
          fingerprintPlanSource(parsed.sourceSnapshot as HyperPlanSourceSnapshot))
    )
      throw new Error("HyperPlan build start request conflict.");
    if (previous?.state === "started" && previous.result) {
      return runHyperPlanStartOperation({
        ownerId,
        ownerEpoch,
        requestId: parsed.requestId,
        kind: "original",
        sessionId: previous.sessionId,
        planId: previous.planId,
        planFingerprint: previous.planFingerprint,
        start: async () => previous.result as HyperPlanBuildStart,
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
    const expectedFingerprint = fingerprintPlanSource(
      parsed.sourceSnapshot as HyperPlanSourceSnapshot,
    );
    if (fingerprintPlanSource(plan) !== expectedFingerprint) {
      throw new Error("The original plan source fingerprint changed since it was reviewed.");
    }
    const planFingerprint = expectedFingerprint;
    const runtime = getHyperPlanRuntime();
    return runHyperPlanStartOperation({
      ownerId,
      ownerEpoch,
      requestId: parsed.requestId,
      kind: "original",
      sessionId: session.id,
      planId: plan.id,
      planFingerprint,
      start: (operation, markRunCreated) =>
        runtime.startOriginalPlanBuild(getSenderWindow(event), {
          ownerId,
          ownerEpoch,
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
