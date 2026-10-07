import { existsSync } from "node:fs";
import type { GroupTask, VerificationEvidenceStatus } from "../../shared/contracts";
import { evaluateGroupTaskGate } from "../../shared/group-task-policy";
import type {
  GroupTaskCriterionDetail,
  GroupTaskDetails,
  GroupTaskEvidenceDetail,
} from "../../shared/group-work-state";
import { getHarnessQAEventByRowId } from "../agent/agent-event-store";
import { getGroupSourceFingerprint } from "../git/git-service";
import { GroupStoreError } from "./group-store";
import { getGroupTaskSourcePath, resolveGroupTaskEvidence } from "./group-task-evidence";
import {
  getGroupTask,
  getGroupTaskIntentFingerprint,
  getGroupTaskRunBinding,
  getLatestGroupTaskReport,
  isGroupTaskRunAssignmentCurrent,
  listGroupTasks,
} from "./group-task-store";

const MAX_EVIDENCE_PER_CRITERION = 32;
const MAX_DEPENDENCY_OPTIONS = 200;

function evidenceStatus(
  task: GroupTask,
  ref: NonNullable<GroupTask["evidenceRefs"]>[number],
  sourceFingerprint: string,
  sourceAvailability: GroupTaskDetails["source"]["availability"],
): GroupTaskEvidenceDetail {
  const base: Omit<GroupTaskEvidenceDetail, "status"> = {
    criterionId: ref.criterionId,
    ...(ref.checkName ? { checkName: ref.checkName } : {}),
    sessionId: ref.sessionId,
    runId: ref.runId,
  };
  const unavailable = (reason: string): GroupTaskEvidenceDetail => ({
    ...base,
    status: "unavailable",
    reason,
  });
  const stale = (reason: string): GroupTaskEvidenceDetail => ({
    ...base,
    status: "stale",
    reason,
  });
  if (sourceAvailability !== "available") {
    return unavailable(
      sourceAvailability === "missing"
        ? "The task source folder was removed."
        : "Current task source could not be checked.",
    );
  }
  if (ref.criteriaVersion !== task.criteriaVersion)
    return stale("Task criteria changed after this QA run.");
  if (!sourceFingerprint || ref.sourceFingerprint !== sourceFingerprint)
    return stale("Task source changed after this QA run.");
  const binding = getGroupTaskRunBinding(ref.sessionId, ref.runId);
  if (
    !binding ||
    binding.groupId !== task.groupId ||
    binding.taskId !== task.id ||
    binding.criteriaVersion !== task.criteriaVersion ||
    task[binding.role === "owner" ? "ownerSessionId" : "reviewerSessionId"] !== binding.sessionId ||
    !isGroupTaskRunAssignmentCurrent(binding)
  ) {
    return stale("Task assignment changed after this QA run.");
  }
  const qa = getHarnessQAEventByRowId(ref.eventRowId, ref.sessionId, ref.runId);
  if (!qa) return { ...base, status: "missing", reason: "The QA event was removed." };
  if (qa.result.sourceFingerprint !== sourceFingerprint)
    return stale("The QA event belongs to a different source revision.");
  const item = qa.result.evidence.find(
    (candidate) => candidate.id === ref.evidenceId && candidate.checkName === ref.checkName,
  );
  if (!item) return { ...base, status: "missing", reason: "This QA check is no longer available." };
  const status: VerificationEvidenceStatus = item.status;
  return {
    ...base,
    ...(binding.executionId ? { executionId: binding.executionId } : {}),
    status,
    ...(status === "passed" ? {} : { reason: `The QA check is ${status.replaceAll("_", " ")}.` }),
  };
}

function criterionStatus(
  outcome: string | undefined,
  evidence: GroupTaskEvidenceDetail[],
): GroupTaskCriterionDetail["status"] {
  if (outcome === "passed") return "passed";
  if (outcome === "review_approved") return "review_approved";
  if (evidence.some((item) => item.status === "failed")) return "failed";
  if (evidence.some((item) => item.status === "stale")) return "stale";
  if (evidence.some((item) => item.status === "unavailable")) return "unavailable";
  return "missing";
}

/** Bounded user-facing detail. Harness outputs, logs and transcripts never leave main. */
export async function getGroupTaskDetails(
  groupId: string,
  taskId: string,
): Promise<GroupTaskDetails> {
  return resolveGroupTaskDetails(groupId, taskId, 1);
}

