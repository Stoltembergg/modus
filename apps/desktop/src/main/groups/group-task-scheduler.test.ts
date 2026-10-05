import { describe, expect, it } from "vitest";
import type { AgentGroupMember, GroupTask } from "../../shared/contracts";
import type { GroupWorkState } from "../../shared/group-work-state";
import { selectReadyGroupTasks } from "./group-task-scheduler";

const now = Date.UTC(2026, 9, 5, 12);

const task = (id: string, input: Partial<GroupTask> = {}): GroupTask => ({
  id,
  groupId: "g",
  title: id,
  kind: "code",
  priority: "normal",
  status: "open",
  dependencyIds: [],
  createdAt: new Date(now - 30 * 24 * 60 * 60 * 1_000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  ...input,
});

const member = (sessionId: string, input: Partial<AgentGroupMember> = {}): AgentGroupMember => ({
  sessionId,
  groupId: "g",
  agentId: sessionId,
  name: sessionId,
  agentRole: "",
  joinedAt: "now",
  capabilityIds: ["implement"],
  supportedTaskKinds: ["code"],
  ...input,
});

const workState = (tasks: GroupTask[], members: AgentGroupMember[]): GroupWorkState => ({
  groupId: "g",
  tasks,
  members,
  gates: {},
  omitted: { tasks: 0, members: 0, criteria: 0 },
  budgets: { remainingAgentMessages: 10, remainingMemberWakes: 10, remainingInputTokens: 10_000 },
});

function schedule(
  tasks: GroupTask[],
  readiness: Record<string, number>,
  options: {
    stateTasks?: GroupTask[];
    members?: AgentGroupMember[];
    pending?: Record<string, number>;
    queueCapacity?: number;
    at?: number;
  } = {},
) {
  return selectReadyGroupTasks({
    tasks,
    workState: workState(
      options.stateTasks ?? tasks,
      options.members ?? [member("a"), member("b")],
    ),
    readiness: Object.fromEntries(
      Object.entries(readiness).map(([id, readySince]) => [
        id,
        { fingerprint: `ready:${id}`, readySince },
      ]),
    ),
    now: options.at ?? now,
    pendingTaskJobsByMember: options.pending ?? {},
    queueCapacity: options.queueCapacity ?? 3,
  });
}

describe("selectReadyGroupTasks", () => {
  it("selects only open, unowned, unblocked tasks whose dependencies are done", () => {
    const tasks = [
      task("ready", { dependencyIds: ["done-dependency"] }),
      task("blocked", { dependencyIds: ["unfinished-dependency"] }),
      task("blocked-status", { status: "blocked" }),
      task("done", { status: "done" }),
      task("cancelled", { status: "cancelled" }),
      task("owned", { ownerSessionId: "a" }),
      task("reason-blocked", { blockedReason: "waiting" }),
    ];

    expect(
      schedule(
        tasks,
        { ready: now },
        {
          stateTasks: [...tasks, task("done-dependency", { status: "done" })],
        },
      ).map((candidate) => candidate.taskId),
    ).toEqual(["ready"]);
  });

  it("checks dependencies from the complete task input when the work-state snapshot omits them", () => {
    const ready = task("ready", { dependencyIds: ["completed"] });
    const completed = task("completed", { status: "done" });

    expect(schedule([ready, completed], { ready: now }, { stateTasks: [ready] })[0]).toMatchObject({
      taskId: "ready",
      targets: ["a", "b"],
      selection: "automatic-eligible",
    });
  });

  it("orders by effective priority and ages from the current ready interval", () => {
    const tasks = [
      task("low-fresh", { priority: "low", createdAt: "2000-01-01T00:00:00.000Z" }),
      task("normal-aged", { priority: "normal" }),
      task("high-aged", { priority: "high" }),
      task("low-aged", { priority: "low" }),
    ];

    const result = schedule(tasks, {
      "low-fresh": now,
      "normal-aged": now - 24 * 60 * 60 * 1_000,
      "high-aged": now - 48 * 60 * 60 * 1_000,
      "low-aged": now - 48 * 60 * 60 * 1_000,
    });

    expect(result.map(({ taskId, effectivePriority }) => [taskId, effectivePriority])).toEqual([
      ["high-aged", "high"],
      ["low-aged", "high"],
      ["normal-aged", "high"],
      ["low-fresh", "low"],
    ]);
  });

  it("uses 24-hour whole intervals and deterministic ready-time and task-id tie breaks", () => {
    const tasks = [
      task("z", { priority: "low" }),
      task("a", { priority: "low" }),
      task("older-ready", { priority: "low" }),
      task("just-under", { priority: "low" }),
    ];
    const result = schedule(tasks, {
      z: now - 24 * 60 * 60 * 1_000,
      a: now - 24 * 60 * 60 * 1_000,
      "older-ready": now - 24 * 60 * 60 * 1_000 - 1,
      "just-under": now - 24 * 60 * 60 * 1_000 + 1,
    });

    expect(result.map((candidate) => candidate.taskId)).toEqual([
      "older-ready",
      "a",
      "z",
      "just-under",
    ]);
    expect(result[0]?.effectivePriority).toBe("normal");
    expect(result[1]?.effectivePriority).toBe("normal");
    expect(result[2]?.effectivePriority).toBe("normal");
    expect(result[3]?.effectivePriority).toBe("low");
  });

  it("orders compatible targets by pending queue depth, task load, then session id", () => {
    const targetMembers = [member("z"), member("b"), member("a")];
    const inProgressLoad = [
      task("current-b", { status: "in_progress", ownerSessionId: "b" }),
      task("current-a", { status: "in_progress", ownerSessionId: "a" }),
      task("current-a-2", { status: "in_progress", ownerSessionId: "a" }),
    ];
    const candidate = schedule(
      [task("ready")],
      { ready: now },
      {
        members: targetMembers,
        stateTasks: [task("ready"), ...inProgressLoad],
        pending: { a: 1, b: 1, z: 0 },
      },
    )[0];

    expect(candidate?.targets).toEqual(["z", "b", "a"]);
    expect(
      schedule([task("ready")], { ready: now }, { members: [member("b"), member("a")] })[0]
        ?.targets,
    ).toEqual(["a", "b"]);
  });

  it("keeps full-queue targets out of the compatible list and retains a suggestion candidate", () => {
    const result = schedule(
      [task("ready")],
      { ready: now },
      {
        pending: { a: 3, b: 3 },
        queueCapacity: 3,
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      taskId: "ready",
      targets: [],
      selection: "suggestion-only",
      reason: "no-eligible-lead",
    });
  });

  it("requires typed task metadata and a reliable compatible route for automatic eligibility", () => {
    const reliable = schedule([task("typed")], { typed: now })[0];
    const legacy = schedule([task("legacy", { kind: "legacy" })], { legacy: now })[0];
    const unconfigured = schedule(
      [task("unconfigured")],
      { unconfigured: now },
      {
        members: [member("a", { capabilityIds: [], supportedTaskKinds: [] })],
      },
    )[0];

    expect(reliable).toMatchObject({ selection: "automatic-eligible", targets: ["a", "b"] });
    expect(legacy).toMatchObject({
      selection: "suggestion-only",
      targets: [],
      reason: "no-eligible-lead",
    });
    expect(unconfigured).toMatchObject({
      selection: "suggestion-only",
      targets: [],
      reason: "no-eligible-lead",
    });
  });

  it("omits tasks without a readiness fingerprint and treats future timestamps as fresh", () => {
    const tasks = [task("missing"), task("future")];
    const result = selectReadyGroupTasks({
      tasks,
      workState: workState(tasks, [member("a")]),
      readiness: { future: { fingerprint: "future-generation", readySince: now + 1_000 } },
      now,
      pendingTaskJobsByMember: {},
      queueCapacity: 3,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      taskId: "future",
      readinessFingerprint: "future-generation",
      readySince: now + 1_000,
      effectivePriority: "normal",
    });
  });
});
