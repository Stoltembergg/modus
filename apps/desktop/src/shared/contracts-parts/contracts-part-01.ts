import type { HarnessPolicyDocument } from "./contracts-part-02";
import type { PlanRef } from "./contracts-part-06";

export type WorkspaceInfo = {
  id: string;
  rootPath: string;
  displayName: string;
  isGitRepository: boolean;
  lastOpenedAt: string;
  /** Pinned projects sort to the top of the sidebar's Projects list. */
  pinned: boolean;
  /**
   * Inbox chats with no project folder selected. Hidden from Projects and
   * listed under the sidebar Chats section instead.
   */
  inbox?: boolean;
};

/** Stable workspace id for folderless chats (sidebar → Chats). */
export const CHATS_WORKSPACE_ID = "modus-inbox-chats";

export type ProjectMemoryScope = { kind: "global" } | { kind: "project"; workspaceId: string };
export type ProjectMemoryCategory =
  | "decision"
  | "architecture"
  | "convention"
  | "constraint"
  | "known_issue"
  | "solution"
  | "failed_attempt"
  | "task_result"
  | "preference";
export type ProjectMemoryStatus =
  | "candidate"
  | "active"
  | "provisional"
  | "needs_review"
  | "superseded"
  | "obsolete";
export type ProjectMemoryVerification =
  | "user_explicit"
  | "agent_observed"
  | "tests_passed"
  | "parent_verified"
  | "unverified";
export type ProjectMemoryExternalReference = {
  url: string;
  title?: string;
  sourceLabel: string;
  retrievedAt: string;
  origin: "mcp_attested" | "agent_supplied_unverified";
};
export type ProjectMemoryEvidence = {
  kind:
    | "user_message"
    | "run"
    | "task"
    | "subagent"
    | "commit"
    | "file"
    | "symbol"
    | "external_reference";
  sessionId?: string;
  runId?: string;
  userMessageId?: string;
  taskRef?: string;
  commitSha?: string;
  branch?: string;
  path?: string;
  symbol?: string;
  detached?: boolean;
  externalReference?: ProjectMemoryExternalReference;
};
export type ProjectMemoryRecord = {
  id: string;
  scope: ProjectMemoryScope;
  category: ProjectMemoryCategory;
  title: string;
  claim: string;
  status: ProjectMemoryStatus;
  verification: ProjectMemoryVerification;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  supersedesId?: string;
  evidence: ProjectMemoryEvidence[];
};
export type ProjectMemorySnapshot = {
  globalEnabled: boolean;
  projectEnabled: boolean;
  memories: ProjectMemoryRecord[];
};
export type ProjectMemoryDigest = { text: string; memoryIds: string[]; estimatedTokens: number };

