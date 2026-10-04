import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, GroupRuntimeEvent } from "../../shared/contracts";
import type { PromptAgentInput, PromptTurnResult } from "../agent/runtime";

const userData = mkdtempSync(join(tmpdir(), "modus-proactivity-runtime-"));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const { getDatabase } = await import("../db/database");
const {
  createAgentGroupWithMembers,
  createGroupTask,
  assignGroupTask,
  listGroupMessages,
  removeAgentGroupMember,
  requestGroupTaskReview,
  reviewGroupTask,
} = await import("./group-store");
const {
  getGroupProactivityMode,
  setGroupProactivityMode,
  listPendingGroupActions,
  listGroupActions,
  persistGroupProactivityDecision,
} = await import("./group-proactivity-store");
const {
  listGroupTaskTransitions,
  reportGroupTaskProgress,
  bindGroupTaskRun,
  recordGroupTaskEvidence,
} = await import("./group-task-store");
const { recordAgentEvent } = await import("../agent/agent-event-store");
const { getGroupSourceFingerprint } = await import("../git/git-service");
const { getGroupTaskDetails } = await import("./group-task-details");
const { readGroupChain, persistGroupChain } = await import("./group-job-store");
const { GroupRuntime } = await import("./group-runtime");

const instances: InstanceType<typeof GroupRuntime>[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  getDatabase().prepare("delete from group_jobs").run();
  getDatabase().prepare("delete from group_proactivity_actions").run();
});
afterAll(() => {
  getDatabase().close();
  rmSync(userData, { recursive: true, force: true });
});
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test fixture value.");
  return value;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function squad(sourceDir?: string) {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
  ).run(id, sourceDir ?? id, id, now, now);
  const sessions = ["Lead", "Owner"].map((name) => {
    const sessionId = crypto.randomUUID();
    db.prepare(
      "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, 'idle', ?, ?)",
    ).run(sessionId, id, name, sourceDir ?? id, now, now);
    return sessionId;
  });
  const lead = must(sessions[0]);
  const owner = must(sessions[1]);
  const group = createAgentGroupWithMembers({
    name: id,
    workspaceId: id,
    members: sessions.map((sessionId) => ({ sessionId })),
    leadSessionId: lead,
    mode: "coordinator",
  });
  return { group, lead, owner, db };
}

