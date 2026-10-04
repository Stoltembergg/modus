import type { GroupTask } from "./contracts";
import type { GroupTaskKind, GroupTaskStage, GroupWorkState } from "./group-work-state";

export const SUPERVISED_FLOW_STAGES = ["plan", "implement", "verify", "review", "deliver"] as const;
export type SupervisedFlowStageId = GroupTaskStage;
export type SupervisedFlowStage = {
  id: SupervisedFlowStageId;
  skip: boolean;
  blocked: boolean;
  reason?: string;
  ownerSessionId?: string;
};
export type SupervisedDelegation = {
  taskId: string;
  stage: GroupTaskStage;
  tool: "group_assign_task" | "group_request_review";
  memberId: string;
};
export type SupervisedFlowPlan = {
  applies: boolean;
  taskId: string;
  kind: GroupTaskKind;
  gate: { satisfied: boolean; reasonCodes: string[] };
  stages: SupervisedFlowStage[];
  delegations: SupervisedDelegation[];
};

export type SupervisedFlowAudience = {
  sessionId: string;
  leadSessionId?: string;
  taskOwnerSessionId?: string;
};

/** Stage decisions use persisted task metadata only. Future stages never dispatch prematurely. */
export function planSupervisedCodeFlow(input: {
  task: GroupTask;
  workState: GroupWorkState;
}): SupervisedFlowPlan {
  const { task, workState } = input;
  const kind = task.kind ?? "legacy";
  const applies =
    ["code", "docs", "design", "review"].includes(kind) &&
    task.status !== "done" &&
    task.status !== "cancelled";
  const gate = workState.gates[task.id] ?? { satisfied: false, reasonCodes: ["gate-unavailable"] };
  const current =
    task.status === "in_review" || kind === "review"
      ? "review"
      : (task.stage ?? (kind === "design" ? "plan" : "implement"));
  const dependencyBlocked = task.dependencyIds?.some(
    (id) => workState.tasks.find((t) => t.id === id)?.status !== "done",
  );
  const globalReason =
    workState.execution?.stopped || workState.execution?.waitingForUser
      ? "execution-unavailable"
      : task.status === "blocked" || task.blockedReason
        ? "task-blocked"
        : dependencyBlocked
          ? "dependency-incomplete"
          : undefined;
  const planner =
    workState.members.find(
      (m) =>
        m.sessionId === task.createdBySessionId &&
        !m.archived &&
        m.capabilityIds?.includes("plan") &&
        m.supportedTaskKinds?.includes(kind),
    ) ??
    [...workState.members]
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      .find(
        (m) =>
          !m.archived && m.capabilityIds?.includes("plan") && m.supportedTaskKinds?.includes(kind),
      );
  const stages = SUPERVISED_FLOW_STAGES.map((id): SupervisedFlowStage => {
    const skip =
      !applies ||
      (id === "implement" && (kind === "design" || kind === "review")) ||
      (id === "plan" && kind === "review") ||
      (id === "verify" && task.verificationPolicy?.mode !== "required") ||
      (id === "review" && kind !== "review" && !task.verificationPolicy?.requireReview);
    const ownerId =
      id === "review"
        ? task.reviewerSessionId
        : id === "plan" || id === "deliver"
          ? planner?.sessionId
          : task.ownerSessionId;
    const owner = workState.members.find(
      (m) =>
        m.sessionId === ownerId &&
        !m.archived &&
        m.supportedTaskKinds?.includes(kind) &&
        m.capabilityIds?.includes(
          id === "deliver" ? "plan" : id === "implement" && kind === "docs" ? "docs" : id,
        ),
    );
    const reason = skip
      ? "stage-not-required"
      : (globalReason ??
        (!owner || (id === "review" && ownerId === task.ownerSessionId)
          ? id === "review"
            ? "reviewer-unavailable"
            : "owner-unavailable"
          : id !== current
            ? "stage-pending"
            : id === "deliver" && !gate.satisfied
              ? "completion-gate-unsatisfied"
              : undefined));
    return {
      id,
      skip,
      blocked: !skip && Boolean(reason),
      ...(reason ? { reason } : {}),
      ...(owner ? { ownerSessionId: owner.sessionId } : {}),
    };
  });
  const delegations: SupervisedDelegation[] = stages.flatMap((stage) => {
    const memberId = stage.ownerSessionId;
    if (
      stage.skip ||
      stage.blocked ||
      !memberId ||
      (stage.id !== "implement" && stage.id !== "review" && stage.id !== "verify")
    ) {
      return [];
    }
    return [
      {
        taskId: task.id,
        stage: stage.id,
        tool: stage.id === "review" ? "group_request_review" : "group_assign_task",
        memberId,
      },
    ];
  });
  return { applies, taskId: task.id, kind, gate, stages, delegations };
}

export function composeSupervisedFlowSection(
  plan: SupervisedFlowPlan,
  audience: SupervisedFlowAudience,
): string {
  if (!plan.applies) return "";
  const delegations = projectSupervisedDelegations(plan, audience);
  return [
    "<supervised_flow>",
    `Typed task: ${plan.taskId}; kind: ${plan.kind}`,
    `Gate: ${JSON.stringify(plan.gate)}`,
    "Only RUN stages are ready. The delegation line, when present, is actionable only for its authorized actor; recheck live member availability before using it.",
    ...plan.stages.map(
      (s) =>
        `- ${s.id}: ${s.skip ? "SKIP" : s.blocked ? "BLOCKED" : "RUN"}; owner=${s.ownerSessionId ?? "unassigned"}; reason=${s.reason ?? "ready"}`,
    ),
    ...delegations.map(
      (d) => `- ${d.stage}: ${d.tool}(taskId=${d.taskId}, memberId=${d.memberId})`,
    ),
    "</supervised_flow>",
  ].join("\n");
}

/** Keep the intended target while exposing actions only to their initiating participant. */
export function projectSupervisedDelegations(
  plan: SupervisedFlowPlan,
  audience: SupervisedFlowAudience,
): SupervisedDelegation[] {
  return plan.delegations.filter((delegation) => {
    if (delegation.memberId === audience.sessionId) return false;
    return delegation.tool === "group_assign_task"
      ? audience.sessionId === audience.leadSessionId
      : audience.sessionId === audience.taskOwnerSessionId;
  });
}
