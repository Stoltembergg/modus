import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  getAgentSession: vi.fn(),
  getAgentRuntime: vi.fn(),
  readPlanById: vi.fn(),
  updatePlanContentById: vi.fn(),
  recordAgentEvent: vi.fn(),
  senderWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  runHyperPlanReview: vi.fn(),
  startProviderAuth: vi.fn(),
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
  getWorkspaceHarnessInsightEvidence: vi.fn(() => ({ runs: [], events: [] })),
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
vi.mock("../plan/plan-store", () => ({
  readPlanById: mocks.readPlanById,
  updatePlanContentById: mocks.updatePlanContentById,
}));
vi.mock("../agent/harness/hyperplan", () => ({ runHyperPlanReview: mocks.runHyperPlanReview }));
vi.mock("../agent/model-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/model-service")>()),
  startProviderAuth: mocks.startProviderAuth,
}));

import type { HyperPlanSummary, PlanRef } from "../../shared/contracts";
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

function registeredHandler(): (...args: never[]) => unknown {
  const handler = mocks.handlers.get(IPC_CHANNELS.agentReviewPlanWithHyperPlan);
  if (!handler) throw new Error("HyperPlan IPC handler was not registered.");
  return handler;
}

describe("dedicated HyperPlan review IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getAgentSession.mockReset();
    mocks.getAgentRuntime.mockReset();
    mocks.readPlanById.mockReset();
    mocks.updatePlanContentById.mockReset();
    mocks.recordAgentEvent.mockReset();
    mocks.senderWindow.webContents.send.mockReset();
    mocks.runHyperPlanReview.mockReset().mockResolvedValue(summary);
    mocks.restoreCheckpoint.mockReset();
    mocks.fromWebContents.mockReset();
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      workspaceId: "workspace-1",
      cwd: "C:/workspace",
    });
    mocks.readPlanById.mockReturnValue(plan);
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
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