function runtime(
  windowAvailable = true,
  recoverPending = false,
  onEmit?: (event: GroupRuntimeEvent, groups: InstanceType<typeof GroupRuntime>) => void,
) {
  const calls: Array<{ input: PromptAgentInput; resolve: (result: PromptTurnResult) => void }> = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const engine = {
    prompt: (_window: unknown, input: PromptAgentInput) =>
      new Promise<PromptTurnResult>((resolve) => calls.push({ input, resolve })),
    abort: async () => {},
    isSessionStreaming: () => false,
    onTurnSettled: () => () => {},
    onQuestionPending: () => () => {},
    onEvent: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  let groups!: InstanceType<typeof GroupRuntime>;
  groups = new GroupRuntime({
    runtime: engine,
    host: {
      getWindow: () => (windowAvailable ? ({} as never) : undefined),
      isUpdatePending: () => false,
      emit: (event) => onEmit?.(event, groups),
    },
    recoverPending,
  });
  instances.push(groups);
  return {
    groups,
    calls,
    emit: (event: AgentEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function persistUndeliveredAssignment(groupId: string, lead: string, owner: string) {
  setGroupProactivityMode(groupId, "opt_in_auto");
  const first = runtime(false);
  const root = first.groups.postUserMessage({ groupId, body: "work" });
  const task = createGroupTask({ groupId, title: "Task", executionId: root.id });
  first.groups.dispose();
  assignGroupTask(groupId, task.id, lead, owner);
  const transition = must(listGroupTaskTransitions(task.id).at(-1));
  const action = persistGroupProactivityDecision({
    kind: "wake_owner",
    taskId: task.id,
    targetSessionId: owner,
    sourceEventId: transition.id,
    reasonCode: "owner-ready",
    idempotencyKey: JSON.stringify([
      groupId,
      root.id,
      transition.id,
      transition.taskVersion,
      "wake_owner",
      "task_assigned",
      owner,
    ]),
  });
  return { first, root, task, action };
}

describe("task transition delivery", () => {
  it("suggest mode stores the assignment without a wake or budget charge", async () => {
    const { group, lead, owner, db } = squad();
    const env = runtime();
    expect(getGroupProactivityMode(group.id)).toBe("suggest");
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    const before = env.groups.chainSnapshot(root.id);
    assignGroupTask(group.id, task.id, lead, owner);
    await flush();
    expect(listGroupActions(group.id)).toMatchObject([
      { deliveryState: "suggested", taskId: task.id },
    ]);
    expect(
      db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
    ).toMatchObject({ n: 1 });
    expect(env.groups.chainSnapshot(root.id).wakesByMember).toEqual(before.wakesByMember);
    expect(listGroupMessages(group.id).filter((m) => m.kind === "status")).toHaveLength(0);
  });

  it("opted-in assignment dispatches once in its active chain", async () => {
    const { group, lead, owner, db } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const env = runtime(false);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    assignGroupTask(group.id, task.id, lead, owner);
    await flush();
    const [action] = listGroupActions(group.id);
    expect(action).toMatchObject({
      deliveryState: "dispatched",
      taskId: task.id,
      executionId: root.id,
    });
    expect(
      listGroupMessages(group.id).filter(
        (m) => m.id === action?.wakeMessageId && m.kind === "status",
      ),
    ).toHaveLength(1);
    expect(
      db.prepare("select count(*) as n from group_jobs where id = ?").get(must(must(action).jobId)),
    ).toMatchObject({ n: 1 });
    expect(env.groups.chainSnapshot(root.id).wakesByMember[owner]).toBe(1);
    env.groups.handleTaskTransition({
      id: must(action).sourceEventId,
      groupId: group.id,
      taskId: task.id,
      taskVersion: must(action).taskVersion,
      action: "assign",
      executionId: root.id,
      fromStatus: "open",
      toStatus: "in_progress",
      createdAt: "",
    });
    await flush();
    expect(listGroupActions(group.id)).toHaveLength(1);
  });

  it("processes a committed assignment before its otherwise idle chain retires", async () => {
    const { group, lead, owner } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const env = runtime(true);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    assignGroupTask(group.id, task.id, lead, owner);
    must(env.calls[0]).resolve({ outcome: "ok" });
    await flush();
    expect(listGroupActions(group.id)).toMatchObject([
      { taskId: task.id, deliveryState: "dispatched" },
    ]);
    expect(env.calls.some((call) => call.input.sessionId === owner)).toBe(true);
  });

  it("does not treat public Agreed or Proposed text as a task event", async () => {
    const { group, db } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const env = runtime(true);
    env.groups.postUserMessage({ groupId: group.id, body: "work" });
    must(env.calls[0]).resolve({ outcome: "ok", finalText: "Agreed. Proposed next steps." });
    await flush();
    expect(listGroupActions(group.id)).toEqual([]);
    expect(
      db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
    ).toMatchObject({ n: 1 });
  });

  it("ignores an unknown persisted task action", async () => {
    const { group, db } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const env = runtime(false);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    const id = crypto.randomUUID();
    db.prepare(`insert into group_task_events
      (id, group_id, task_id, task_version, action, execution_id, from_status, to_status, created_at)
      values (?, ?, ?, ?, 'unexpected', ?, 'open', 'open', ?)`).run(
      id,
      group.id,
      task.id,
      task.stateVersion ?? 1,
      root.id,
      new Date().toISOString(),
    );
    env.groups.handleTaskTransition({
      id,
      groupId: group.id,
      taskId: task.id,
      taskVersion: task.stateVersion ?? 1,
      action: "unexpected",
      executionId: root.id,
      fromStatus: "open",
      toStatus: "open",
      createdAt: "",
    });
    await flush();
    expect(listGroupActions(group.id)).toEqual([]);
  });

  it.each([
    "suggest",
    "opt_in_auto",
  ] as const)("an explicit task receipt wakes in %s and suppresses the controller", async (mode) => {
    const { group, lead, owner, db } = squad();
    setGroupProactivityMode(group.id, mode);
    const env = runtime(false);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    assignGroupTask(group.id, task.id, lead, owner);
    const transition = must(listGroupTaskTransitions(task.id).at(-1));
    env.groups.handleTaskWake({
      taskId: task.id,
      groupId: group.id,
      actorSessionId: lead,
      targetSessionId: owner,
      body: "Assigned",
      operationId: crypto.randomUUID(),
      sourceEventId: transition.id,
    });
    await flush();
    expect(listGroupActions(group.id)).toEqual([]);
    expect(listGroupMessages(group.id).filter((message) => message.kind === "status")).toHaveLength(
      1,
    );
    expect(
      db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
    ).toMatchObject({ n: 2 });
  });

  it.each([
    "task_unblocked",
    "review_requested",
    "review_changes_requested",
  ] as const)("maps persisted %s transition to a suggestion", async (kind) => {
    const { group, lead, owner } = squad();
    const env = runtime(false);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({
      groupId: group.id,
      title: "Task",
      ownerSessionId: owner,
      reviewerSessionId: lead,
      status: kind === "task_unblocked" ? "blocked" : "in_progress",
      executionId: root.id,
    });
    if (kind === "task_unblocked")
      reportGroupTaskProgress({
        groupId: group.id,
        taskId: task.id,
        actorSessionId: owner,
        expectedVersion: must(task.stateVersion),
        operationId: crypto.randomUUID(),
        blockedReason: null,
      });
    else if (kind === "review_requested") requestGroupTaskReview(group.id, task.id, owner, lead);
    else {
      requestGroupTaskReview(group.id, task.id, owner, lead);
      await flush();
      reviewGroupTask(group.id, task.id, lead, "changes");
    }
    await flush();
    const transition = must(listGroupTaskTransitions(task.id).at(-1));
    expect(
      listGroupActions(group.id).some(
        (action) => action.sourceEventId === transition.id && action.deliveryState === "suggested",
      ),
    ).toBe(true);
  });

  it("accepts only exact bound persisted QA evidence as a task trigger", async () => {
    const { group, lead, owner } = squad();
    const env = runtime(false);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({
      groupId: group.id,
      title: "Task",
      status: "in_review",
      ownerSessionId: owner,
      reviewerSessionId: lead,
      executionId: root.id,
      kind: "code",
      priority: "normal",
      dependencyIds: [],
      criteria: [{ id: "checks", description: "Tests pass", requiredCheckKinds: ["tests"] }],
      verificationPolicy: { mode: "required", requireReview: true },
    });
    const unrelated: AgentEvent = {
      type: "harness.qa",
      sessionId: owner,
      runId: "wrong",
      result: {
        required: true,
        status: "passed",
        reasonCode: "ok",
        sourceFingerprint: "source",
        evidence: [],
      },
    };
    const unrelatedRow = recordAgentEvent(unrelated);
    env.emit({ ...unrelated, eventCursor: unrelatedRow });
    await flush();
    expect(listGroupActions(group.id)).toEqual([]);
    const runId = crypto.randomUUID();
    bindGroupTaskRun({
      groupId: group.id,
      taskId: task.id,
      taskVersion: must(task.stateVersion),
      criteriaVersion: must(task.criteriaVersion),
      sessionId: owner,
      runId,
      executionId: root.id,
      role: "owner",
      sourceFingerprint: "source",
      expectedVersion: must(task.stateVersion),
      operationId: crypto.randomUUID(),
    });
    const qa: AgentEvent = {
      type: "harness.qa",
      sessionId: owner,
      runId,
      result: {
        required: true,
        status: "passed",
        reasonCode: "ok",
        sourceFingerprint: "source",
        evidence: [
          { id: "evidence", kind: "test", status: "passed", label: "Tests", checkName: "tests" },
        ],
      },
    };
    const rowId = recordAgentEvent(qa);
    recordGroupTaskEvidence({
      groupId: group.id,
      taskId: task.id,
      actorSessionId: owner,
      expectedVersion: must(task.stateVersion),
      operationId: `qa:${rowId}`,
      evidenceRefs: [
        {
          criterionId: "checks",
          checkName: "tests",
          criteriaVersion: must(task.criteriaVersion),
          sessionId: owner,
          runId,
          eventRowId: rowId,
          evidenceId: "evidence",
          sourceFingerprint: "source",
        },
      ],
    });
    env.emit({ ...qa, eventCursor: rowId });
    await flush();
    const transition = must(listGroupTaskTransitions(task.id).at(-1));
    expect(listGroupActions(group.id)).toMatchObject([
      { sourceEventId: transition.id, deliveryState: "suggested" },
    ]);
  });

  it("a late assignment cannot open a retired chain", async () => {
    const { group, lead, owner, db } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const env = runtime(true);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    must(env.calls[0]).resolve({ outcome: "ok" });
    await flush();
    env.groups.dispose();
    assignGroupTask(group.id, task.id, lead, owner);
    await flush();
    const recovered = runtime(false, true);
    expect(recovered.groups.liveChainIds()).not.toContain(root.id);
    expect(listPendingGroupActions(group.id)).toEqual([]);
    expect(
      db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
    ).toMatchObject({ n: 1 });
  });

  it("an explicit user resume clears idle retirement for its original chain", async () => {
    const { group, db } = squad();
    const env = runtime(true);
    const root = env.groups.postUserMessage({ groupId: group.id, body: "work" });
    const job = db.prepare("select id from group_jobs where group_id = ?").get(group.id) as {
      id: string;
    };
    must(env.calls[0]).resolve({ outcome: "failed", error: "interrupted" });
    await flush();
    expect(env.groups.chainSnapshot(root.id).retired).toBe(true);
    env.groups.resumeExecution({ groupId: group.id, executionId: job.id });
    expect(env.groups.chainSnapshot(root.id).retired).not.toBe(true);
  });

  it("recovers an outbox decision persisted before message and job materialization", async () => {
    const { group, lead, owner, db } = squad();
    const { root, action } = persistUndeliveredAssignment(group.id, lead, owner);
    expect(listPendingGroupActions(group.id)).toEqual([action]);
    const recovered = runtime(false, true);
    await flush();
    const [delivered] = listGroupActions(group.id);
    expect(delivered).toMatchObject({ id: action.id, deliveryState: "dispatched" });
    expect(
      db
        .prepare("select count(*) as n from group_jobs where id = ?")
        .get(must(must(delivered).jobId)),
    ).toMatchObject({ n: 1 });
    expect(
      listGroupMessages(group.id).filter((message) => message.id === must(delivered).wakeMessageId),
    ).toHaveLength(1);
    expect(recovered.groups.chainSnapshot(root.id).wakesByMember[owner]).toBe(1);
    recovered.groups.dispose();
    const twice = runtime(false, true);
    await flush();
    expect(listGroupActions(group.id)).toEqual([delivered]);
    expect(twice.groups.chainSnapshot(root.id).wakesByMember[owner]).toBe(1);
  });

  it("preserves a pending action when recovery itself is interrupted", async () => {
    const { group, lead, owner } = squad();
    const { action } = persistUndeliveredAssignment(group.id, lead, owner);
    const interrupted = runtime(false, true);
    interrupted.groups.dispose();
    await flush();
    expect(listPendingGroupActions(group.id)).toMatchObject([
      { id: action.id, deliveryState: "pending" },
    ]);
    const recovered = runtime(false, true);
    await flush();
    expect(listGroupActions(group.id)).toMatchObject([
      { id: action.id, deliveryState: "dispatched" },
    ]);
    recovered.groups.dispose();
  });

  it("does not revive an action when its group is removed during recovery", async () => {
    const { group, lead, owner, db } = squad();
    persistUndeliveredAssignment(group.id, lead, owner);
    const recovered = runtime(false, true);
    db.prepare("delete from agent_groups where id = ?").run(group.id);
    await flush();
    expect(listGroupActions(group.id)).toEqual([]);
    recovered.groups.dispose();
  });

  it("recovers the same durable job after message and job commit before pump", async () => {
    const { group, lead, owner, db } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const first = runtime(true, false, (event, groups) => {
      if (
        event.type === "group.message" &&
        event.message.kind === "status" &&
        event.message.body.startsWith("Task work ready:")
      )
        groups.dispose();
    });
    const root = first.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    assignGroupTask(group.id, task.id, lead, owner);
    await flush();
    const [before] = listGroupActions(group.id);
    expect(before?.deliveryState).toBe("dispatched");
    expect(first.calls.some((call) => call.input.sessionId === owner)).toBe(false);
    const recovered = runtime(true, true);
    recovered.groups.kick();
    expect(recovered.calls.some((call) => call.input.sessionId === owner)).toBe(true);
    expect(listGroupActions(group.id)).toEqual([before]);
    expect(
      db.prepare("select count(*) as n from group_jobs where id = ?").get(must(must(before).jobId)),
    ).toMatchObject({ n: 1 });
    expect(
      listGroupMessages(group.id).filter((message) => message.id === must(before).wakeMessageId),
    ).toHaveLength(1);
  });

  it("does not recreate a job that started before crash", async () => {
    const { group, lead, owner, db } = squad();
    setGroupProactivityMode(group.id, "opt_in_auto");
    const first = runtime(true);
    const root = first.groups.postUserMessage({ groupId: group.id, body: "work" });
    const task = createGroupTask({ groupId: group.id, title: "Task", executionId: root.id });
    assignGroupTask(group.id, task.id, lead, owner);
    await flush();
    const [before] = listGroupActions(group.id);
    expect(first.calls.some((call) => call.input.sessionId === owner)).toBe(true);
    first.groups.dispose();
    const recovered = runtime(true, true);
    await flush();
    expect(listGroupActions(group.id)).toEqual([before]);
    expect(
      db.prepare("select count(*) as n from group_jobs where id = ?").get(must(must(before).jobId)),
    ).toMatchObject({ n: 1 });
    expect(recovered.calls.filter((call) => call.input.sessionId === owner)).toHaveLength(0);
  });

  it.each([
    "stopped",
    "removed",
    "archived",
    "task-version",
    "budget",
    "dependency",
  ] as const)("invalidates pending delivery when %s changes", async (change) => {
    const { group, lead, owner, db } = squad();
    const { root, task, action } = persistUndeliveredAssignment(group.id, lead, owner);
    if (change === "stopped") {
      const chain = must(readGroupChain(root.id));
      chain.ended = "stopped";
      persistGroupChain(chain);
    } else if (change === "removed") {
      removeAgentGroupMember(group.id, owner);
    } else if (change === "archived") {
      db.prepare(
        "update agents set archived_at = ? where id = (select agent_id from agent_group_members where group_id = ? and session_id = ?)",
      ).run(new Date().toISOString(), group.id, owner);
    } else if (change === "task-version") {
      db.prepare("update group_tasks set state_version = state_version + 1 where id = ?").run(
        task.id,
      );
    } else if (change === "budget") {
      const chain = must(readGroupChain(root.id));
      chain.wakesByMember.set(owner, 3);
      persistGroupChain(chain);
    } else {
      db.prepare("update group_tasks set dependency_ids_json = ? where id = ?").run(
        JSON.stringify([task.id]),
        task.id,
      );
    }
    const recovered = runtime(false, true);
    await flush();
    expect(listGroupActions(group.id)).toMatchObject([
      { id: action.id, deliveryState: "invalidated" },
    ]);
    expect(listGroupMessages(group.id).filter((message) => message.kind === "status")).toHaveLength(
      0,
    );
    expect(
      db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
    ).toMatchObject({ n: 1 });
    recovered.groups.dispose();
  });

  it("Stop invalidates an undelivered action even when no runtime job is loaded", () => {
    const { group, lead, owner } = squad();
    const { action } = persistUndeliveredAssignment(group.id, lead, owner);
    const stopped = runtime(false);
    stopped.groups.stopGroup(group.id);
    expect(listGroupActions(group.id)).toMatchObject([
      { id: action.id, deliveryState: "invalidated" },
    ]);
  });

  it("invalidates a pending reviewer wake when its exact QA source becomes stale", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "modus-proactivity-qa-"));
    try {
      execFileSync("git", ["init", "-q", sourceDir]);
      execFileSync("git", ["-C", sourceDir, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", sourceDir, "config", "user.name", "Test"]);
      writeFileSync(join(sourceDir, "source.txt"), "first\n");
      execFileSync("git", ["-C", sourceDir, "add", "source.txt"]);
      execFileSync("git", ["-C", sourceDir, "commit", "-qm", "source"]);
      const { group, lead, owner, db } = squad(sourceDir);
      setGroupProactivityMode(group.id, "opt_in_auto");
      const first = runtime(false);
      const root = first.groups.postUserMessage({ groupId: group.id, body: "work" });
      first.groups.dispose();
      const task = createGroupTask({
        groupId: group.id,
        title: "Task",
        status: "in_progress",
        ownerSessionId: owner,
        reviewerSessionId: lead,
        executionId: root.id,
        kind: "code",
        priority: "normal",
        dependencyIds: [],
        criteria: [{ id: "checks", description: "Tests pass", requiredCheckKinds: ["tests"] }],
        verificationPolicy: { mode: "required", requireReview: true },
      });
      const sourceFingerprint = await getGroupSourceFingerprint(sourceDir);
      const runId = crypto.randomUUID();
      bindGroupTaskRun({
        groupId: group.id,
        taskId: task.id,
        taskVersion: must(task.stateVersion),
        criteriaVersion: must(task.criteriaVersion),
        sessionId: owner,
        runId,
        executionId: root.id,
        role: "owner",
        sourceFingerprint,
        expectedVersion: must(task.stateVersion),
        operationId: crypto.randomUUID(),
      });
      const qa: AgentEvent = {
        type: "harness.qa",
        sessionId: owner,
        runId,
        result: {
          required: true,
          status: "passed",
          reasonCode: "ok",
          sourceFingerprint,
          evidence: [
            { id: "evidence", kind: "test", status: "passed", label: "Tests", checkName: "tests" },
          ],
        },
      };
      const rowId = recordAgentEvent(qa);
      const evidenced = recordGroupTaskEvidence({
        groupId: group.id,
        taskId: task.id,
        actorSessionId: owner,
        expectedVersion: must(task.stateVersion),
        operationId: `qa:${rowId}`,
        evidenceRefs: [
          {
            criterionId: "checks",
            checkName: "tests",
            criteriaVersion: must(task.criteriaVersion),
            sessionId: owner,
            runId,
            eventRowId: rowId,
            evidenceId: "evidence",
            sourceFingerprint,
          },
        ],
      });
      requestGroupTaskReview(group.id, task.id, owner, lead);
      const transition = must(listGroupTaskTransitions(task.id).at(-1));
      const before = await getGroupTaskDetails(group.id, task.id);
      expect(before.criteria[0]?.status).toBe("passed");
      expect(before.review.status).toBe("pending");
      const action = persistGroupProactivityDecision({
        kind: "wake_reviewer",
        taskId: task.id,
        targetSessionId: lead,
        sourceEventId: transition.id,
        reasonCode: "review-ready",
        idempotencyKey: JSON.stringify([
          group.id,
          root.id,
          transition.id,
          transition.taskVersion,
          "wake_reviewer",
          "review_requested",
          lead,
        ]),
      });
      expect(action.deliveryState).toBe("pending");
      writeFileSync(join(sourceDir, "source.txt"), "changed\n");
      const recovered = runtime(false, true);
      await vi.waitFor(() =>
        expect(listGroupActions(group.id)[0]?.deliveryState).toBe("invalidated"),
      );
      expect(listGroupActions(group.id)).toMatchObject([
        { id: action.id, deliveryState: "invalidated" },
      ]);
      expect(
        db.prepare("select count(*) as n from group_jobs where group_id = ?").get(group.id),
      ).toMatchObject({ n: 1 });
      expect(
        listGroupMessages(group.id).filter((message) => message.kind === "status"),
      ).toHaveLength(0);
      expect(evidenced.stateVersion).toBeGreaterThan(must(task.stateVersion));
      recovered.groups.dispose();
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
