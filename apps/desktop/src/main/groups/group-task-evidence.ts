import type { GroupTask, HarnessTaskCheckKind } from "../../shared/contracts";
import type {
  GroupTaskEvidenceRef,
  GroupTaskGateInput,
  GroupTaskReview,
  GroupTaskRunBinding,
} from "../../shared/group-work-state";
import { getHarnessQAEventByRowId } from "../agent/agent-event-store";
import { getAgentSession } from "../agent/agent-store";
import { getDatabase } from "../db/database";
import { getGroupSourceFingerprint } from "../git/git-service";
import { GroupStoreError, getAgentGroup } from "./group-store";
import { getGroupTask, getGroupTaskRunBinding, listGroupTasks } from "./group-task-store";

const CHECKS: readonly HarnessTaskCheckKind[] = ["tests", "typecheck", "lint", "build"];

/** An execution can seed QA only when its task association is unique. */
export function findGroupTaskForWake(
  groupId: string,
  sessionId: string,
  executionId: string,
):
  | { taskId: string; groupId: string; executionId: string; role: "owner" | "reviewer" }
  | undefined {
  const matches = listGroupTasks(groupId).filter(
    (task) =>
      task.executionId === executionId &&
      task.status !== "done" &&
      task.status !== "cancelled" &&
      (task.ownerSessionId === sessionId || task.reviewerSessionId === sessionId),
  );
  if (matches.length !== 1) return undefined;
  const task = matches[0];
  if (!task) return undefined;
  return {
    taskId: task.id,
    groupId,
    executionId,
    role: task.ownerSessionId === sessionId ? "owner" : "reviewer",
  };
}

export function getGroupTaskSourcePath(task: GroupTask): string | undefined {
  if (task.ownerSessionId) return getAgentSession(task.ownerSessionId)?.cwd;
  const workspaceId = getAgentGroup(task.groupId)?.workspaceId;
  if (!workspaceId) return undefined;
  const row = getDatabase()
    .prepare("select root_path from workspaces where id = ?")
    .get(workspaceId) as { root_path: string } | undefined;
  return row?.root_path;
}

function activeBinding(binding: GroupTaskRunBinding, task: GroupTask): boolean {
  const stored = getGroupTaskRunBinding(binding.sessionId, binding.runId);
  return (
    binding.groupId === task.groupId &&
    binding.taskId === task.id &&
    binding.criteriaVersion === task.criteriaVersion &&
    task[binding.role === "owner" ? "ownerSessionId" : "reviewerSessionId"] === binding.sessionId &&
    stored?.groupId === binding.groupId &&
    stored.taskId === binding.taskId &&
    stored.taskVersion === binding.taskVersion &&
    stored.criteriaVersion === binding.criteriaVersion &&
    stored.executionId === binding.executionId &&
    stored.role === binding.role &&
    stored.sourceFingerprint === binding.sourceFingerprint
  );
}

/** Convert one exact persisted QA row to identity-only task references. */
export function collectGroupTaskRunEvidence(
  binding: GroupTaskRunBinding,
  qaEventRowId: number,
): GroupTaskEvidenceRef[] {
  let task: GroupTask;
  try {
    task = getGroupTask(binding.taskId);
  } catch {
    return [];
  }
  if (!activeBinding(binding, task)) return [];
  const qa = getHarnessQAEventByRowId(qaEventRowId, binding.sessionId, binding.runId);
  const fingerprint = qa?.result.sourceFingerprint;
  if (!fingerprint) return [];
  const refs: GroupTaskEvidenceRef[] = [];
  for (const criterion of task.criteria ?? []) {
    for (const checkName of criterion.requiredCheckKinds) {
      const item = qa.result.evidence.find((evidence) => evidence.checkName === checkName);
      if (!item || !CHECKS.includes(checkName)) continue;
      refs.push({
        criterionId: criterion.id,
        checkName,
        criteriaVersion: binding.criteriaVersion,
        sessionId: binding.sessionId,
        runId: binding.runId,
        eventRowId: qaEventRowId,
        evidenceId: item.id,
        sourceFingerprint: fingerprint,
      });
    }
  }
  return refs;
}

function currentReview(
  task: GroupTask,
  sourceFingerprint: string,
  proposed?: GroupTaskReview,
): GroupTaskReview | undefined {
  const review = proposed ?? task.review;
  if (
    review?.verdict !== "approve" ||
    !review.eventId ||
    review.reviewerSessionId !== task.reviewerSessionId ||
    review.criteriaVersion !== task.criteriaVersion ||
    review.sourceFingerprint !== sourceFingerprint ||
    !sourceFingerprint ||
    !Array.isArray(review.approvedCriterionIds) ||
    review.approvedCriterionIds.some(
      (id) =>
        typeof id !== "string" || !(task.criteria ?? []).some((criterion) => criterion.id === id),
    )
  )
    return undefined;
  return review;
}

