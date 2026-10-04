import type {
  HarnessTaskCheckKind,
  VerificationEvidenceStatus,
} from "./contracts-parts/contracts-part-01";
import type {
  AgentGroupMember,
  GroupTask,
  GroupTaskStatus,
} from "./contracts-parts/contracts-part-08";

export type GroupTaskKind =
  | "legacy"
  | "code"
  | "docs"
  | "design"
  | "review"
  | "research"
  | "question";
export type GroupTaskStage = "plan" | "implement" | "verify" | "review" | "deliver";
export type GroupTaskPriority = "low" | "normal" | "high";
export type GroupProactivityMode = "suggest" | "opt_in_auto";

export type GroupTaskCriterion = {
  id: string;
  description: string;
  requiredCheckKinds: HarnessTaskCheckKind[];
};

export type GroupTaskVerificationPolicy = { mode: "none" | "required"; requireReview: boolean };

/** Identity only. QA status is resolved from the persisted harness event when the gate is read. */
export type GroupTaskEvidenceRef = {
  criterionId: string;
  checkName?: HarnessTaskCheckKind;
  criteriaVersion: number;
  sessionId: string;
  runId: string;
  eventRowId: number;
  evidenceId: string;
  sourceFingerprint: string;
};

export type GroupTaskReview = {
  reviewerSessionId: string;
  verdict: "approve" | "changes";
  criteriaVersion: number;
  sourceFingerprint: string;
  eventId: string;
  approvedCriterionIds: string[];
};

export type GroupTaskDraft = {
  groupId: string;
  title: string;
  description?: string;
  kind: GroupTaskKind;
  priority: GroupTaskPriority;
  dependencyIds: string[];
  criteria: GroupTaskCriterion[];
  verificationPolicy: GroupTaskVerificationPolicy;
  reviewerSessionId?: string;
};

/** A transient outcome produced by the main-process evidence resolver. */
export type GroupTaskCriterionOutcome = {
  criterionId: string;
  criteriaVersion: number;
  status: VerificationEvidenceStatus | "review_approved";
  sourceFingerprint: string;
};

export type GroupTaskGateInput = {
  task: GroupTask;
  criterionOutcomes: GroupTaskCriterionOutcome[];
  review?: GroupTaskReview;
  sourceFingerprint: string;
  dependencies: Array<Pick<GroupTask, "id" | "status">>;
};

export type GroupTaskGateResult = { satisfied: boolean; reasonCodes: string[] };
export type GroupTaskValidationResult = {
  issues: Array<{ code: string; field: string; message: string }>;
};

export type GroupTaskTransitionEvent = {
  id: string;
  groupId: string;
  taskId: string;
  taskVersion: number;
  action: string;
  actorSessionId?: string;
  sourceEventId?: string;
  executionId?: string;
  fromStatus: GroupTaskStatus;
  toStatus: GroupTaskStatus;
  createdAt: string;
};

export type GroupTaskProgressInput = {
  groupId: string;
  taskId: string;
  actorSessionId: string;
  expectedVersion: number;
  operationId: string;
  stage?: GroupTaskStage;
  /** Null clears the current block. */
  blockedReason?: string | null;
};

export type GroupTaskEvidenceInput = {
  groupId: string;
  taskId: string;
  actorSessionId: string;
  expectedVersion: number;
  operationId: string;
  evidenceRefs: GroupTaskEvidenceRef[];
};

export type GroupTaskRunBinding = {
  groupId: string;
  taskId: string;
  taskVersion: number;
  criteriaVersion: number;
  sessionId: string;
  runId: string;
  executionId: string;
  role: "owner" | "reviewer";
  sourceFingerprint: string;
};

export type BindGroupTaskRunInput = GroupTaskRunBinding & {
  expectedVersion: number;
  operationId: string;
};

export type GroupWorkState = {
  groupId: string;
  tasks: GroupTask[];
  gates: Record<string, GroupTaskGateResult>;
  members: AgentGroupMember[];
  execution?: { id: string; stopped: boolean; waitingForUser: boolean };
  /** Compact summaries; current Git freshness is unavailable in this synchronous read. */
  qa?: Record<
    string,
    {
      criterionCount: number;
      evidenceCount: number;
      pendingCriterionIds: string[];
      freshness: "unavailable";
    }
  >;
  omitted: { tasks: number; members: number; criteria: number };
  budgets: {
    remainingAgentMessages: number;
    remainingMemberWakes: number;
    remainingInputTokens: number;
  };
};

export type GroupDecisionSnapshot = {
  workState: GroupWorkState;
  mode: GroupProactivityMode;
  sourceEventId: string;
  stopRequested: boolean;
  waitingForUser: boolean;
};

export type GroupProactivityDecision = {
  kind: "suggest" | "wake_owner" | "wake_reviewer";
  taskId: string;
  targetSessionId?: string;
  sourceEventId: string;
  reasonCode: string;
  idempotencyKey: string;
};
