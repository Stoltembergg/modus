import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  calls: [] as string[],
  session: undefined as { id: string; cwd: string } | undefined,
  clearDraftsForSession: vi.fn(() => lifecycleState.calls.push("clear-drafts")),
  deleteSession: vi.fn(() => lifecycleState.calls.push("delete-session")),
  dispose: vi.fn(async () => lifecycleState.calls.push("dispose")),
  deleteCheckpoints: vi.fn(async () => lifecycleState.calls.push("delete-checkpoints")),
}));

vi.mock("electron", () => ({ app: { getPath: () => "C:/user-data" } }));
vi.mock("../groups/group-store", () => ({
  listWorkspaceGroupMemberSessionIds: vi.fn(() => []),
}));
vi.mock("../interaction/question-broker", () => ({
  denyPendingQuestionRequestsForSession: vi.fn(() => lifecycleState.calls.push("deny-questions")),
}));
vi.mock("../memory/project-memory-service", () => ({ finalizeProjectMemoryRun: vi.fn() }));
vi.mock("../permissions/permission-broker", () => ({
  denyPendingPermissionRequestsForSession: vi.fn(() =>
    lifecycleState.calls.push("deny-permissions"),
  ),
}));
vi.mock("../plan/plan-store", () => ({
  deleteSessionPlan: vi.fn(() => lifecycleState.calls.push("delete-plan")),
}));
vi.mock("./agent-run-store", () => ({ listAgentRuns: vi.fn(() => []) }));
vi.mock("./agent-store", () => ({
  deleteAgentSession: lifecycleState.deleteSession,
  getAgentSession: vi.fn(() => {
    lifecycleState.calls.push("get-session");
    return lifecycleState.session;
  }),
  listAgentSessions: vi.fn(() => []),
  listArchivedAgentSessions: vi.fn(() => []),
  listSubagentSessions: vi.fn(() => []),
  setAgentSessionArchived: vi.fn(),
}));
vi.mock("./checkpoint-service", () => ({
  deleteSessionCheckpoints: lifecycleState.deleteCheckpoints,
}));
vi.mock("./runtime-registry", () => ({
  getAgentRuntime: () => ({ dispose: lifecycleState.dispose }),
}));
vi.mock("./harness/hyperplan-draft-store", () => ({
  clearHyperPlanDraftsForSession: lifecycleState.clearDraftsForSession,
}));

const { deleteAgentSessionTree } = await import("./session-lifecycle");

describe("session lifecycle HyperPlan cleanup", () => {
  beforeEach(() => {
    lifecycleState.calls.length = 0;
    lifecycleState.session = undefined;
    lifecycleState.dispose
      .mockReset()
      .mockImplementation(async () => lifecycleState.calls.push("dispose"));
    lifecycleState.deleteCheckpoints
      .mockReset()
      .mockImplementation(async () => lifecycleState.calls.push("delete-checkpoints"));
    lifecycleState.clearDraftsForSession.mockReset();
    lifecycleState.clearDraftsForSession.mockImplementation(() =>
      lifecycleState.calls.push("clear-drafts"),
    );
    lifecycleState.deleteSession.mockClear();
    lifecycleState.deleteSession.mockImplementation(() =>
      lifecycleState.calls.push("delete-session"),
    );
  });

  it("sweeps drafts immediately before deleting the session after plan cleanup", async () => {
    lifecycleState.session = { id: "session-1", cwd: "C:/workspace" };
    await deleteAgentSessionTree("session-1");

    expect(lifecycleState.calls).toEqual([
      "dispose",
      "get-session",
      "delete-checkpoints",
      "deny-permissions",
      "deny-questions",
      "delete-plan",
      "clear-drafts",
      "delete-session",
    ]);
    expect(lifecycleState.clearDraftsForSession).toHaveBeenCalledExactlyOnceWith("session-1");
  });

  it("continues session deletion if draft cleanup throws, like checkpoint cleanup", async () => {
    lifecycleState.clearDraftsForSession.mockImplementationOnce(() => {
      lifecycleState.calls.push("clear-drafts");
      throw new Error("cleanup failed");
    });

    await expect(deleteAgentSessionTree("session-1")).resolves.toBeUndefined();

    expect(lifecycleState.clearDraftsForSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(lifecycleState.deleteSession).toHaveBeenCalledOnce();
  });

  it("waits for in-flight teardown work before the final draft sweep", async () => {
    lifecycleState.session = { id: "session-1", cwd: "C:/workspace" };
    let finishDispose!: (count: number) => void;
    lifecycleState.dispose.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishDispose = resolve;
        }),
    );
    let finishCheckpoints!: (count: number) => void;
    lifecycleState.deleteCheckpoints.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishCheckpoints = resolve;
        }),
    );
    const deletion = deleteAgentSessionTree("session-1");
    await Promise.resolve();
    expect(lifecycleState.clearDraftsForSession).not.toHaveBeenCalled();
    lifecycleState.calls.push("draft-created-during-dispose");
    finishDispose(0);
    await Promise.resolve();
    expect(lifecycleState.clearDraftsForSession).not.toHaveBeenCalled();
    lifecycleState.calls.push("draft-created-during-checkpoint-cleanup");
    finishCheckpoints(0);
    await deletion;
    expect(lifecycleState.calls.indexOf("clear-drafts")).toBeGreaterThan(
      lifecycleState.calls.indexOf("draft-created-during-dispose"),
    );
    expect(lifecycleState.calls.indexOf("clear-drafts")).toBeGreaterThan(
      lifecycleState.calls.indexOf("draft-created-during-checkpoint-cleanup"),
    );
    expect(lifecycleState.calls.slice(-2)).toEqual(["clear-drafts", "delete-session"]);
  });
});