async function resolveGroupTaskDetails(
  groupId: string,
  taskId: string,
  retries: number,
): Promise<GroupTaskDetails> {
  const task = getGroupTask(taskId);
  if (task.groupId !== groupId)
    throw new GroupStoreError("task-not-found", `Group task not found: ${taskId}`);

  let source: GroupTaskDetails["source"] = {
    availability: "unavailable",
    reason: "Task source location is unavailable.",
  };
  let sourceFingerprint = "";
  const sourcePath = getGroupTaskSourcePath(task);
  if (sourcePath && !existsSync(sourcePath)) {
    source = { availability: "missing", reason: "The task source folder was removed." };
  } else if (sourcePath) {
    try {
      sourceFingerprint = await getGroupSourceFingerprint(sourcePath);
      source = { availability: "available" };
    } catch {
      source = {
        availability: "unavailable",
        reason: "Current task source could not be checked.",
      };
    }
  }

  const current = getGroupTask(taskId);
  if (
    current.groupId !== groupId ||
    current.stateVersion !== task.stateVersion ||
    current.criteriaVersion !== task.criteriaVersion
  ) {
    if (retries > 0) return resolveGroupTaskDetails(groupId, taskId, retries - 1);
    throw new GroupStoreError("stale-task", `Task ${taskId} changed while details were loading.`);
  }

  const evidenceInput = resolveGroupTaskEvidence(task, sourceFingerprint);
  const outcomes = new Map(
    evidenceInput.criterionOutcomes.map((outcome) => [outcome.criterionId, outcome.status]),
  );
  const criteria = (task.criteria ?? []).map((criterion): GroupTaskCriterionDetail => {
    const allEvidence = (task.evidenceRefs ?? [])
      .filter((ref) => ref.criterionId === criterion.id)
      .map((ref) => evidenceStatus(task, ref, sourceFingerprint, source.availability));
    return {
      criterionId: criterion.id,
      description: criterion.description,
      requiredCheckKinds: [...criterion.requiredCheckKinds],
      status: criterionStatus(outcomes.get(criterion.id), allEvidence),
      evidence: allEvidence.slice(0, MAX_EVIDENCE_PER_CRITERION),
      omittedEvidenceCount: Math.max(0, allEvidence.length - MAX_EVIDENCE_PER_CRITERION),
    };
  });
  const allTasks = listGroupTasks(groupId);
  const dependencyRow = ({ id, title, status: dependencyStatus }: GroupTask) => ({
    id,
    title,
    status: dependencyStatus,
  });
  const selectedDependencyIds = new Set(task.dependencyIds ?? []);
  const dependencies = allTasks
    .filter((candidate) => selectedDependencyIds.has(candidate.id))
    .map(dependencyRow);
  const dependencyOptions = allTasks
    .filter((candidate) => candidate.id !== task.id)
    .slice(0, MAX_DEPENDENCY_OPTIONS)
    .map(dependencyRow);
  for (const dependency of dependencies) {
    if (!dependencyOptions.some((option) => option.id === dependency.id))
      dependencyOptions.push(dependency);
  }
  const incompleteDependencies = dependencies.filter((dependency) => dependency.status !== "done");
  const blocker =
    task.status === "blocked"
      ? { kind: "task" as const, reason: task.blockedReason || "Task is blocked." }
      : incompleteDependencies.length > 0
        ? {
            kind: "dependency" as const,
            reason: `Waiting for ${incompleteDependencies.map(({ title }) => title).join(", ")}.`,
          }
        : undefined;
  const reviewStatus: GroupTaskDetails["review"]["status"] =
    task.verificationPolicy?.requireReview !== true
      ? "not_required"
      : !sourceFingerprint
        ? "unavailable"
        : task.review?.verdict === "approve" &&
            task.review.criteriaVersion === task.criteriaVersion &&
            task.review.sourceFingerprint === sourceFingerprint &&
            task.review.reviewerSessionId === task.reviewerSessionId
          ? "approved"
          : task.review?.verdict === "changes"
            ? "changes_requested"
            : "pending";

  const report = getLatestGroupTaskReport(task.id);
  const staleReason = !report
    ? undefined
    : !sourceFingerprint || source.availability !== "available"
      ? "Current task source could not be checked."
      : report.criteriaVersion !== task.criteriaVersion
        ? "Task criteria changed after this handoff."
        : report.taskIntentFingerprint !== getGroupTaskIntentFingerprint(task)
          ? "Task intent changed after this handoff."
          : report.sourceFingerprint !== sourceFingerprint
            ? "Task source changed after this handoff."
            : undefined;
  return {
    task,
    ...(report
      ? {
          report: {
            kind: "unverified_handoff" as const,
            report,
            freshness: staleReason ? ("stale" as const) : ("current" as const),
            ...(staleReason ? { staleReason } : {}),
            qaEvidence: report.qaEvidenceRefs.map((ref) =>
              evidenceStatus(task, ref, sourceFingerprint, source.availability),
            ),
          },
        }
      : {}),
    dependencies,
    dependencyOptions,
    omittedDependencyOptionCount: Math.max(
      0,
      allTasks.filter((candidate) => candidate.id !== task.id).length - MAX_DEPENDENCY_OPTIONS,
    ),
    ...(blocker ? { blocker } : {}),
    source,
    criteria,
    review: {
      status: reviewStatus,
      ...(task.reviewerSessionId ? { reviewerSessionId: task.reviewerSessionId } : {}),
    },
    gate: evaluateGroupTaskGate(evidenceInput),
  };
}