export function resolveGroupTaskEvidence(
  task: GroupTask,
  sourceFingerprint: string,
): GroupTaskGateInput {
  const review = currentReview(task, sourceFingerprint);
  const criterionOutcomes = (task.criteria ?? []).map((criterion) => {
    if (!sourceFingerprint)
      return {
        criterionId: criterion.id,
        criteriaVersion: task.criteriaVersion ?? 0,
        sourceFingerprint,
        status: "unavailable" as const,
      };
    if (criterion.requiredCheckKinds.length === 0)
      return {
        criterionId: criterion.id,
        criteriaVersion: task.criteriaVersion ?? 0,
        sourceFingerprint,
        status: review?.approvedCriterionIds.includes(criterion.id)
          ? ("review_approved" as const)
          : ("missing" as const),
      };
    const byEvent = new Map<string, Set<HarnessTaskCheckKind>>();
    for (const ref of task.evidenceRefs ?? []) {
      if (
        ref.criterionId !== criterion.id ||
        ref.criteriaVersion !== task.criteriaVersion ||
        ref.sourceFingerprint !== sourceFingerprint ||
        !ref.checkName ||
        !criterion.requiredCheckKinds.includes(ref.checkName)
      )
        continue;
      const binding = getGroupTaskRunBinding(ref.sessionId, ref.runId);
      if (!binding || !activeBinding(binding, task)) continue;
      const qa = getHarnessQAEventByRowId(ref.eventRowId, ref.sessionId, ref.runId);
      if (!qa || qa.result.sourceFingerprint !== sourceFingerprint) continue;
      const item = qa.result.evidence.find(
        (evidence) =>
          evidence.id === ref.evidenceId &&
          evidence.checkName === ref.checkName &&
          evidence.status === "passed",
      );
      if (!item) continue;
      const key = `${ref.sessionId}:${ref.runId}:${ref.eventRowId}`;
      const checks = byEvent.get(key) ?? new Set<HarnessTaskCheckKind>();
      checks.add(ref.checkName);
      byEvent.set(key, checks);
    }
    return {
      criterionId: criterion.id,
      criteriaVersion: task.criteriaVersion ?? 0,
      sourceFingerprint,
      status: [...byEvent.values()].some((checks) =>
        criterion.requiredCheckKinds.every((kind) => checks.has(kind)),
      )
        ? ("passed" as const)
        : ("missing" as const),
    };
  });
  const tasks = listGroupTasks(task.groupId);
  return {
    task,
    criterionOutcomes,
    sourceFingerprint,
    dependencies: tasks
      .filter((candidate) => (task.dependencyIds ?? []).includes(candidate.id))
      .map(({ id, status }) => ({ id, status })),
    ...(review ? { review } : {}),
  };
}

/** Git work occurs before the caller's final synchronous, version-checked transition. */
export async function verifyGroupTaskForTransition(input: {
  taskId: string;
  expectedVersion: number;
  action: "approve" | "agree";
  review?: GroupTaskReview;
}): Promise<GroupTaskGateInput> {
  const task = getGroupTask(input.taskId);
  if (task.stateVersion !== input.expectedVersion)
    throw new GroupStoreError("stale-task", `Task ${task.id} changed before verification.`);
  let fingerprint = "";
  const source = getGroupTaskSourcePath(task);
  if (source) {
    try {
      fingerprint = await getGroupSourceFingerprint(source);
    } catch {
      /* unavailable */
    }
  }
  const latest = getGroupTask(input.taskId);
  if (
    latest.stateVersion !== input.expectedVersion ||
    latest.criteriaVersion !== task.criteriaVersion
  )
    throw new GroupStoreError("stale-task", `Task ${task.id} changed during verification.`);
  if (
    input.action === "approve" &&
    input.review &&
    fingerprint &&
    !currentReview(latest, fingerprint, input.review)
  )
    throw new GroupStoreError(
      "stale-evidence",
      "Proposed review is outside the current task source.",
    );
  const snapshot = resolveGroupTaskEvidence(
    { ...latest, ...(input.action === "approve" && input.review ? { review: input.review } : {}) },
    fingerprint,
  );
  return snapshot;
}
