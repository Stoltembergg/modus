import type { GroupTask } from "../../shared/contracts";
import type { GroupTaskPriority, GroupWorkState } from "../../shared/group-work-state";
import { type GroupRoutingReason, routeGroupTask } from "./group-capability-router";

const PRIORITY_RANK: Record<GroupTaskPriority, number> = { low: 0, normal: 1, high: 2 };
const PRIORITIES: readonly GroupTaskPriority[] = ["low", "normal", "high"];
const READY_AGE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type GroupTaskScheduleCandidate = {
  taskId: string;
  taskVersion: number;
  readinessFingerprint: string;
  readySince: number;
  effectivePriority: GroupTaskPriority;
  /** Members with a reliable declared capability and active tools, in fair queue order. */
  targets: string[];
  /** A lead fallback is a suggestion destination, never a capability match. */
  suggestedTargetSessionId?: string;
  /** True means routing metadata is reliable; runtime must still enforce opt-in and live-chain fences. */
  selection: "automatic-eligible" | "suggestion-only";
  reason: GroupRoutingReason;
};

export function selectReadyGroupTasks(input: {
  tasks: readonly GroupTask[];
  workState: GroupWorkState;
  readiness: Readonly<Record<string, { fingerprint: string; readySince: number }>>;
  now: number;
  pendingTaskJobsByMember: Readonly<Record<string, number>>;
  queueCapacity: number;
}): GroupTaskScheduleCandidate[] {
  const tasksById = new Map(input.workState.tasks.map((task) => [task.id, task]));
  for (const task of input.tasks) tasksById.set(task.id, task);
  const workState = { ...input.workState, tasks: [...tasksById.values()] };
  const assignedLoad: Record<string, number> = {};
  for (const task of workState.tasks) {
    if (task.ownerSessionId && (task.status === "in_progress" || task.status === "in_review"))
      assignedLoad[task.ownerSessionId] = (assignedLoad[task.ownerSessionId] ?? 0) + 1;
  }

  const candidates: GroupTaskScheduleCandidate[] = [];
  for (const task of input.tasks) {
    const ready = input.readiness[task.id];
    if (
      !ready?.fingerprint ||
      !Number.isFinite(ready.readySince) ||
      task.status !== "open" ||
      task.ownerSessionId ||
      task.blockedReason ||
      (task.dependencyIds ?? []).some((id) => tasksById.get(id)?.status !== "done")
    )
      continue;

    const basePriority = PRIORITIES.includes(task.priority as GroupTaskPriority)
      ? (task.priority as GroupTaskPriority)
      : "normal";
    const agedRanks = Math.floor(Math.max(0, input.now - ready.readySince) / READY_AGE_INTERVAL_MS);
    const effectivePriority = PRIORITIES[
      Math.min(PRIORITY_RANK.high, PRIORITY_RANK[basePriority] + agedRanks)
    ] as GroupTaskPriority;
    const pendingTaskJobCountByMember: Record<string, number> = {};
    const memberDispatch: NonNullable<Parameters<typeof routeGroupTask>[0]["memberDispatch"]> = {};
    for (const member of input.workState.members) {
      const pendingTaskJobCount = Math.max(
        0,
        Math.floor(input.pendingTaskJobsByMember[member.sessionId] ?? 0),
      );
      pendingTaskJobCountByMember[member.sessionId] = pendingTaskJobCount;
      memberDispatch[member.sessionId] = {
        availability: "available",
        pendingTaskJobCount,
        capacity: Math.max(0, Math.floor(input.queueCapacity)),
      };
    }
    const routing = routeGroupTask({
      task,
      workState,
      memberAvailability: {},
      memberDispatch,
      currentLoad: assignedLoad,
      toolConfigurations: Object.fromEntries(
        workState.members.map((member) => [member.sessionId, { profile: "chat" as const }]),
      ),
    });
    const targets =
      routing.kind === "selected"
        ? [...routing.candidateSessionIds].sort(
            (a, b) =>
              (pendingTaskJobCountByMember[a] ?? 0) - (pendingTaskJobCountByMember[b] ?? 0) ||
              (assignedLoad[a] ?? 0) - (assignedLoad[b] ?? 0) ||
              (a < b ? -1 : a > b ? 1 : 0),
          )
        : [];
    candidates.push({
      taskId: task.id,
      taskVersion: task.stateVersion ?? 1,
      readinessFingerprint: ready.fingerprint,
      readySince: ready.readySince,
      effectivePriority,
      targets,
      ...(routing.kind === "suggest_lead" && routing.targetSessionId
        ? { suggestedTargetSessionId: routing.targetSessionId }
        : {}),
      selection: routing.kind === "selected" ? "automatic-eligible" : "suggestion-only",
      reason: routing.reasonCode,
    });
  }

  return candidates.sort(
    (a, b) =>
      PRIORITY_RANK[b.effectivePriority] - PRIORITY_RANK[a.effectivePriority] ||
      a.readySince - b.readySince ||
      (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
  );
}
