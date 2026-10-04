import type { GroupTask } from "../../shared/contracts-parts/contracts-part-08";
import type {
  GroupDecisionSnapshot,
  GroupProactivityDecision,
  GroupTaskTrigger,
} from "../../shared/group-work-state";

const triggerKinds = new Set<GroupTaskTrigger["kind"]>([
  "task_assigned",
  "task_unblocked",
  "review_requested",
  "review_changes_requested",
  "task_qa_updated",
]);

const priorityRank = { high: 0, normal: 1, low: 2 } as const;

type Candidate = { task: GroupTask; trigger: GroupTaskTrigger };

function targetFor(candidate: Candidate): {
  kind: "wake_owner" | "wake_reviewer";
  targetSessionId: string | undefined;
  reasonCode: string;
} {
  const { task, trigger } = candidate;
  if (trigger.kind === "review_requested" || trigger.kind === "task_qa_updated") {
    if (trigger.kind === "review_requested" || task.verificationPolicy?.requireReview) {
      return {
        kind: "wake_reviewer",
        targetSessionId: task.reviewerSessionId,
        reasonCode: "review-ready",
      };
    }
  }
  return { kind: "wake_owner", targetSessionId: task.ownerSessionId, reasonCode: "owner-ready" };
}

function decisionFor(
  candidate: Candidate,
  snapshot: GroupDecisionSnapshot,
): GroupProactivityDecision {
  const { task, trigger } = candidate;
  const desired = targetFor(candidate);
  let kind: GroupProactivityDecision["kind"] = desired.kind;
  let reasonCode = desired.reasonCode;
  let targetSessionId = desired.targetSessionId;
  const dependencies = new Map(snapshot.workState.tasks.map((item) => [item.id, item.status]));
  const dependenciesReady = (task.dependencyIds ?? []).every(
    (id) => dependencies.get(id) === "done",
  );
  const gate = snapshot.workState.gates[task.id];
  const qaMissing =
    !gate ||
    gate.reasonCodes.some(
      (reason) =>
        reason === "criterion-unverified" ||
        reason === "verification-required" ||
        reason === "evidence-unavailable" ||
        reason === "source-unavailable",
    );
  const reviewState = snapshot.reviewStates[task.id];
  const reviewReady = reviewState === "pending";
  const gateReadyForReview =
    gate?.reasonCodes.every((reason) => reason === "review-required") ?? false;
  const member = snapshot.workState.members.find((item) => item.sessionId === targetSessionId);
  const budget = snapshot.workState.budgets;

  if (!dependenciesReady || gate?.reasonCodes.includes("dependency-incomplete")) {
    kind = "suggest";
    reasonCode = "dependency-incomplete";
  } else if (task.status === "blocked" && trigger.kind !== "task_unblocked") {
    kind = "suggest";
    reasonCode = "task-blocked";
  } else if (desired.kind === "wake_reviewer" && qaMissing) {
    kind = "suggest";
    reasonCode = "qa-missing";
  } else if (desired.kind === "wake_reviewer" && (!gateReadyForReview || !reviewReady)) {
    kind = "suggest";
    reasonCode = "review-unavailable";
  } else if (trigger.kind === "review_changes_requested" && reviewState !== "changes_requested") {
    kind = "suggest";
    reasonCode = "review-unavailable";
  } else if (!targetSessionId) {
    kind = "suggest";
    reasonCode = "target-unassigned";
  } else if (
    !member ||
    member.archived ||
    snapshot.memberAvailability[targetSessionId] !== "available"
  ) {
    kind = "suggest";
    reasonCode = "member-unavailable";
  } else if (
    budget.remainingAgentMessages <= 0 ||
    budget.remainingMemberWakes <= 0 ||
    budget.remainingInputTokens <= 0
  ) {
    kind = "suggest";
    reasonCode = "budget-exhausted";
  }

  if (snapshot.mode === "suggest") {
    if (kind !== "suggest") reasonCode = "actionable-task-event";
    kind = "suggest";
  }

  if (kind === "suggest") targetSessionId = undefined;
  const idempotencyKey = JSON.stringify([
    snapshot.workState.groupId,
    trigger.executionId ?? "",
    trigger.sourceEventId,
    trigger.taskVersion,
    kind,
    trigger.kind,
    targetSessionId ?? "",
  ]);
  return {
    kind,
    taskId: task.id,
    ...(targetSessionId ? { targetSessionId } : {}),
    sourceEventId: trigger.sourceEventId,
    reasonCode,
    idempotencyKey,
  };
}

/** Pure one-decision arbitration over current task state and typed persisted events. */
export function decideGroupNextAction(
  snapshot: GroupDecisionSnapshot,
): GroupProactivityDecision | null {
  const execution = snapshot.workState.execution;
  if (
    snapshot.stopRequested ||
    snapshot.waitingForUser ||
    execution?.stopped ||
    execution?.waitingForUser
  )
    return null;

  const dispatched = new Set(snapshot.explicitWakeSourceEventIds);
  const tasks = new Map(snapshot.workState.tasks.map((task) => [task.id, task]));
  const candidates: Candidate[] = [];
  for (const trigger of snapshot.triggers) {
    if (
      !triggerKinds.has(trigger.kind) ||
      !trigger.sourceEventId ||
      dispatched.has(trigger.sourceEventId)
    )
      continue;
    if (trigger.groupId !== snapshot.workState.groupId || trigger.executionId !== execution?.id)
      continue;
    const task = tasks.get(trigger.taskId);
    if (!task || task.groupId !== trigger.groupId || task.executionId !== trigger.executionId)
      continue;
    if (
      task.stateVersion !== trigger.taskVersion ||
      task.status === "done" ||
      task.status === "cancelled"
    )
      continue;
    candidates.push({ task, trigger });
  }
  candidates.sort(
    (a, b) =>
      priorityRank[a.task.priority ?? "normal"] - priorityRank[b.task.priority ?? "normal"] ||
      a.trigger.sequence - b.trigger.sequence ||
      a.task.id.localeCompare(b.task.id) ||
      a.trigger.sourceEventId.localeCompare(b.trigger.sourceEventId),
  );
  const winner = candidates[0];
  return winner ? decisionFor(winner, snapshot) : null;
}
