import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  getAgentSession: vi.fn(),
  getAgentRuntime: vi.fn(),
  getRunWorkspaceRevision: vi.fn(),
  isWorkspaceWatched: vi.fn(),
  readPlanById: vi.fn(),
  updatePlanContentById: vi.fn(),
  recordAgentEvent: vi.fn(),
  senderWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  runHyperPlanReview: vi.fn(),
  runHyperPlanRevision: vi.fn(),
  fingerprintPlanSource: vi.fn(),
  promotePlanRevision: vi.fn(),
  publishPlanUpdated: vi.fn(),
  startPlanBuild: vi.fn(),
  startOriginalPlanBuild: vi.fn(),
  assertHyperPlanSessionAvailable: vi.fn(),
  startProviderAuth: vi.fn(),
  startAgentReview: vi.fn(),
  getAgent: vi.fn(),
  getDefaultModelId: vi.fn(),
  isUsableModelId: vi.fn(),
  requireAgentChatWritable: vi.fn(),
  restoreCheckpoint: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "C:/modus-user-data", getVersion: () => "test" },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  clipboard: { writeImage: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false })) },
  shell: { openPath: vi.fn(async () => "") },
}));

vi.mock("../agent/agent-store", () => ({
  getAgentSession: mocks.getAgentSession,
}));
vi.mock("../agent/agent-event-store", () => ({
  listAgentEvents: vi.fn(() => []),
  recordAgentEvent: mocks.recordAgentEvent,
  getRunWorkspaceRevision: mocks.getRunWorkspaceRevision,
  getWorkspaceHarnessInsightEvidence: vi.fn(() => ({ runs: [], events: [] })),
}));
vi.mock("../files/files-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../files/files-watcher")>()),
  isWorkspaceWatched: mocks.isWorkspaceWatched,
}));
vi.mock("../agent/checkpoint-service", () => ({
  getLastTurnComparison: vi.fn(),
  getSessionBaseCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
  restoreCheckpoint: mocks.restoreCheckpoint,
}));
vi.mock("../agent/tools/plan-tools", () => ({
  plansRoot: () => "C:/plans",
  registerPlanTools: vi.fn(),
}));
vi.mock("../agent/runtime-registry", () => ({ getAgentRuntime: mocks.getAgentRuntime }));
vi.mock("../agent/review-service", () => ({
  listAgentReviews: vi.fn(() => []),
  startAgentReview: mocks.startAgentReview,
}));
vi.mock("../plan/plan-store", () => ({
  fingerprintPlanSource: mocks.fingerprintPlanSource,
  promotePlanRevision: mocks.promotePlanRevision,
  readPlanById: mocks.readPlanById,
  updatePlanContentById: mocks.updatePlanContentById,
}));
vi.mock("../agent/harness/hyperplan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/harness/hyperplan")>();
  return {
    ...actual,
    runHyperPlanReview: mocks.runHyperPlanReview,
    runHyperPlanRevision: mocks.runHyperPlanRevision,
  };
});
vi.mock("../agent/model-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/model-service")>()),
  startProviderAuth: mocks.startProviderAuth,
  getDefaultModelId: mocks.getDefaultModelId,
  isUsableModelId: mocks.isUsableModelId,
}));
vi.mock("../agents/agents-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agents-store")>()),
  getAgent: mocks.getAgent,
  requireAgentChatWritable: mocks.requireAgentChatWritable,
}));

import type { HyperPlanRevision, HyperPlanSummary, PlanRef } from "../../shared/contracts";
import {
  clearHyperPlanDraftsForOwner,
  clearHyperPlanDraftsForSession,
  invalidateHyperPlanDraftOwner,
  isHyperPlanSessionReserved,
  registerHyperPlanDraftOwner,
  reserveHyperPlanSession,
} from "../agent/harness/hyperplan-draft-store";
import { IPC_CHANNELS } from "./channels";
import { registerAppIpc } from "./register-app-ipc";
import { registerTrustedSender } from "./trusted-sender";

const summary: HyperPlanSummary = {
  critiques: [
    { critic: "architecture", status: "completed", findings: [], references: [] },
    { critic: "risk", status: "completed", findings: [], references: [] },
    { critic: "simplicity", status: "completed", findings: [], references: [] },
    { critic: "failure", status: "completed", findings: [], references: [] },
  ],
  agreements: [],
  disagreements: [],
  risks: [],
  openQuestions: [],
  references: [],
  revisedContent: "# Revised",
};

const plan: PlanRef = {
  id: "plan-1",
  title: "Spec plan",
  overview: "Reviewable plan.",
  path: "C:/plans/session-1/plan.md",
  hash: "hash",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  blocks: [{ type: "markdown", content: "# Plan" }],
  content: "# Plan\nBounded plan content.",
  todos: [],
  buildStatus: "not_built",
  createdAt: "created",
  updatedAt: "updated",
  spec: {
    requirements: [],
    acceptanceCriteria: [],
    evidence: [],
    assumptions: [],
    openQuestions: [],
  },
};

function planSnapshot(source: PlanRef = plan) {
  return {
    title: source.title,
    overview: source.overview,
    content: source.content,
    todos: source.todos.map(({ id, content, acceptanceCriterionIds }) => ({
      id,
      content,
      acceptanceCriterionIds: acceptanceCriterionIds ?? [],
    })),
    spec: source.spec && {
      requirements: source.spec.requirements,
      acceptanceCriteria: source.spec.acceptanceCriteria,
      assumptions: source.spec.assumptions,
      openQuestions: source.spec.openQuestions,
      evidence: source.spec.evidence,
    },
  };
}

function registeredHandler(): (...args: never[]) => unknown {
  const handler = mocks.handlers.get(IPC_CHANNELS.agentReviewPlanWithHyperPlan);
  if (!handler) throw new Error("HyperPlan IPC handler was not registered.");
  return handler;
}

