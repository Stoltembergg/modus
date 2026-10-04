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

/** Editable fields accepted from the trusted desktop renderer. */
export type GroupTaskUserDraft = Omit<GroupTaskDraft, "groupId">;

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

export type GroupTaskEvidenceDetailStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "missing"
  | "stale"
  | "unavailable"
  | "user_confirmed";

export type GroupTaskEvidenceDetail = {
  criterionId: string;
  checkName?: HarnessTaskCheckKind;
  sessionId: string;
  runId: string;
  executionId?: string;
  status: GroupTaskEvidenceDetailStatus;
  reason?: string;
};

export type GroupTaskCriterionDetail = {
  criterionId: string;
  description: string;
  requiredCheckKinds: HarnessTaskCheckKind[];
  status: "passed" | "review_approved" | "failed" | "missing" | "stale" | "unavailable";
  evidence: GroupTaskEvidenceDetail[];
  omittedEvidenceCount: number;
};

export type GroupTaskDetails = {
  task: GroupTask;
  dependencies: Array<Pick<GroupTask, "id" | "title" | "status">>;
  dependencyOptions: Array<Pick<GroupTask, "id" | "title" | "status">>;
  omittedDependencyOptionCount: number;
  blocker?: { kind: "task" | "dependency"; reason: string };
  source: { availability: "available" | "missing" | "unavailable"; reason?: string };
  criteria: GroupTaskCriterionDetail[];
  review: {
    status: "approved" | "changes_requested" | "pending" | "unavailable" | "not_required";
    reviewerSessionId?: string;
  };
  gate: GroupTaskGateResult;
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
  /** Only task-bound sources can initiate policy decisions. Ordered by persisted event sequence. */
  triggers: GroupTaskTrigger[];
  /** Successful dispatch receipts from explicit task tools. */
  explicitWakeSourceEventIds: string[];
  /** Live runtime availability, including busy or otherwise unavailable members. */
  memberAvailability: Record<string, "available" | "unavailable">;
  /** Remaining wakes for each current member in this execution. Omitted targets have no allowance. */
  remainingWakesByMember: Record<string, number>;
  /** Current task review state, resolved separately from the completion gate. */
  reviewStates: Record<string, "pending" | "changes_requested" | "approved" | "unavailable">;
  /** Required QA checks before review; review-only criteria can be ready before approval. */
  reviewReadiness: Record<
    string,
    "ready" | "missing" | "failed" | "skipped" | "stale" | "unavailable" | "user_confirmed"
  >;
  stopRequested: boolean;
  waitingForUser: boolean;
};

export type GroupTaskTrigger = {
  kind:
    | "task_assigned"
    | "task_unblocked"
    | "review_requested"
    | "review_changes_requested"
    | "task_qa_updated";
  groupId: string;
  taskId: string;
  taskVersion: number;
  executionId?: string;
  sourceEventId: string;
  /** Stable monotonic order assigned by the persisted event source. */
  sequence: number;
  /** Status transition for review events, validated against the current task. */
  fromStatus?: GroupTaskStatus;
  toStatus?: GroupTaskStatus;
};

export type GroupProactivityDecision = {
  kind: "suggest" | "wake_owner" | "wake_reviewer";
  taskId: string;
  targetSessionId?: string;
  sourceEventId: string;
  reasonCode: string;
  idempotencyKey: string;
};

/** User-facing projection of a persisted proactive suggestion; contains no transcript or QA output. */
export type GroupSuggestion = {
  actionId: string;
  version: number;
  state: "suggested";
  task: { id: string; title: string; stateVersion: number };
  source: {
    eventId: string;
    kind: GroupTaskTrigger["kind"];
    sequence: number;
    executionId?: string;
  };
  reasonCode: string;
  reason: string;
  proposedTargetSessionId?: string;
  candidateSessionIds: string[];
  /** The origin chain has ended, so accepting opens a new user-authorized execution. */
  startNewExecution: boolean;
};

export type ResolveGroupSuggestionInput = {
  actionId: string;
  decision: "accept" | "discard";
  expectedVersion: number;
  /** Optional explicit reassignment, checked against current Group membership in main. */
  targetSessionId?: string;
};

export type GroupSuggestionResolution = {
  actionId: string;
  groupId: string;
  taskId: string;
  sourceEventId: string;
  /** Immutable origin execution; accepting after it ends does not revive it. */
  executionId?: string;
  deliveryState: "dispatched" | "discarded";
  version: number;
  resolvedExecutionId?: string;
  resolutionTargetSessionId?: string;
  wakeMessageId?: string;
  jobId?: string;
};
