import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRef } from "../../shared/contracts";
import {
  clearPlanBuildStateForSession,
  invalidatePlanBuildOwner,
  registerPlanBuildOwner,
} from "../agent/harness/plan-build-store";
import { writePlan } from "../plan/plan-store";
import { IPC_CHANNELS } from "./channels";
import { registerPlanBuildIpcHandlers } from "./plan-build-ipc";
import { registerTrustedSender } from "./trusted-sender";

const state = vi.hoisted(() => ({
  root: "",
  getSession: vi.fn(),
  start: vi.fn(),
  writable: vi.fn(),
  getAgent: vi.fn(),
  usable: vi.fn(),
  window: { webContents: { send: vi.fn() } },
}));
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => state.window } }));
vi.mock("../agent/agent-store", () => ({ getAgentSession: state.getSession }));
vi.mock("../agent/tools/plan-tools", () => ({ plansRoot: () => state.root }));
vi.mock("../agent/runtime-registry", () => ({
  getAgentRuntime: () => ({
    startPlanBuild: state.start,
    assertPlanBuildSessionAvailable: () => {},
  }),
}));
vi.mock("../agents/agents-store", () => ({
  requireSessionWritable: state.writable,
  getAgent: state.getAgent,
}));
vi.mock("../agent/model-service", () => ({
  getDefaultModelId: () => "default/model",
  isUsableModelId: state.usable,
}));
const sender = { id: 920, mainFrame: { url: "file:///app/index.html" } };
const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
let handlers: Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>;
let plan: PlanRef;
let epoch: symbol;
let unregister: () => void;
const snapshot = () => ({
  title: plan.title,
  overview: plan.overview,
  content: plan.content,
  todos: plan.todos.map((todo) => ({
    id: todo.id,
    content: todo.content,
    acceptanceCriterionIds: [],
  })),
});
const start = (overrides: Record<string, unknown> = {}) => {
  const handler = handlers.get(IPC_CHANNELS.agentStartPlanBuild);
  if (!handler) throw new Error("Missing plan approval handler");
  return handler(event, {
    sessionId: plan.sessionId,
    planId: plan.id,
    requestId: "approved-request",
    sourceSnapshot: snapshot(),
    ...overrides,
  });
};
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "modus-plan-approval-"));
  epoch = registerPlanBuildOwner(sender.id);
  unregister = registerTrustedSender(sender, sender.mainFrame.url);
  handlers = new Map();
  registerPlanBuildIpcHandlers({
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
  });
  plan = writePlan(state.root, {
    workspaceId: "workspace",
    sessionId: "plan-session",
    title: "Plan",
    overview: "Existing flow",
    content: "Read and implement the approved plan",
    todos: [{ id: "step", content: "Implement" }],
  });
  state.writable.mockReset();
  state.getAgent.mockReset().mockReturnValue({ modelId: "agent/model" });
  state.usable.mockReset().mockReturnValue(true);
  state.getSession.mockReset().mockReturnValue({
    id: plan.sessionId,
    workspaceId: plan.workspaceId,
    model: "chosen-provider/chosen-model",
  });
  state.start.mockReset().mockImplementation(async (_window, input) => {
    input.onRunCreated("approved-run");
    return {
      sessionId: input.sessionId,
      planId: input.planId,
      planFingerprint: input.planFingerprint,
      runId: "approved-run",
    };
  });
});
afterEach(() => {
  clearPlanBuildStateForSession(plan.sessionId);
  invalidatePlanBuildOwner(sender.id, epoch);
  unregister();
  rmSync(state.root, { recursive: true, force: true });
});
describe("productive plan approval IPC", () => {
  it("exposes only the Plan build endpoint and starts old plans without structured metadata", async () => {
    expect([...handlers.keys()]).toEqual(["agent:start-plan-build"]);
    const result = await start();
    expect(result).toMatchObject({ runId: "approved-run" });
    expect(await start()).toEqual(result);
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start.mock.calls[0]?.[1]).toMatchObject({
      ownerId: sender.id,
      ownerEpoch: epoch,
      planId: plan.id,
    });
  });
  it("uses the exact saved model and refuses an unavailable explicit selection", async () => {
    await start();
    expect(state.start.mock.calls[0]?.[1]).toMatchObject({ model: "chosen-provider/chosen-model" });
    clearPlanBuildStateForSession(plan.sessionId);
    state.start.mockClear();
    state.usable.mockReturnValue(false);
    await expect(start({ requestId: "removed-model" })).rejects.toThrow(
      /Selected model is unavailable/,
    );
    expect(state.start).not.toHaveBeenCalled();
  });
  it("blocks approval of read-only migrated history", async () => {
    state.writable.mockImplementation(() => {
      throw new Error("read-only history");
    });
    await expect(start()).rejects.toThrow(/read-only/);
    expect(state.start).not.toHaveBeenCalled();
  });
  it("rejects a source changed after approval before starting the runtime", async () => {
    await expect(
      start({ sourceSnapshot: { ...snapshot(), content: "Different plan" } }),
    ).rejects.toThrow(/fingerprint/);
    expect(state.start).not.toHaveBeenCalled();
  });
  it("rejects a plan belonging to a different workspace", async () => {
    state.getSession.mockReturnValue({ id: plan.sessionId, workspaceId: "other-workspace" });
    await expect(start()).rejects.toThrow(/not owned/);
    expect(state.start).not.toHaveBeenCalled();
  });
  it("rejects a renderer without a current host owner incarnation", async () => {
    invalidatePlanBuildOwner(sender.id, epoch);
    await expect(start()).rejects.toThrow(/incarnation/);
    expect(state.start).not.toHaveBeenCalled();
  });
  it("rejects a changed source on retry instead of silently starting another plan", async () => {
    await start();
    await expect(
      start({ sourceSnapshot: { ...snapshot(), title: "Different title" } }),
    ).rejects.toThrow(/conflict/);
    expect(state.start).toHaveBeenCalledOnce();
  });
});