describe("dedicated HyperPlan review IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    clearHyperPlanDraftsForSession("session-1");
    clearHyperPlanDraftsForOwner(4);
    clearHyperPlanDraftsForOwner(5);
    registerHyperPlanDraftOwner(4);
    registerHyperPlanDraftOwner(5);
    mocks.handlers.clear();
    mocks.getAgentSession.mockReset();
    mocks.getAgent.mockReset();
    mocks.getAgentRuntime.mockReset();
    mocks.getRunWorkspaceRevision.mockReset();
    mocks.isWorkspaceWatched.mockReset();
    mocks.readPlanById.mockReset();
    mocks.updatePlanContentById.mockReset();
    mocks.recordAgentEvent.mockReset();
    mocks.senderWindow.webContents.send.mockReset();
    mocks.runHyperPlanReview.mockReset().mockResolvedValue(summary);
    mocks.runHyperPlanRevision.mockReset().mockResolvedValue({
      title: "Revised plan",
      overview: "Safe revision.",
      content: "# Revised",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    mocks.fingerprintPlanSource
      .mockReset()
      .mockImplementation((candidate: PlanRef) => `${candidate.title}:${candidate.content}`);
    mocks.promotePlanRevision
      .mockReset()
      .mockImplementation((_root, { revision }: { revision: unknown }) => ({
        ...plan,
        ...(revision as object),
        title: "Revised plan",
        content: "# Revised",
        hash: "revised-hash",
      }));
    mocks.publishPlanUpdated.mockReset();
    mocks.startPlanBuild.mockReset().mockResolvedValue({
      sessionId: "session-1",
      planId: "plan-1",
      planFingerprint: "Spec plan:#Plan\nBounded plan content.",
      runId: "run-1",
    });
    mocks.startOriginalPlanBuild.mockReset().mockResolvedValue({
      sessionId: "session-1",
      planId: "plan-1",
      planFingerprint: "Spec plan:#Plan\nBounded plan content.",
      runId: "run-original",
    });
    mocks.assertHyperPlanSessionAvailable.mockReset();
    mocks.restoreCheckpoint.mockReset();
    mocks.fromWebContents.mockReset();
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      workspaceId: "workspace-1",
      cwd: "C:/workspace",
    });
    mocks.readPlanById.mockReturnValue(plan);
    mocks.getAgentRuntime.mockReturnValue({
      assertHyperPlanSessionAvailable: mocks.assertHyperPlanSessionAvailable,
      publishPlanUpdated: mocks.publishPlanUpdated,
      startPlanBuild: mocks.startPlanBuild,
      startOriginalPlanBuild: mocks.startOriginalPlanBuild,
      listRuns: vi.fn(() => []),
    });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("reads the current workspace revision for one exact session and run", async () => {
    const revision = "a".repeat(64);
    mocks.getRunWorkspaceRevision.mockReturnValue(revision);
    const handler = mocks.handlers.get(IPC_CHANNELS.agentRunWorkspaceRevision);
    if (!handler) throw new Error("Run workspace revision IPC handler was not registered.");

    expect(
      handler(trustedEvent as never, { sessionId: "session-1", runId: "run-1" } as never),
    ).toBe(revision);
    expect(mocks.getRunWorkspaceRevision).toHaveBeenCalledWith("session-1", "run-1");
    await expect(
      handler(
        trustedEvent as never,
        { sessionId: "session-1", runId: "run-1", workspaceId: "other" } as never,
      ),
    ).rejects.toThrow();
  });

  it("reports whether live workspace watching is active for QA freshness", async () => {
    mocks.isWorkspaceWatched.mockReturnValue(false);
    const handler = mocks.handlers.get(IPC_CHANNELS.filesWatchStatus);
    if (!handler) throw new Error("Files watcher status IPC handler was not registered.");

    expect(handler(trustedEvent as never, "C:/workspace" as never)).toBe(false);
    expect(mocks.isWorkspaceWatched).toHaveBeenCalledWith("C:/workspace");
    await expect(
      handler(trustedEvent as never, { cwd: "C:/workspace" } as never),
    ).rejects.toThrow();
  });

  it("reviews only an owned Spec plan and passes bounded plan data to the dedicated coordinator", async () => {
    const result = await registeredHandler()(
      trustedEvent as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    );

    expect(result).toBe(summary);
    expect(mocks.readPlanById).toHaveBeenCalledWith("C:/plans", "plan-1");
    expect(mocks.runHyperPlanReview).toHaveBeenCalledWith({
      planContent: plan.content,
      spec: plan.spec,
    });
    expect(mocks.getAgentRuntime).not.toHaveBeenCalled();
  });

  it("applies an explicitly accepted revision and records/broadcasts plan.updated", async () => {
    const updatedPlan = { ...plan, content: "# Revised", hash: "new-hash" };
    mocks.updatePlanContentById.mockImplementation((_root, _id, _hash, _content, afterPersist) => {
      afterPersist?.(updatedPlan);
      return updatedPlan;
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentApplyHyperPlanRevision);
    if (!handler) throw new Error("HyperPlan revision IPC handler was not registered.");

    const result = await handler(
      trustedEvent as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
        planHash: "hash",
        revisedContent: "# Revised",
      } as never,
    );

    expect(mocks.updatePlanContentById).toHaveBeenCalledWith(
      "C:/plans",
      "plan-1",
      "hash",
      "# Revised",
      expect.any(Function),
    );
    expect(result).toBe(updatedPlan);
    const event = { type: "plan.updated", sessionId: "session-1", plan: updatedPlan };
    expect(mocks.recordAgentEvent).toHaveBeenCalledWith(event);
    expect(mocks.senderWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.agentEvent,
      event,
    );
  });

  it("does not deliver or resolve when event persistence fails before commit", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentApplyHyperPlanRevision);
    if (!handler) throw new Error("HyperPlan revision IPC handler was not registered.");
    const updatedPlan = { ...plan, content: "# Revised", hash: "new-hash" };
    mocks.updatePlanContentById.mockImplementation((_root, _id, _hash, _content, afterPersist) => {
      afterPersist?.(updatedPlan);
      return updatedPlan;
    });
    const failure = new Error("SQLite event write failed");
    mocks.recordAgentEvent.mockImplementation(() => {
      throw failure;
    });

    await expect(
      handler(
        trustedEvent as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          planHash: "hash",
          revisedContent: "# Revised",
        } as never,
      ),
    ).rejects.toBe(failure);
    expect(mocks.senderWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("resolves the committed plan when sender delivery fails after event persistence", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentApplyHyperPlanRevision);
    if (!handler) throw new Error("HyperPlan revision IPC handler was not registered.");
    const updatedPlan = { ...plan, content: "# Revised", hash: "new-hash" };
    mocks.updatePlanContentById.mockImplementation((_root, _id, _hash, _content, afterPersist) => {
      afterPersist?.(updatedPlan);
      return updatedPlan;
    });
    mocks.senderWindow.webContents.send.mockImplementation(() => {
      throw new Error("window gone");
    });

    await expect(
      handler(
        trustedEvent as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          planHash: "hash",
          revisedContent: "# Revised",
        } as never,
      ),
    ).resolves.toBe(updatedPlan);
    expect(mocks.recordAgentEvent).toHaveBeenCalledWith({
      type: "plan.updated",
      sessionId: "session-1",
      plan: updatedPlan,
    });
  });

  it("returns application failures as rejected promises without losing their cause", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentApplyHyperPlanRevision);
    if (!handler) throw new Error("HyperPlan revision IPC handler was not registered.");
    const cause = new Error("Plan store write failed");
    mocks.updatePlanContentById.mockImplementation(() => {
      throw cause;
    });

    let result: unknown;
    expect(() => {
      result = handler(
        trustedEvent as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          planHash: "hash",
          revisedContent: "# Revised",
        } as never,
      );
    }).not.toThrow();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(cause);
  });

  it("rejects stale or foreign plan revisions before persistence and event recording", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentApplyHyperPlanRevision);
    if (!handler) throw new Error("HyperPlan revision IPC handler was not registered.");
    await expect(
      handler(
        trustedEvent as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          planHash: "stale",
          revisedContent: "# Revised",
        } as never,
      ),
    ).rejects.toThrow("Plan changed");
    expect(mocks.updatePlanContentById).not.toHaveBeenCalled();
    expect(mocks.recordAgentEvent).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender and a plan from another workspace", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentApplyHyperPlanRevision);
    if (!handler) throw new Error("HyperPlan revision IPC handler was not registered.");
    const payload = {
      sessionId: "session-1",
      planId: "plan-1",
      planHash: "hash",
      revisedContent: "# Revised",
    };
    await expect(
      handler(
        {
          sender: { mainFrame: { url: "file:///attacker.html" } },
          senderFrame: { url: "file:///attacker.html" },
        } as never,
        payload as never,
      ),
    ).rejects.toThrow("Blocked IPC call from untrusted renderer frame.");
    mocks.getAgentSession.mockReturnValue({ id: "session-1", workspaceId: "another-workspace" });
    await expect(handler(trustedEvent as never, payload as never)).rejects.toThrow();
    expect(mocks.updatePlanContentById).not.toHaveBeenCalled();
    expect(mocks.recordAgentEvent).not.toHaveBeenCalled();
  });

  it("rejects untrusted senders and malformed requests before reading session data", async () => {
    await expect(
      registeredHandler()(
        {
          sender: { mainFrame: { url: "file:///attacker.html" } },
          senderFrame: { url: "file:///attacker.html" },
        } as never,
        { sessionId: "session-1", planId: "plan-1" } as never,
      ),
    ).rejects.toThrow("Blocked IPC call from untrusted renderer frame.");
    await expect(
      registeredHandler()(
        trustedEvent as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          extra: true,
        } as never,
      ),
    ).rejects.toThrow();
    expect(mocks.getAgentSession).not.toHaveBeenCalled();
  });

  it("records and publishes the checkpoint restore event through the IPC handler", async () => {
    const checkpoint = {
      id: "checkpoint-1",
      sessionId: "session-1",
      cwd: "C:/workspace",
      commitHash: "abc123",
      kind: "auto" as const,
      createdAt: "2026-09-27T00:00:00.000Z",
    };
    const send = vi.fn();
    mocks.restoreCheckpoint.mockResolvedValue(checkpoint);
    mocks.fromWebContents.mockReturnValue({ webContents: { send } });
    const handler = mocks.handlers.get(IPC_CHANNELS.checkpointRestore);
    if (!handler) throw new Error("Checkpoint restore IPC handler was not registered.");

    await handler(trustedEvent as never, { checkpointId: checkpoint.id } as never);
    const restoredEvent = {
      type: "checkpoint.restored",
      sessionId: checkpoint.sessionId,
      checkpointId: checkpoint.id,
    };
    expect(mocks.recordAgentEvent).toHaveBeenCalledWith(restoredEvent);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.agentEvent, restoredEvent);
  });

  it.each([
    ["missing session", undefined, plan],
    [
      "foreign plan owner",
      { id: "session-1", workspaceId: "workspace-1" },
      { ...plan, sessionId: "other" },
    ],
    ["foreign workspace", { id: "session-1", workspaceId: "workspace-2" }, plan],
    [
      "ordinary plan without a Spec",
      { id: "session-1", workspaceId: "workspace-1" },
      { ...plan, spec: undefined },
    ],
  ])("rejects %s", async (_label, session, candidatePlan) => {
    mocks.getAgentSession.mockReturnValue(session);
    mocks.readPlanById.mockReturnValue(candidatePlan);

    await expect(
      registeredHandler()(
        trustedEvent as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
        } as never,
      ),
    ).rejects.toThrow();
    expect(mocks.runHyperPlanReview).not.toHaveBeenCalled();
  });

  it("generates a main-owned preview only for an owned source and rejects extra request fields", async () => {
    const createDraftChannel = IPC_CHANNELS.agentCreateHyperPlanDraft;
    const handler = mocks.handlers.get(createDraftChannel);
    if (!handler) throw new Error("HyperPlan draft IPC handler was not registered.");
    const senderWithId = { ...sender, id: 4 };
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    registerTrustedSender(senderWithId, "file:///app/index.html");

    const preview = await handler(
      event as never,
      { sessionId: "session-1", planId: "plan-1" } as never,
    );
    expect(preview).toMatchObject({
      draftId: expect.any(String),
      revision: { title: "Revised plan" },
    });
    expect(mocks.runHyperPlanRevision).toHaveBeenCalledWith(
      {
        title: plan.title,
        overview: plan.overview,
        content: plan.content,
        todos: plan.todos,
        spec: plan.spec,
      },
      undefined,
    );
    await expect(
      handler(
        event as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          workspaceId: "renderer-chosen",
        } as never,
      ),
    ).rejects.toThrow();
    expect(mocks.runHyperPlanRevision).toHaveBeenCalledTimes(1);
  });

  it("passes the composer or session model into HyperPlan revision", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    if (!handler) throw new Error("HyperPlan draft IPC handler was not registered.");
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      workspaceId: "workspace-1",
      cwd: "C:/workspace",
      model: "session-model",
    });

    await handler(
      { sender: senderWithId, senderFrame: sender.mainFrame } as never,
      { sessionId: "session-1", planId: "plan-1", model: "composer-model" } as never,
    );

    expect(mocks.runHyperPlanRevision).toHaveBeenCalledWith(
      expect.objectContaining({ title: plan.title }),
      { modelId: "composer-model" },
    );
  });

  it("surfaces a sanitized HyperPlan failure without leaking private details", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    if (!handler) throw new Error("HyperPlan draft IPC handler was not registered.");
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.runHyperPlanRevision.mockRejectedValueOnce(
      new Error("Session setup failed: /home/user/.modus/providers/secret.json"),
    );

    let thrown: unknown;
    try {
      await handler(
        { sender: senderWithId, senderFrame: sender.mainFrame } as never,
        { sessionId: "session-1", planId: "plan-1" } as never,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/unavailable|try again/i);
    expect((thrown as Error).message).not.toMatch(/secret\.json|\/home\/user/);
  });

  it("discards a generation if the authoritative source changes while review is in flight", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    if (!handler) throw new Error("HyperPlan draft IPC handler was not registered.");
    mocks.runHyperPlanRevision.mockImplementationOnce(async () => {
      mocks.readPlanById.mockReturnValue({ ...plan, title: "Changed while reviewing" });
      return {
        title: "Should be discarded",
        overview: "Stale",
        content: "# Stale",
        todos: [],
        spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
      };
    });

    await expect(
      handler(
        { sender: senderWithId, senderFrame: sender.mainFrame } as never,
        { sessionId: "session-1", planId: "plan-1" } as never,
      ),
    ).rejects.toThrow(/changed during/i);
    expect(mocks.assertHyperPlanSessionAvailable).toHaveBeenCalledWith("session-1");
  });

  it("rejects a generation that finishes after its session was deleted", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    if (!handler) throw new Error("HyperPlan draft handler was not registered.");
    mocks.getAgentSession.mockReturnValueOnce({
      id: "session-1",
      workspaceId: "workspace-1",
      cwd: "C:/workspace",
    });
    mocks.getAgentSession.mockReturnValueOnce(undefined);

    let finishRevision!: (revision: HyperPlanRevision) => void;
    mocks.runHyperPlanRevision.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRevision = resolve;
        }),
    );
    const pending = handler(
      { sender: senderWithId, senderFrame: sender.mainFrame } as never,
      { sessionId: "session-1", planId: "plan-1" } as never,
    );
    finishRevision({
      title: "Orphaned revision",
      overview: "Deleted session",
      content: "# Orphaned",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });

    await expect(pending).rejects.toThrow(/changed during/i);
  });

  it("rejects an old generation after owner-ID reuse without releasing the new owner's reservation", async () => {
    const ownerId = 4;
    const senderWithId = { ...sender, id: ownerId };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    if (!handler) throw new Error("HyperPlan draft handler was not registered.");

    let finishRevision!: (revision: HyperPlanRevision) => void;
    mocks.runHyperPlanRevision.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRevision = resolve;
        }),
    );
    const oldEpoch = registerHyperPlanDraftOwner(ownerId);
    const oldAttempt = handler(
      { sender: senderWithId, senderFrame: sender.mainFrame } as never,
      { sessionId: "session-1", planId: "plan-1" } as never,
    );

    expect(invalidateHyperPlanDraftOwner(ownerId, oldEpoch)).toBe(true);
    const newEpoch = registerHyperPlanDraftOwner(ownerId);
    expect(isHyperPlanSessionReserved("session-1")).toBe(false);
    const newAttempt = (await handler(
      { sender: senderWithId, senderFrame: sender.mainFrame } as never,
      { sessionId: "session-1", planId: "plan-1" } as never,
    )) as { draftId: string };
    expect(newAttempt.draftId).toEqual(expect.any(String));

    expect(isHyperPlanSessionReserved("session-1")).toBe(false);
    expect(reserveHyperPlanSession({ sessionId: "session-1", ownerId, ownerEpoch: newEpoch })).toBe(
      true,
    );
    finishRevision({
      title: "Old revision",
      overview: "Old",
      content: "# Old",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    await expect(oldAttempt).rejects.toThrow(
      /unavailable in this window|owner|incarnation|invalid/i,
    );
    expect(isHyperPlanSessionReserved("session-1")).toBe(true);
    expect(invalidateHyperPlanDraftOwner(ownerId, newEpoch)).toBe(true);
  });

  it("starts a fresh original build after owner epoch changes with the same request ID", async () => {
    const ownerId = 4;
    const senderWithId = { ...sender, id: ownerId };
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    mocks.fromWebContents.mockReturnValue({});
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentStartOriginalPlanBuild);
    if (!handler) throw new Error("HyperPlan original start handler was not registered.");
    const input = {
      sessionId: "session-1",
      planId: "plan-1",
      requestId: "reused",
      sourceSnapshot: planSnapshot(),
    };

    const epochA = registerHyperPlanDraftOwner(ownerId);
    await handler(event as never, input as never);
    expect(mocks.startOriginalPlanBuild).toHaveBeenCalledTimes(1);
    const firstKey = mocks.startOriginalPlanBuild.mock.calls[0]?.[1].idempotencyKey;
    expect(firstKey).toMatch(new RegExp(`^original:${ownerId}:[0-9a-f-]{36}:reused$`, "i"));
    await handler(event as never, input as never);
    expect(mocks.startOriginalPlanBuild).toHaveBeenCalledTimes(1);

    expect(invalidateHyperPlanDraftOwner(ownerId, epochA)).toBe(true);
    registerHyperPlanDraftOwner(ownerId);
    await handler(event as never, input as never);
    expect(mocks.startOriginalPlanBuild).toHaveBeenCalledTimes(2);
    const secondKey = mocks.startOriginalPlanBuild.mock.calls[1]?.[1].idempotencyKey;
    expect(secondKey).toMatch(new RegExp(`^original:${ownerId}:[0-9a-f-]{36}:reused$`, "i"));
    expect(firstKey).not.toBe(secondKey);
  });

  it("does not let a replacement IPC owner use an old draft, choice replay, or selection", async () => {
    const ownerId = 4;
    const senderWithId = { ...sender, id: ownerId };
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    const start = mocks.handlers.get(IPC_CHANNELS.agentStartPlanBuild);
    if (!create || !choose || !start) throw new Error("HyperPlan handlers were not registered.");
    const epochA = registerHyperPlanDraftOwner(ownerId);
    const preview = (await create(
      event as never,
      { sessionId: "session-1", planId: "plan-1" } as never,
    )) as { draftId: string };
    const request = { draftId: preview.draftId, choice: "original", requestId: "reuse-choice" };
    const selection = (await choose(event as never, request as never)) as { selectionId: string };
    registerHyperPlanDraftOwner(ownerId);

    expect(() => choose(event as never, request as never)).toThrow(/draft|owner/i);
    await expect(
      start(
        event as never,
        { selectionId: selection.selectionId, requestId: "reuse-start" } as never,
      ),
    ).rejects.toThrow(/selection/i);
    expect(isHyperPlanSessionReserved("session-1")).toBe(true);
    expect(invalidateHyperPlanDraftOwner(ownerId, epochA)).toBe(false);
    expect(isHyperPlanSessionReserved("session-1")).toBe(false);
  });

  it("rejects a HyperPlan start when the sender has no active owner epoch", async () => {
    const ownerId = 4;
    const senderWithId = { ...sender, id: ownerId };
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentStartOriginalPlanBuild);
    if (!handler) throw new Error("HyperPlan original start handler was not registered.");
    const epoch = registerHyperPlanDraftOwner(ownerId);
    invalidateHyperPlanDraftOwner(ownerId, epoch);

    await expect(
      handler(
        event as never,
        {
          sessionId: "session-1",
          planId: "plan-1",
          requestId: "no-owner",
          sourceSnapshot: planSnapshot(),
        } as never,
      ),
    ).rejects.toThrow(/owner incarnation/i);
    expect(mocks.startOriginalPlanBuild).not.toHaveBeenCalled();
  });

  it("rejects a busy owner session and a wrong draft owner before any promotion", async () => {
    const senderWithId = { ...sender, id: 4 };
    const otherSender = { ...sender, id: 5 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    registerTrustedSender(otherSender, "file:///app/index.html");
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    if (!create || !choose) throw new Error("HyperPlan draft/choice handlers were not registered.");
    const ownerEvent = { sender: senderWithId, senderFrame: sender.mainFrame };
    const otherEvent = { sender: otherSender, senderFrame: sender.mainFrame };
    const preview = (await create(
      ownerEvent as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    )) as { draftId: string };

    expect(() =>
      choose(
        otherEvent as never,
        {
          draftId: preview.draftId,
          choice: "revision",
          requestId: "foreign-owner",
        } as never,
      ),
    ).toThrow(/owner/i);
    mocks.assertHyperPlanSessionAvailable.mockImplementationOnce(() => {
      throw new Error("Session has an active run.");
    });
    expect(() =>
      choose(
        ownerEvent as never,
        {
          draftId: preview.draftId,
          choice: "revision",
          requestId: "busy-choice",
        } as never,
      ),
    ).toThrow(/active run/i);
    expect(mocks.promotePlanRevision).not.toHaveBeenCalled();
  });

  it("promotes and publishes a revision before returning the main-owned selection", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.fromWebContents.mockReturnValue({ webContents: { send: vi.fn() } });
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    if (!create || !choose) throw new Error("HyperPlan draft/choice handlers were not registered.");
    const preview = (await create(
      event as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    )) as { draftId: string };
    const order: string[] = [];
    mocks.promotePlanRevision.mockImplementation(() => {
      order.push("promote");
      return { ...plan, title: "Revised plan", content: "# Revised", hash: "revised-hash" };
    });
    mocks.publishPlanUpdated.mockImplementation(() => order.push("publish"));

    const selection = await choose(
      event as never,
      {
        draftId: preview.draftId,
        choice: "revision",
        requestId: "choice-1",
      } as never,
    );

    expect(order).toEqual(["promote", "publish"]);
    expect(selection).toMatchObject({
      selectionId: expect.any(String),
      plan: { title: "Revised plan" },
      planFingerprint: "Revised plan:# Revised",
    });
    expect(mocks.promotePlanRevision).toHaveBeenCalledWith("C:/plans", {
      planId: plan.id,
      expectedFingerprint: "Spec plan:# Plan\nBounded plan content.",
      revision: expect.objectContaining({ title: "Revised plan" }),
    });
  });

  it("keeps original choice write-free and reconciles identical requests only", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    if (!create || !choose) throw new Error("HyperPlan draft/choice handlers were not registered.");
    const preview = (await create(
      event as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    )) as { draftId: string };
    const request = { draftId: preview.draftId, choice: "original", requestId: "original-1" };
    const selected = await choose(event as never, request as never);
    expect(selected).toMatchObject({ plan: { content: plan.content } });
    expect(mocks.promotePlanRevision).not.toHaveBeenCalled();
    expect(mocks.publishPlanUpdated).not.toHaveBeenCalled();
    expect(await choose(event as never, request as never)).toEqual(selected);
    expect(() => choose(event as never, { ...request, choice: "revision" } as never)).toThrow(
      /conflict/i,
    );
    expect(() => choose(event as never, { ...request, plan: { ...plan } } as never)).toThrow();
    mocks.readPlanById.mockReturnValue({ ...plan, title: "Changed after selection" });
    expect(() => choose(event as never, request as never)).toThrow(/changed after/i);
  });

  it("retries publication for the same promoted choice without promoting twice", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.fromWebContents.mockReturnValue({ webContents: { send: vi.fn() } });
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    if (!create || !choose) throw new Error("HyperPlan draft/choice handlers were not registered.");
    const preview = (await create(
      event as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    )) as { draftId: string };
    mocks.publishPlanUpdated.mockImplementationOnce(() => {
      throw new Error("injected event persistence failure");
    });
    const request = {
      draftId: preview.draftId,
      choice: "revision",
      requestId: "publish-retry",
    };

    expect(() => choose(event as never, request as never)).toThrow(/event persistence/i);
    mocks.readPlanById.mockReturnValue({
      ...plan,
      title: "Revised plan",
      content: "# Revised",
      hash: "revised-hash",
    });
    const selection = choose(event as never, request as never);

    expect(mocks.promotePlanRevision).toHaveBeenCalledTimes(1);
    expect(mocks.publishPlanUpdated).toHaveBeenCalledTimes(2);
    expect(selection).toMatchObject({ selectionId: expect.any(String) });
    const firstSelectionId = mocks.publishPlanUpdated.mock.calls[0]?.[3];
    expect(firstSelectionId).toBe((selection as { selectionId: string }).selectionId);
    expect(mocks.publishPlanUpdated.mock.calls[1]?.[3]).toBe(firstSelectionId);
  });

  it("starts only the main-owned selection using its selection and request IDs", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.fromWebContents.mockReturnValue({ webContents: { send: vi.fn() } });
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    const start = mocks.handlers.get("agent:start-plan-build");
    if (!create || !choose || !start) throw new Error("HyperPlan build start handlers missing.");
    const preview = (await create(
      event as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    )) as { draftId: string };
    const selection = (await choose(
      event as never,
      {
        draftId: preview.draftId,
        choice: "original",
        requestId: "choice-start",
      } as never,
    )) as { selectionId: string };

    const request = { selectionId: selection.selectionId, requestId: "start-request" };
    const firstStart = await start(event as never, request as never);
    const replay = await start(event as never, request as never);

    expect(mocks.startPlanBuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-1",
        planId: "plan-1",
        selectionId: selection.selectionId,
      }),
    );
    expect(mocks.startPlanBuild.mock.calls[0]?.[1]).not.toHaveProperty("plan");
    expect(mocks.startPlanBuild).toHaveBeenCalledTimes(1);
    expect(replay).toEqual(firstStart);
  });

  it("rejects a start when the authoritative selected plan fingerprint has changed", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    const event = { sender: senderWithId, senderFrame: sender.mainFrame };
    const create = mocks.handlers.get(IPC_CHANNELS.agentCreateHyperPlanDraft);
    const choose = mocks.handlers.get(IPC_CHANNELS.agentResolveHyperPlanDraftChoice);
    const start = mocks.handlers.get("agent:start-plan-build");
    if (!create || !choose || !start) throw new Error("HyperPlan build start handlers missing.");
    const preview = (await create(
      event as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
      } as never,
    )) as { draftId: string };
    const selection = (await choose(
      event as never,
      {
        draftId: preview.draftId,
        choice: "original",
        requestId: "choice-stale-start",
      } as never,
    )) as { selectionId: string };
    mocks.readPlanById.mockReturnValue({ ...plan, title: "Changed after choice" });

    await expect(
      start(
        event as never,
        {
          selectionId: selection.selectionId,
          requestId: "stale-build-start",
        } as never,
      ),
    ).rejects.toThrow(/fingerprint changed/i);
    expect(mocks.startPlanBuild).not.toHaveBeenCalled();
  });

  it("supports explicit original-plan start using only authoritative IDs", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.fromWebContents.mockReturnValue({ webContents: { send: vi.fn() } });
    const startOriginal = mocks.handlers.get("agent:start-original-plan-build");
    if (!startOriginal) throw new Error("Original-plan build start handler missing.");

    await startOriginal(
      { sender: senderWithId, senderFrame: sender.mainFrame } as never,
      {
        sessionId: "session-1",
        planId: "plan-1",
        requestId: "original-start",
        sourceSnapshot: planSnapshot(),
      } as never,
    );

    expect(mocks.startOriginalPlanBuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", planId: "plan-1" }),
    );
    expect(mocks.startOriginalPlanBuild.mock.calls[0]?.[1]).not.toHaveProperty("plan");
  });

  it("rejects snapshot mismatch before runtime start and binds retries to the exact snapshot", async () => {
    const senderWithId = { ...sender, id: 4 };
    registerTrustedSender(senderWithId, "file:///app/index.html");
    mocks.fromWebContents.mockReturnValue({ webContents: { send: vi.fn() } });
    const startOriginal = mocks.handlers.get("agent:start-original-plan-build");
    if (!startOriginal) throw new Error("Original-plan build start handler missing.");
    const snapshot = planSnapshot();
    const call = (sourceSnapshot: typeof snapshot, requestId = "bound-start") =>
      startOriginal(
        { sender: senderWithId, senderFrame: sender.mainFrame } as never,
        { sessionId: "session-1", planId: "plan-1", requestId, sourceSnapshot } as never,
      );
    mocks.fingerprintPlanSource.mockImplementation((candidate: PlanRef) =>
      JSON.stringify(planSnapshot(candidate)),
    );

    await expect(call({ ...snapshot, overview: "Different metadata" })).rejects.toThrow(
      /fingerprint changed/i,
    );
    await expect(
      call({ ...snapshot, content: "Different markdown" }, "content-mismatch"),
    ).rejects.toThrow(/fingerprint changed/i);
    expect(mocks.startOriginalPlanBuild).not.toHaveBeenCalled();

    await call(snapshot);
    await call(snapshot);
    expect(mocks.startOriginalPlanBuild).toHaveBeenCalledOnce();
    expect(mocks.startOriginalPlanBuild.mock.calls[0]?.[1].planFingerprint).toBe(
      JSON.stringify(snapshot),
    );
    await expect(call({ ...snapshot, content: "Different content" })).rejects.toThrow(/conflict/i);
    expect(mocks.startOriginalPlanBuild).toHaveBeenCalledOnce();
  });
});

