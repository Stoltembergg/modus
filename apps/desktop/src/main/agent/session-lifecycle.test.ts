import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleState = vi.hoisted(() => ({
  calls: [] as string[],
  session: undefined as { id: string; cwd: string; piSessionId?: string; piSessionFile?: string } | undefined,
  cleanupPiFile: vi.fn<(...args: unknown[]) => "deleted" | "preserved" | "failed">(() => {
    lifecycleState.calls.push("cleanup-pi-file");
    return "preserved";
  }),
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
vi.mock("./pi-session-file-cleanup", () => ({
  deleteOwnedPiSessionFile: lifecycleState.cleanupPiFile,
}));
vi.mock("./runtime-registry", () => ({
  getAgentRuntime: () => ({ dispose: lifecycleState.dispose }),
}));
vi.mock("./harness/plan-build-store", () => ({
  clearPlanBuildStateForSession: lifecycleState.clearDraftsForSession,
}));

const { deleteAgentSessionTree } = await import("./session-lifecycle");
const { getAgentSession, listSubagentSessions } = await import("./agent-store");

describe("session lifecycle PlanBuild cleanup", () => {
  beforeEach(() => {
    lifecycleState.calls.length = 0;
    lifecycleState.session = undefined;
    vi.mocked(getAgentSession).mockReset().mockImplementation(() => {
      lifecycleState.calls.push("get-session");
      return lifecycleState.session as ReturnType<typeof getAgentSession>;
    });
    vi.mocked(listSubagentSessions).mockReset().mockReturnValue([]);
    lifecycleState.cleanupPiFile.mockReset().mockImplementation(() => {
      lifecycleState.calls.push("cleanup-pi-file");
      return "preserved";
    });
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
      "get-session",
      "cleanup-pi-file",
      "delete-session",
    ]);
    expect(lifecycleState.clearDraftsForSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(lifecycleState.cleanupPiFile).toHaveBeenCalledExactlyOnceWith(lifecycleState.session);
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
    expect(lifecycleState.calls.slice(-4)).toEqual(["clear-drafts", "get-session", "cleanup-pi-file", "delete-session"]);
  });

  it("logs only a generic warning and deletes the record when file cleanup fails", async () => {
    lifecycleState.session = { id: "session-1", cwd: "/secret/workspace", piSessionFile: "/secret/file.jsonl" };
    lifecycleState.cleanupPiFile.mockReturnValue("failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(deleteAgentSessionTree("session-1")).resolves.toBeUndefined();
      expect(lifecycleState.deleteSession).toHaveBeenCalledExactlyOnceWith("session-1");
      expect(warn.mock.calls).toEqual([["[modus] Pi session file cleanup failed."]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("cleans a child before its record, then the parent before its record", async () => {
    vi.mocked(listSubagentSessions).mockImplementation((id) =>
      id === "parent" ? [{ id: "child" } as ReturnType<typeof getAgentSession> & {}] : [],
    );
    vi.mocked(getAgentSession).mockImplementation((id) =>
      ({ id, cwd: "/temporary-workspace" }) as ReturnType<typeof getAgentSession>,
    );
    lifecycleState.dispose.mockImplementation(async (id?: string) => {
      lifecycleState.calls.push(`dispose:${id}`);
      return 0;
    });
    lifecycleState.cleanupPiFile.mockImplementation((input) => {
      lifecycleState.calls.push(`cleanup:${(input as { id: string }).id}`);
      return "preserved";
    });
    lifecycleState.deleteSession.mockImplementation((id?: string) =>
      lifecycleState.calls.push(`delete:${id}`),
    );
    await deleteAgentSessionTree("parent");
    expect(lifecycleState.calls.filter((call) => /^(dispose:|cleanup:|delete:)/.test(call))).toEqual([
      "dispose:child", "cleanup:child", "delete:child",
      "dispose:parent", "cleanup:parent", "delete:parent",
    ]);
  });

  it("uses ownership metadata refreshed after asynchronous checkpoint teardown", async () => {
    lifecycleState.session = { id: "session-1", cwd: "/temporary-workspace", piSessionId: "old" };
    lifecycleState.deleteCheckpoints.mockImplementationOnce(async () => {
      lifecycleState.session = { ...lifecycleState.session!, piSessionId: "new" };
      return 0;
    });
    await deleteAgentSessionTree("session-1");
    expect(lifecycleState.cleanupPiFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ piSessionId: "new" }),
    );
  });

  it("does not attempt file cleanup when the session no longer exists", async () => {
    await deleteAgentSessionTree("missing");
    expect(lifecycleState.cleanupPiFile).not.toHaveBeenCalled();
    expect(lifecycleState.deleteSession).toHaveBeenCalledExactlyOnceWith("missing");
  });
});