export type AgentSessionInfo = {
  id: string;
  workspaceId: string;
  title: string;
  cwd: string;
  status: "starting" | AgentRunStatus | "idle" | "exited" | "error";
  runtime?: "pi-sdk" | "pi-rpc";
  model?: string;
  piSessionId?: string;
  piSessionFile?: string;
  parentSessionId?: string;
  subagentTask?: string;
  subagentType?: string;
  subagentReadOnly?: boolean;
  subagentWorktree?: SubagentWorktreeInfo;
  pinnedAt?: string;
  archivedAt?: string;
  /** Set only for an agent's hidden group room session (never listed as a chat). */
  kind?: "group_member";
  /** Set on an agent's 1:1 chat (A3): a normal chat in its group's Project. */
  agentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";

/* ── Agent harness classification and evidence ────────────────────────── */

export type BuiltinAgentRole =
  | "explore"
  | "librarian"
  | "oracle"
  | "reviewer"
  | "debugger"
  | "ui-ux";
export type HarnessTaskType = BuiltinAgentRole | "implementation" | "unknown";
export type HarnessComplexity = "simple" | "moderate" | "complex";
export type HarnessRisk = "low" | "medium" | "high";
export type VerificationEvidenceStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped"
  | "missing"
  | "unavailable"
  | "user_confirmed";
export type AutoQAStatus = VerificationEvidenceStatus | "not_required";
export type HarnessEvidenceRef = {
  id?: string;
  kind: string;
  status: VerificationEvidenceStatus;
  runId?: string;
  eventId?: string;
  revision?: string;
  paths?: string[];
  label: string;
  checkName?: HarnessTaskCheckKind;
};
export type HarnessQAResult = {
  required: boolean;
  status: AutoQAStatus;
  reasonCode: string;
  evidence: HarnessEvidenceRef[];
  sourceFingerprint?: string;
};
export type HarnessTaskClassification = {
  taskType: HarnessTaskType;
  complexity: HarnessComplexity;
  risk: HarnessRisk;
  confidence: "low" | "high";
  suggestedRole?: BuiltinAgentRole;
  reasons: string[];
};
export type HarnessTaskPhase =
  | "preflight"
  | "awaiting_user"
  | "planning"
  | "executing"
  | "verifying"
  | "terminal";
export type HarnessTaskVerificationStatus =
  | "not_required"
  | "pending"
  | "verified"
  | "user_confirmed"
  | "failed"
  | "unknown"
  | "blocked";
export type HarnessTaskCheckKind = "tests" | "typecheck" | "lint" | "build";
export type HarnessTaskCriterionState = {
  criterionId: string;
  source: "plan" | "check";
  status: "pending" | "verified" | "failed" | "unknown" | "blocked" | "user_confirmed";
  evidenceEventIds: string[];
  requiredCheckKinds?: HarnessTaskCheckKind[];
};
export type HarnessTaskEvidenceRef = {
  eventId: string;
  kind: "check" | "user_confirmation";
  status: VerificationEvidenceStatus;
  revision?: string;
  criterionId?: string;
};
export type HarnessTaskState = {
  version: 1;
  sessionId: string;
  runId: string;
  workspaceId: string;
  goalMessageId: string;
  planId?: string;
  planFingerprint?: string;
  classification: HarnessTaskClassification;
  phase: HarnessTaskPhase;
  verificationStatus: HarnessTaskVerificationStatus;
  criteria: HarnessTaskCriterionState[];
  constraintRefs: string[];
  openQuestionRefs: string[];
  todoIds: string[];
  hypothesisRefs: string[];
  evidenceRefs: HarnessTaskEvidenceRef[];
  revision?: string;
  updatedAt: string;
};
export type HarnessTaskStateSeed = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  goalMessageId: string;
  classification: HarnessTaskClassification;
  requiredChecks: HarnessTaskCheckKind[];
  /** Source IDs are in-memory inputs only; the initializer emits opaque ordinal aliases. */
  todoIds: string[];
  /** Plan content/IDs are read in memory for projection only, never copied to Task State. */
  plan?: Pick<PlanRef, "id" | "sessionId" | "workspaceId" | "spec" | "todos" | "hash">;
  revision?: string;
};
export type HarnessRouteEvent = {
  type: "harness.route";
  sessionId: string;
  runId: string;
  taskType: HarnessTaskType;
  selectedRole?: BuiltinAgentRole;
  reasonCodes: string[];
};
export type TaskClassificationInput = {
  text: string;
  mode: "build" | "plan" | "spec";
  contextPaths: string[];
  changedPaths: string[];
  hasDestructiveAction?: boolean;
};

/* ── Adaptive intelligence (Meta Controller decision layer) ───────────── */

export type AdaptiveDecisionAction =
  | "retrieve_local"
  | "suggest_plan"
  | "suggest_oracle"
  | "spawn_readonly_specialist"
  | "mcp_preflight"
  | "verify"
  | "replan"
  | "ask_user"
  | "execute"
  | "finish"
  | "avoid_retry";

export type AdaptiveDecisionMode = "shadow" | "advisory" | "active";

export type AdaptiveFailureAttemptStatus =
  | "tested"
  | "failed"
  | "discarded"
  | "supported"
  | "unknown";

export type AdaptiveFailureAttempt = {
  id: string;
  sessionId: string;
  runId: string;
  strategyCode: string;
  hypothesisCode?: string;
  status: AdaptiveFailureAttemptStatus;
  reasonCode: string;
  revision?: string;
  evidenceEventIds: string[];
  createdAt: string;
};

export type ProjectImpactConfidence = "low" | "medium" | "high" | "unknown";

export type ProjectImpactEstimate = {
  revision?: string;
  blastRadius: "none" | "local" | "module" | "cross_module" | "unknown";
  impactedPathCount: number;
  confidence: ProjectImpactConfidence;
  unknownReasons: string[];
  reasonCodes: string[];
};

export type AdaptiveVerificationLevel = "none" | "light" | "standard" | "strict";

export type AdaptiveExecutionPolicy = {
  version: 1;
  verificationLevel: AdaptiveVerificationLevel;
  suggestHyperPlan: boolean;
  suggestedRole?: BuiltinAgentRole;
  maxParallelChildren: number;
  preferredModelId?: string;
  reasonCodes: string[];
};