describe("group integration IPC registration", () => {
  beforeEach(() => mocks.handlers.clear());

  it("registers all integration preview, mutation, state, and refresh handlers", () => {
    registerAppIpc();

    expect(mocks.handlers.has(IPC_CHANNELS.groupIntegrationPreview)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.groupIntegrationApply)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.groupIntegrationAbort)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.groupIntegrationState)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.groupIntegrationRefresh)).toBe(true);
  });
});

describe("provider auth start IPC", () => {
  it("forwards the acknowledgement to the main service", async () => {
    const sender = { mainFrame: { url: "file:///app/index.html" } };
    registerTrustedSender(sender, "file:///app/index.html");
    mocks.handlers.clear();
    mocks.startProviderAuth.mockReset().mockReturnValue({
      id: "op",
      provider: "antigravity",
      status: "pending",
      message: "Preparing",
    });
    registerAppIpc();
    const handler = mocks.handlers.get(IPC_CHANNELS.modelProviderAuthStart);

    await handler?.(
      { sender, senderFrame: sender.mainFrame } as never,
      { provider: "antigravity", riskAcknowledged: true } as never,
    );

    expect(mocks.startProviderAuth).toHaveBeenCalledWith("antigravity", expect.any(Function), {
      riskAcknowledged: true,
    });
  });
});

