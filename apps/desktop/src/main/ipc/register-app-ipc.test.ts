import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  getAgentSession: vi.fn(),
  getAgentRuntime: vi.fn(),
  readPlanById: vi.fn(),
  runHyperPlanReview: vi.fn(),
  startProviderAuth: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "C:/modus-user-data", getVersion: () => "test" },
  BrowserWindow: { fromWebContents: vi.fn() },
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
vi.mock("../agent/tools/plan-tools", () => ({
  plansRoot: () => "C:/plans",
  registerPlanTools: vi.fn(),
}));
vi.mock("../agent/runtime-registry", () => ({ getAgentRuntime: mocks.getAgentRuntime }));
vi.mock("../plan/plan-store", () => ({ readPlanById: mocks.readPlanById }));
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
    mocks.runHyperPlanReview.mockReset().mockResolvedValue(summary);
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