/** Allowlisted strategy labels for Failure Intelligence + Meta Controller (Gap 5). */
export type ChangeStrategyCode =
  | "same_edit_retry"
  | "blind_retry"
  | "narrow_fix"
  | "expand_tests"
  | "retrieve_then_edit"
  | "replan_scope"
  | "ask_clarification";

export type ChangeStrategyPlan = {
  version: 1;
  avoided: ChangeStrategyCode[];
  recommended: ChangeStrategyCode | "none";
  oracleConsulted: boolean;
  reasonCodes: string[];
};

export type AdaptiveDecision = {
  version: 1;
  action: AdaptiveDecisionAction;
  reasonCodes: string[];
  confidence: "low" | "medium" | "high";
  expectedUncertaintyReduction: number;
  verificationLevel: AdaptiveVerificationLevel;
  budgetTokens: number;
  mode: AdaptiveDecisionMode;
  policy: AdaptiveExecutionPolicy;
  avoidStrategyCodes: string[];
  /** Builtin read-only specialist for safe auto-dispatch (Gap 1). */
  specialistRole?: BuiltinAgentRole;
  /** Recommended next strategy after Failure Intelligence / Oracle (Gap 5). */
  changeStrategy?: ChangeStrategyPlan;
};

/** Verdict produced by the Phase 5 failure-loop guard (repeat guards / circuit breaker). */
export type AdaptiveFailureLoopAction = {
  action: "change_strategy" | "delegate" | "consult_oracle" | "circuit_break";
  reasonCodes: string[];
  reason?: string | undefined;
  suggestion?: string | undefined;
  task?: string | undefined;
  role?: "debugger" | "explore" | "oracle" | undefined;
};

export type AdaptiveDecisionSnapshot = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  mode: "build" | "plan" | "spec";
  classification: HarnessTaskClassification;
  taskState?: Pick<
    HarnessTaskState,
    "phase" | "verificationStatus" | "criteria" | "openQuestionRefs" | "hypothesisRefs"
  >;
  qaStatus?: AutoQAStatus;
  failureAttempts: AdaptiveFailureAttempt[];
  impact?: ProjectImpactEstimate;
  remainingContinuationBudget: number;
  enabledModelIds: string[];
  decisionMode: AdaptiveDecisionMode;
  openQuestionCount: number;
  unresolvedCriterionCount: number;
  /** User-confirmed promoted learning policies for this workspace (Gap 4). */
  promotedPolicies?: HarnessPolicyDocument[];
  /** True after adaptive Oracle spawn join was attempted this run (Gap 5). */
  oracleConsulted?: boolean;
  /** True when a capped Oracle findings digest is available (Gap 5). */
  oracleDigestPresent?: boolean;
  /** Phase 5 repeat-guard verdict for this decision (post_failure boundary only). */
  failureLoopAction?: AdaptiveFailureLoopAction | undefined;
};

export type ContextUncertaintyCandidate = {
  id: string;
  sourceId: string;
  trust: "local-memory" | "code-map" | "external-reference" | "git" | "plan" | "docs";
  estimatedTokens: number;
  addressesCriterionIds: string[];
  addressesOpenQuestionIds: string[];
  freshnessScore: number;
  relevanceScore: number;
};

export type ContextUncertaintyScore = {
  id: string;
  sourceId: string;
  score: number;
  expectedUncertaintyReduction: number;
  reasons: string[];
};

export type SubagentWorktreeInfo = {
  path: string;
  branch: string;
  baseSha: string;
  integrationStatus: "running" | "ready" | "no_changes" | "applied" | "conflict" | "cleaned";
  changedFiles?: string[];
  conflictFiles?: string[];
};

export type PromptDelivery = "normal" | "steer" | "follow-up";

/** Image attached to a prompt. `data` is the base64 payload (no data: prefix). */
export type PromptImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
  /** Original file name, shown in the timeline chip. */
  name?: string | undefined;
};

export type ContextUsageInfo = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

/** Why PI started/finished an auto or manual compaction (authoritative from the SDK). */
export type CompactionReason = "manual" | "threshold" | "overflow";

export type AgentRunInfo = {
  id: string;
  sessionId: string;
  userMessageId?: string;
  prompt: string;
  status: AgentRunStatus;
  model?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
};

/**
 * A point-in-time snapshot of the session's working tree, taken before each
 * run so any agent change can be rolled back from the timeline.
 */