describe("app version IPC", () => {
  it("returns app.getVersion() to a trusted renderer and rejects others", async () => {
    const sender = { mainFrame: { url: "file:///app/index.html" } };
    registerTrustedSender(sender, "file:///app/index.html");
    mocks.handlers.clear();
    registerAppIpc();
    const handler = mocks.handlers.get(IPC_CHANNELS.appVersion);

    expect(await handler?.({ sender, senderFrame: sender.mainFrame } as never)).toBe("test");
    expect(() =>
      handler?.({
        sender: { mainFrame: { url: "file:///attacker.html" } },
        senderFrame: { url: "file:///attacker.html" },
      } as never),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
  });
});

describe("subagent worktree IPC with Agent Group member sessions", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getAgentSession.mockReset();
    // A member session with a group worktree: it has no parentSessionId.
    mocks.getAgentSession.mockReturnValue({
      id: "member-1",
      workspaceId: "workspace-1",
      cwd: "C:/workspace/.modus/worktrees/group-g1-alpha",
      subagentWorktree: {
        path: "C:/workspace/.modus/worktrees/group-g1-alpha",
        branch: "group/g1/alpha",
        baseSha: "abc123",
        integrationStatus: "applied",
      },
    });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it.each([
    IPC_CHANNELS.agentApplySubagentWorktree,
    IPC_CHANNELS.agentAbortSubagentWorktreeApply,
    IPC_CHANNELS.agentCleanupSubagentWorktree,
  ])("%s refuses a member session (no parentSessionId)", async (channel) => {
    const handler = mocks.handlers.get(channel);
    if (!handler) throw new Error(`${channel} was not registered.`);
    await expect(handler(trustedEvent as never, "member-1" as never)).rejects.toThrow(
      "Subagent worktree not found.",
    );
    // Refused before looking up any parent session or touching git.
    expect(mocks.getAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.getAgentSession).toHaveBeenCalledWith("member-1");
  });
});

