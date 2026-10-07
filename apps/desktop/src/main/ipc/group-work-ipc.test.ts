import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupSuggestion, GroupTaskQueueItem } from "../../shared/group-work-state";
import { IPC_CHANNELS } from "./channels";
import type { GroupWorkIpcService } from "./group-work-ipc";
import type { TrustedSenderEvent } from "./trusted-sender";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/modus-group-work-ipc-test" },
  BrowserWindow: { getAllWindows: () => [] },
}));

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

function setup(overrides: Partial<GroupWorkIpcService> = {}) {
  const workState = { groupId: "g-1", tasks: [], gates: {}, members: [], omitted: {}, budgets: {} };
  const details = {
    task: { id: "t-1", groupId: "g-1", stateVersion: 4 },
    dependencies: [],
    source: { availability: "available" },
    criteria: [],
  };
  const transition = {
    id: "e-1",
    groupId: "g-1",
    taskId: "t-1",
    taskVersion: 4,
    action: "update",
    fromStatus: "open",
    toStatus: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const service: GroupWorkIpcService = {
    getGroupTaskQueueSnapshot: vi.fn((_groupId: string): GroupTaskQueueItem[] => [
      {
        taskId: "t-1",
        taskTitle: "Parser",
        state: "queued",
        sessionId: "s-owner",
        memberName: "Builder",
        jobId: "job-1",
        position: 2,
      },
    ]),
    getGroupWorkState: vi.fn(() => workState as never),
    getGroupTaskDetails: vi.fn(async (groupId, taskId) => {
      if (groupId !== "g-1" || taskId !== "t-1")
        throw new Error("Task not found in another group.");
      return details as never;
    }),
    listGroupTaskTransitions: vi.fn(() => [transition] as never),
    updateGroupTaskDraft: vi.fn(() => ({ id: "t-1", groupId: "g-1", stateVersion: 5 }) as never),
    getGroupProactivityMode: vi.fn(() => "suggest" as const),
    setGroupProactivityMode: vi.fn((_groupId, mode) => mode),
    listGroupSuggestions: vi.fn(() => [suggestion] as never),
    resolveGroupSuggestion: vi.fn(async (input) => ({
      actionId: suggestion.actionId,
      groupId: "g-1",
      taskId: "t-1",
      sourceEventId: "e-1",
      deliveryState: input.decision === "accept" ? ("dispatched" as const) : ("discarded" as const),
      version: suggestion.version + 1,
    })),
    ...overrides,
  };
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  const assertTrustedSender = vi.fn((event: TrustedSenderEvent) => {
    if (!(event as unknown as { trusted?: boolean }).trusted) {
      throw new Error("Blocked IPC call from untrusted renderer frame.");
    }
  });
  return { service, handlers, ipcMain, assertTrustedSender };
}

const trusted = { trusted: true } as unknown as TrustedSenderEvent;
const untrusted = { trusted: false } as unknown as TrustedSenderEvent;
const draft = {
  title: "Parser",
  description: "Keep the parser stable.",
  kind: "code",
  priority: "high",
  dependencyIds: [],
  criteria: [{ id: "unit", description: "Unit tests pass", requiredCheckKinds: ["tests"] }],
  verificationPolicy: { mode: "required", requireReview: true },
  reviewerSessionId: "s-reviewer",
};

const suggestion: GroupSuggestion = {
  actionId: "a-1",
  version: 3,
  state: "suggested",
  task: { id: "t-1", title: "Parser", stateVersion: 4 },
  source: { eventId: "e-1", kind: "task_assigned", sequence: 17, executionId: "x-1" },
  reasonCode: "actionable-task-event",
  reason: "This task is ready for the assigned owner.",
  proposedTargetSessionId: "s-owner",
  candidateSessionIds: ["s-owner", "s-reviewer"],
  startNewExecution: false,
};

async function register(setupResult = setup()) {
  const { registerGroupWorkIpcHandlers } = await import("./group-work-ipc");
  registerGroupWorkIpcHandlers(
    setupResult.ipcMain,
    setupResult.assertTrustedSender,
    setupResult.service,
  );
  return setupResult;
}

describe("group work IPC", () => {
  afterEach(() => vi.restoreAllMocks());

  it("registers the trusted read and draft channels", async () => {
    const result = await register();
    expect([...result.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.groupGetTaskDetails,
        IPC_CHANNELS.groupGetWorkState,
        "group:get-task-queue-snapshot",
        IPC_CHANNELS.groupListTaskTransitions,
        IPC_CHANNELS.groupUpdateTask,
        IPC_CHANNELS.groupGetProactivityMode,
        IPC_CHANNELS.groupSetProactivityMode,
        IPC_CHANNELS.groupListSuggestions,
        IPC_CHANNELS.groupResolveSuggestion,
      ].sort(),
    );
  });

  it("asserts the trusted sender before touching every service method", async () => {
    const result = await register();
    const methods = [
      result.service.getGroupTaskQueueSnapshot,
      result.service.getGroupWorkState,
      result.service.getGroupTaskDetails,
      result.service.listGroupTaskTransitions,
      result.service.updateGroupTaskDraft,
      result.service.getGroupProactivityMode,
      result.service.setGroupProactivityMode,
      result.service.listGroupSuggestions,
      result.service.resolveGroupSuggestion,
    ];
    for (const handler of result.handlers.values()) {
      expect(() => handler(untrusted, undefined)).toThrow("Blocked IPC call");
      expect(result.assertTrustedSender).toHaveBeenCalledWith(untrusted);
      for (const method of methods) expect(method).not.toHaveBeenCalled();
    }
  });

  it("uses strict payloads and never accepts renderer QA, ownership, status, or operation claims", async () => {
    const { handlers, service } = await register();
    const update = handlers.get(IPC_CHANNELS.groupUpdateTask);
    expect(() =>
      update?.(trusted, { taskId: "t-1", draft, expectedVersion: 4, extra: true }),
    ).toThrow(/Invalid IPC payload/);
    for (const forbidden of [
      { ownerSessionId: "s-owner" },
      { evidenceRefs: [] },
      { evidenceStatus: "passed" },
      { review: { verdict: "approve" } },
      { status: "done" },
      { operationId: "renderer-id" },
      { sourceEventId: "renderer-event" },
    ]) {
      expect(() =>
        update?.(trusted, {
          taskId: "t-1",
          draft: { ...draft, ...forbidden },
          expectedVersion: 4,
        }),
      ).toThrow(/Invalid IPC payload/);
    }
    expect(service.updateGroupTaskDraft).not.toHaveBeenCalled();
  });

  it("keeps work state and transitions read-only and enforces task group scope", async () => {
    const { handlers, service } = await register();
    expect(
      handlers.get(IPC_CHANNELS.groupGetWorkState)?.(trusted, {
        groupId: "g-1",
        executionId: "run-1",
      }),
    ).toEqual({ groupId: "g-1", tasks: [], gates: {}, members: [], omitted: {}, budgets: {} });
    expect(service.getGroupWorkState).toHaveBeenCalledWith("g-1", "run-1");
    await expect(
      handlers.get(IPC_CHANNELS.groupGetTaskDetails)?.(trusted, {
        groupId: "g-2",
        taskId: "t-1",
      }),
    ).rejects.toThrow(/another group|not found/i);
    expect(service.getGroupTaskDetails).toHaveBeenCalledWith("g-2", "t-1");
    expect(
      handlers.get(IPC_CHANNELS.groupListTaskTransitions)?.(trusted, { taskId: "t-1" }),
    ).toEqual([expect.objectContaining({ taskVersion: 4 })]);
    expect(service.updateGroupTaskDraft).not.toHaveBeenCalled();
  });

  it("returns only the task queue projection through a strict group-scoped payload", async () => {
    const { handlers, service } = await register();
    const handler = handlers.get("group:get-task-queue-snapshot");
    expect(handler?.(trusted, { groupId: "g-1" })).toEqual([
      {
        taskId: "t-1",
        taskTitle: "Parser",
        state: "queued",
        sessionId: "s-owner",
        memberName: "Builder",
        jobId: "job-1",
        position: 2,
      },
    ]);
    expect(service.getGroupTaskQueueSnapshot).toHaveBeenCalledWith("g-1");
    expect(() => handler?.(trusted, { groupId: "g-1", prompt: "must not be accepted" })).toThrow(
      /Invalid IPC payload/,
    );
    expect(service.getGroupTaskQueueSnapshot).toHaveBeenCalledTimes(1);
  });

  it("converts rejected detail resolver errors and leaves unknown errors intact", async () => {
    const staleTaskError = Object.assign(new Error("Task changed while details were loading."), {
      name: "GroupStoreError",
      code: "stale-task",
    });
    const stale = await register(
      setup({
        getGroupTaskDetails: vi.fn(async () => {
          throw staleTaskError;
        }),
      }),
    );
    const detailsHandler = stale.handlers.get(IPC_CHANNELS.groupGetTaskDetails);
    await expect(detailsHandler?.(trusted, { groupId: "g-1", taskId: "t-1" })).rejects.toThrow(
      "[group-error:stale-task] Task changed while details were loading.",
    );

    const unknownError = new Error("Unrecognized resolver failure.");
    const unknown = await register(
      setup({
        getGroupTaskDetails: vi.fn(async () => {
          throw unknownError;
        }),
      }),
    );
    await expect(
      unknown.handlers.get(IPC_CHANNELS.groupGetTaskDetails)?.(trusted, {
        groupId: "g-1",
        taskId: "t-1",
      }),
    ).rejects.toBe(unknownError);
  });

  it("still converts synchronous GroupStoreError throws", async () => {
    const staleTaskError = Object.assign(new Error("Synchronous store error."), {
      name: "GroupStoreError",
      code: "stale-task",
    });
    const { handlers } = await register(
      setup({
        getGroupWorkState: vi.fn(() => {
          throw staleTaskError;
        }),
      }),
    );
    expect(() =>
      handlers.get(IPC_CHANNELS.groupGetWorkState)?.(trusted, { groupId: "g-1" }),
    ).toThrow("[group-error:stale-task] Synchronous store error.");
  });

  it("passes the expected version to the authoritative draft updater", async () => {
    const { handlers, service } = await register();
    expect(
      handlers.get(IPC_CHANNELS.groupUpdateTask)?.(trusted, {
        taskId: "t-1",
        draft,
        expectedVersion: 4,
      }),
    ).toMatchObject({ stateVersion: 5 });
    expect(service.updateGroupTaskDraft).toHaveBeenCalledWith("t-1", draft, 4);
  });

  it("uses strict trusted mode and suggestion payloads and returns safe persisted data", async () => {
    const { handlers, service } = await register();
    expect(handlers.get(IPC_CHANNELS.groupGetProactivityMode)?.(trusted, { groupId: "g-1" })).toBe(
      "suggest",
    );
    expect(
      handlers.get(IPC_CHANNELS.groupSetProactivityMode)?.(trusted, {
        groupId: "g-1",
        mode: "opt_in_auto",
      }),
    ).toBe("opt_in_auto");
    expect(handlers.get(IPC_CHANNELS.groupListSuggestions)?.(trusted, { groupId: "g-1" })).toEqual([
      suggestion,
    ]);
    expect(service.setGroupProactivityMode).toHaveBeenCalledWith("g-1", "opt_in_auto");
    expect(service.listGroupSuggestions).toHaveBeenCalledWith("g-1");

    const resolve = handlers.get(IPC_CHANNELS.groupResolveSuggestion);
    await expect(
      resolve?.(trusted, {
        actionId: "a-1",
        decision: "accept",
        expectedVersion: 3,
        targetSessionId: "s-owner",
      }),
    ).resolves.toMatchObject({ actionId: "a-1", deliveryState: "dispatched" });
    for (const input of [
      { groupId: "g-1", extra: true },
      { groupId: "g-1", mode: "suggest", sourceEventId: "forged" },
      { actionId: "a-1", decision: "accept", expectedVersion: 3, reasonCode: "passed" },
      { actionId: "a-1", decision: "accept", expectedVersion: 3, operationId: "renderer-id" },
      { actionId: "a-1", decision: "accept", expectedVersion: 3, qaOutcome: "passed" },
    ]) {
      expect(() => resolve?.(trusted, input)).toThrow(/Invalid IPC payload/);
    }
    expect(service.resolveGroupSuggestion).toHaveBeenCalledWith({
      actionId: "a-1",
      decision: "accept",
      expectedVersion: 3,
      targetSessionId: "s-owner",
    });
  });

  it("asserts trusted sender before proactivity services and preserves typed stale errors", async () => {
    const result = await register();
    const handlers = [
      IPC_CHANNELS.groupGetProactivityMode,
      IPC_CHANNELS.groupSetProactivityMode,
      IPC_CHANNELS.groupListSuggestions,
      IPC_CHANNELS.groupResolveSuggestion,
    ].map((channel) => result.handlers.get(channel));
    for (const handler of handlers) {
      expect(() => handler?.(untrusted, {})).toThrow("Blocked IPC call");
    }
    expect(result.service.getGroupProactivityMode).not.toHaveBeenCalled();
    expect(result.service.setGroupProactivityMode).not.toHaveBeenCalled();
    expect(result.service.listGroupSuggestions).not.toHaveBeenCalled();
    expect(result.service.resolveGroupSuggestion).not.toHaveBeenCalled();

    const stale = await register(
      setup({
        resolveGroupSuggestion: vi.fn(async () => {
          throw Object.assign(new Error("Suggestion changed."), {
            name: "GroupStoreError",
            code: "stale-task",
          });
        }),
      }),
    );
    await expect(
      stale.handlers.get(IPC_CHANNELS.groupResolveSuggestion)?.(trusted, {
        actionId: "a-1",
        decision: "discard",
        expectedVersion: 3,
      }),
    ).rejects.toThrow("[group-error:stale-task] Suggestion changed.");
  });

  it("cancel_is_user_only", async () => {
    const { handlers, service } = await register();
    expect(() =>
      handlers.get(IPC_CHANNELS.groupUpdateTask)?.(trusted, {
        taskId: "t-1",
        draft: { ...draft, status: "cancelled" },
        expectedVersion: 4,
      }),
    ).toThrow(/Invalid IPC payload/);
    expect(service.updateGroupTaskDraft).not.toHaveBeenCalled();
  });
});