describe("agent:prompt preserves the session model", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };
  const prompt = vi.fn(async () => ({ outcome: "ok" }));

  beforeEach(() => {
    mocks.handlers.clear();
    prompt.mockClear();
    mocks.getDefaultModelId.mockReset().mockReturnValue("anthropic/claude-opus-5-5");
    mocks.isUsableModelId.mockReset().mockReturnValue(true);
    mocks.getAgentSession.mockReset();
    mocks.getAgent.mockReset();
    mocks.requireAgentChatWritable.mockReset();
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    mocks.getAgentRuntime.mockReturnValue({ prompt });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("an old session's model (sent by the renderer) and its thinking are ignored for the run", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "anthropic/claude-opus-5-5",
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await handler?.(
      trustedEvent as never,
      {
        sessionId: "session-1",
        message: "hi",
        model: "openai/old-disallowed",
        thinkingVariant: "max",
      } as never,
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("anthropic/claude-opus-5-5");
    expect(input).not.toHaveProperty("thinkingVariant");
    expect(input).not.toHaveProperty("thinkingLevel");
  });

  it("preserves the exact Modus model selected for a 1:1 session", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "modus/anthropic/claude-fable-5-1",
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await handler?.(
      trustedEvent as never,
      { sessionId: "session-1", message: "hi", model: "modus/anthropic/claude-fable-5-1" } as never,
    );
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("modus/anthropic/claude-fable-5-1");
    expect(mocks.getAgentSession).toHaveBeenCalledWith("session-1");
  });

  it("a BYOK session keeps its stored model instead of the Settings default", async () => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1", model: "openai/gpt-5" });
    mocks.getDefaultModelId.mockReturnValue("modus/deepseek/deepseek-flash");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("openai/gpt-5");
  });

  it("preserves the model selected for a linked session over its agent setting", async () => {
    const sessionModel = "byok/session-selection";
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: sessionModel,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe(sessionModel);
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("uses the linked agent model when the session has no saved selection", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("byok/agent-model");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("uses the Settings default when a linked agent has no model", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: null });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).toHaveProperty("model", null);
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("restores a saved session model when it differs from the linked agent", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: "byok/session-selection",
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await handler(trustedEvent as never, "session-1" as never);

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1", "byok/session-selection");
  });

  it("uses the linked agent model to restore a session with no saved selection", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await handler(trustedEvent as never, "session-1" as never);

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1", "byok/agent-model");
  });

  it("passes the app-default directive into restoration for a linked agent without a model", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: null });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await handler(trustedEvent as never, "session-1" as never);

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1", null);
  });

  it("rejects a removed linked agent model before restoring its session", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/removed-model" });
    mocks.isUsableModelId.mockReturnValue(false);
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await expect(handler(trustedEvent as never, "session-1" as never)).rejects.toThrow(
      "Selected model is unavailable: byok/removed-model",
    );

    expect(ensure).not.toHaveBeenCalled();
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("defers a legacy session with no database model to runtime branch restoration", async () => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1", model: undefined });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(
      trustedEvent as never,
      {
        sessionId: "session-1",
        message: "hi",
        model: "renderer/untrusted",
      } as never,
    );

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).not.toHaveProperty("model");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("defers an absent session choice to runtime when Settings has no default", async () => {
    mocks.getDefaultModelId.mockReturnValue(undefined);
    prompt.mockRejectedValueOnce(new Error("No model is configured"));
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await expect(
      handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never),
    ).rejects.toThrow("No model is configured");
    expect(prompt).toHaveBeenCalledTimes(1);
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).not.toHaveProperty("model");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it.each([
    "byok/removed-model",
    "modus/removed-model",
  ])("refuses unavailable explicit model %s without sending a request to the Settings default", async (selectedModel) => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1", model: selectedModel });
    mocks.isUsableModelId.mockReturnValue(false);
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await expect(
      handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never),
    ).rejects.toThrow(`Selected model is unavailable: ${selectedModel}`);

    expect(prompt).not.toHaveBeenCalled();
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });
});

describe("reviewStart preserves the session model", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getAgentSession.mockReset();
    mocks.getAgent.mockReset();
    mocks.getAgentRuntime.mockReset();
    mocks.startAgentReview.mockReset().mockResolvedValue({ id: "review-1" });
    mocks.getDefaultModelId.mockReset().mockReturnValue("openai/current-default");
    mocks.isUsableModelId.mockReset().mockReturnValue(true);
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("passes the exact stored session model to the dedicated review", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "byok/session-model",
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await handler(
      trustedEvent as never,
      {
        cwd: "C:/workspace",
        sessionId: "session-1",
      } as never,
    );

    expect(mocks.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok/session-model" }),
    );
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("preserves a linked session's selected model for review over its agent setting", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: "byok/session-selection",
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await handler(
      trustedEvent as never,
      {
        cwd: "C:/workspace",
        sessionId: "session-1",
      } as never,
    );

    expect(mocks.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok/session-selection" }),
    );
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("restores an unlinked legacy branch before choosing the review model", async () => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1" });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1", model: "byok/legacy-model" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await handler(
      trustedEvent as never,
      {
        cwd: "C:/workspace",
        sessionId: "session-1",
      } as never,
    );

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1");
    expect(mocks.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok/legacy-model" }),
    );
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("does not start a review on the default when the stored model is unavailable", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "byok/removed-model",
    });
    mocks.isUsableModelId.mockReturnValue(false);
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await expect(
      handler(
        trustedEvent as never,
        {
          cwd: "C:/workspace",
          sessionId: "session-1",
        } as never,
      ),
    ).rejects.toThrow("Selected model is unavailable: byok/removed-model");

    expect(mocks.startAgentReview).not.toHaveBeenCalled();
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });
});
