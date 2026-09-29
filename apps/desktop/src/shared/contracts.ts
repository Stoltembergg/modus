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
  | "skipped"
  | "missing"
  | "unavailable"
  | "user_confirmed";
export type AutoQAStatus = VerificationEvidenceStatus | "not_required";
export type HarnessEvidenceRef = {
  id: string;
  kind: string;
  status: VerificationEvidenceStatus;
  runId?: string;
  eventId?: string;
  revision?: string;
  paths?: string[];
  label: string;
};
export type HarnessQAResult = {
  required: boolean;
  status: AutoQAStatus;
  reasonCode: string;
  evidence: HarnessEvidenceRef[];
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
export type CheckpointInfo = {
  id: string;
  sessionId: string;
  /** Run this checkpoint was taken for (absent for restore backups). */
  runId?: string;
  /** User message the checkpoint precedes — anchors the timeline UI. */
  userMessageId?: string;
  cwd: string;
  commitHash: string;
  /** Run boundary or restore safety snapshot. */
  kind: "auto" | "turn-end" | "restore-backup";
  createdAt: string;
};

/**
 * Result of `agent:rollback` — rewinding a session to just before one of its
 * user messages (Cursor-style "edit & resend"). Conversation history from that
 * message onward is removed and, when a pre-run snapshot exists, the working
 * tree is restored to the state captured before that message ran.
 */
export type AgentRollbackResult = {
  sessionId: string;
  /** The user message the session was rolled back to. */
  userMessageId: string;
  /** True when a pre-run snapshot existed and workspace files were restored. */
  filesRestored: boolean;
  /** The checkpoint used to restore files, when one existed. */
  checkpointId?: string;
  /** Number of runs removed from the session history. */
  removedRuns: number;
};

/* ── Agent to-dos (live task list, Cursor-style) ───────────────────────── */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked";

export type TodoItem = {
  /** Stable id within the session (assigned by the todo tool when omitted). */
  id: string;
  content: string;
  status: TodoStatus;
  /** Bounded explanation shown when a task is blocked on user input. */
  blockedReason?: string;
};

/* ── Project rules (AGENTS.md / .cursor/rules) ─────────────────────────── */

/** Which config family a detected rule file belongs to. */
export type RuleSource = "agents-md" | "claude-md" | "cursorrules" | "cursor-rule";

/** How a rule is applied (mirrors Cursor's .mdc semantics). */
export type RuleMode = "always" | "glob" | "intelligent" | "manual";

export type RuleFileInfo = {
  /** Absolute path of the rule file. */
  path: string;
  /** Path relative to the workspace root (display). */
  relPath: string;
  source: RuleSource;
  mode: RuleMode;
  description?: string;
  globs?: string;
  /** File size in bytes. */
  size: number;
};

/** Workspace AGENTS.md editor state for Settings → Rules. */
export type WorkspaceAgentsState = {
  path: string;
  relPath: "AGENTS.md";
  exists: boolean;
  content: string;
  example: string;
};

/* ── Global personalization (Codex-style AGENTS.md guidance) ───────────── */

export type PersonalizationState = {
  basePath: string;
  overridePath: string;
  activePath: string;
  overrideActive: boolean;
  content: string;
};

export type PermissionRequest = {
  id: string;
  sessionId?: string;
  runId?: string;
  action: PermissionAction;
  target: string;
  reason: string;
  severity?: "medium" | "high" | "danger";
};

/* ── Interactive questions (ask_user, Cursor-style) ────────────────────── */

export type QuestionOption = {
  /** Choice text shown on the option row and returned when selected. */
  label: string;
  /** Optional one-line clarifier under the label. */
  description?: string;
  /** Marks the planner's suggested default (rendered "— recommended"). */
  recommended?: boolean;
};

export type QuestionPrompt = {
  /** Stable id within the request (assigned by the ask_user tool). */
  id: string;
  /** The question itself, e.g. "Which rendering view?". */
  header: string;
  /** Optional context shown under the header. */
  detail?: string;
  /** true → multiple options may be chosen; false → single choice. */
  multiSelect: boolean;
  options: QuestionOption[];
};

export type QuestionRequest = {
  id: string;
  sessionId?: string;
  runId?: string;
  questions: QuestionPrompt[];
};

export type QuestionAnswer = {
  questionId: string;
  /** Labels of the chosen options (empty when only a custom answer was given). */
  selected: string[];
  /** Free-text "Other…" answer, when the user typed one. */
  custom?: string;
};

/** Resolution of an ask_user round-trip — answers, or `skipped` when dismissed. */
export type QuestionResponse = {
  requestId: string;
  answers: QuestionAnswer[];
  skipped: boolean;
};

/**
 * Authoritative run-status for a session, mirrored from the runtime's real
 * processing state (pi's streaming turn + its internal auto-retry). This — not
 * a reconstruction from the run-event log — is the single source of truth the
 * composer's lock/border follow. Aligned with opencode's SessionStatus:
 *
 * - `idle`  — no turn is processing; the composer accepts a new prompt.
 * - `busy`  — a turn is streaming; the composer is locked, border animates.
 * - `retry` — a transient error was hit and the runtime is auto-retrying. The
 *   turn is STILL working, so the composer stays locked; the UI shows a single
 *   non-fatal line ("retrying … attempt N/M") instead of a red error. Carries
 *   the authoritative `attempt`/`maxAttempts` from the runtime and `nextAt` for
 *   a live countdown.
 */
export type SessionRunStatus =
  | { type: "idle" }
  | { type: "busy" }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      message: string;
      /** Epoch ms when the next attempt fires, for a live countdown. */
      nextAt: number;
    };

export type SubagentActivity =
  | { kind: "tool"; name: string }
  | { kind: "thinking" }
  | { kind: "writing" };

export type SubagentStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";

export type AgentRunTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export type AgentResponseModel = {
  provider: string;
  model: string;
  responseModel?: string;
};

export type CodeGraphDiscoveryHit = {
  path: string;
  symbol?: string;
  line?: number;
  kind?: string;
};

export type CodeGraphDiscoveryRef = CodeGraphDiscoveryHit & { runId: string };

export type HarnessInsightKind =
  | "repeated_failures"
  | "same_path_rework"
  | "context_pressure"
  | "delegation_mismatch"
  | "missing_verification";
export type HarnessInsightConfidence = "low" | "medium" | "high";
export type HarnessInsightSourceRef = { runId: string; eventId?: string };
export type HarnessInsight = {
  id: string;
  kind: HarnessInsightKind;
  claim: string;
  recommendation: string;
  hypothesis: true;
  period: { since: string; until: string };
  sampleCount: number;
  confidence: HarnessInsightConfidence;
  limitations: string[];
  sourceRefs: HarnessInsightSourceRef[];
};
export type HarnessInsightsQuery = {
  workspaceId?: string;
  since: string;
  limit?: number;
};
export type HarnessInsightsResult = {
  workspaceId: string;
  period: { since: string; until: string };
  evidenceState: "known" | "unknown";
  sampleCount: number;
  limitations: string[];
  insights: HarnessInsight[];
};

/** Cross-session soft-discouraged strategy entry (TTL-bound; never a hard permanent block). */
export type FailureBlacklistEntry = {
  id: string;
  workspaceId: string;
  signature: string;
  strategyCode: string;
  hypothesisCode?: string;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status: "active" | "cleared" | "expired";
  sourceRunId?: string;
};

export type AgentEvent =
  | HarnessRouteEvent
  | { type: "harness.task_state"; sessionId: string; runId: string; state: HarnessTaskState }
  | {
      type: "harness.decision";
      sessionId: string;
      runId: string;
      decision: AdaptiveDecision;
      boundary: "pre_prompt" | "post_qa" | "post_failure";
    }
  | {
      type: "harness.failure";
      sessionId: string;
      runId: string;
      attempt: AdaptiveFailureAttempt;
    }
  | { type: "agent.started"; sessionId: string }
  | { type: "agent.ended"; sessionId: string }
  | {
      type: "run.started";
      sessionId: string;
      runId: string;
      userMessageId?: string;
      delivery: PromptDelivery;
    }
  | {
      type: "run.completed";
      sessionId: string;
      runId: string;
      summary?: string;
      /** What this turn changed on disk (vs the pre-run snapshot). */
      changes?: WorkingChangeStats;
      tokenUsage?: AgentRunTokenUsage;
      responseModel?: AgentResponseModel;
    }
  | {
      type: "run.failed";
      sessionId: string;
      runId: string;
      message: string;
      tokenUsage?: AgentRunTokenUsage;
      responseModel?: AgentResponseModel;
    }
  | { type: "run.blocked"; sessionId: string; runId: string; requestId: string; reason: string }
  | {
      type: "run.cancelled";
      sessionId: string;
      runId: string;
      tokenUsage?: AgentRunTokenUsage;
      responseModel?: AgentResponseModel;
    }
  | {
      type: "message.started";
      sessionId: string;
      messageId: string;
      role: "assistant" | "user";
      /** Images the user attached to this message (user role only). */
      attachments?: PromptImageAttachment[];
      /**
       * User only: context the prompt carried (file/element/browser/…), shown
       * as removable-looking chips in the message bubble so the sent context
       * stays visible after sending (Cursor parity).
       */
      contextChips?: MessageContextChip[];
      /** User only: original context items, used when edit-and-resend reopens the prompt. */
      contextItems?: ContextItem[];
      /** User only: skills explicitly selected for this prompt. */
      skills?: SkillSelection[];
      /**
       * User only: present when this message is a "Build this plan" action. The
       * timeline renders it as a compact Build card (title + N To-dos) instead
       * of the raw build instruction text.
       */
      planBuild?: { planId: string; title: string; todoCount: number };
    }
  | { type: "message.delta"; sessionId: string; messageId: string; delta: string }
  | { type: "message.completed"; sessionId: string; messageId: string }
  | { type: "thinking.delta"; sessionId: string; messageId: string; delta: string }
  | { type: "thinking.completed"; sessionId: string; messageId: string }
  | {
      type: "tool.started";
      sessionId: string;
      runId?: string;
      toolCallId: string;
      toolName: string;
      args?: unknown;
    }
  | {
      /**
       * Live, non-persisted progress for a tool call while the model is still
       * streaming its arguments (path first, then content). Carries the
       * best-effort partial args so the tool card renders immediately and its
       * diff +/- counts grow in real time — instead of appearing only once the
       * whole (possibly huge) call has been generated. Same shape as
       * `tool.started`; the durable `tool.started` supersedes it on completion.
       */
      type: "tool.delta";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args?: unknown;
    }
  | { type: "tool.output"; sessionId: string; toolCallId: string; output: string }
  | {
      type: "tool.ended";
      sessionId: string;
      runId?: string;
      toolCallId: string;
      toolName?: string;
      isError: boolean;
      exitCode?: number;
      aborted?: boolean;
      skipped?: boolean;
    }
  | { type: "permission.requested"; sessionId: string; request: PermissionRequest }
  | {
      type: "permission.resolved";
      sessionId: string;
      requestId: string;
      decision: PermissionDecision["decision"];
    }
  | { type: "question.requested"; sessionId: string; request: QuestionRequest }
  | {
      type: "question.resolved";
      sessionId: string;
      requestId: string;
      answers: QuestionAnswer[];
      skipped: boolean;
    }
  | { type: "queue.updated"; sessionId: string; steering: string[]; followUp: string[] }
  | { type: "compaction.started"; sessionId: string; reason: CompactionReason }
  | {
      type: "compaction.ended";
      sessionId: string;
      reason: CompactionReason;
      aborted: boolean;
      /** PI overflow recovery continues the same prompt; threshold does not. */
      willRetry: boolean;
      /** True when PI reported errorMessage (failed compact). */
      failed?: boolean;
      /** Error text, or a short preview of the compaction summary. */
      summary?: string;
    }
  | { type: "context.updated"; sessionId: string; usage: ContextUsageInfo }
  | { type: "review.started"; sessionId: string; reviewId: string }
  | { type: "review.completed"; sessionId: string; review: AgentReviewResult }
  | { type: "review.failed"; sessionId: string; reviewId: string; message: string }
  | { type: "plan.updated"; sessionId: string; plan: PlanRef; toolCallId?: string }
  | { type: "checkpoint.created"; sessionId: string; checkpoint: CheckpointInfo }
  | { type: "checkpoint.restored"; sessionId: string; checkpointId: string }
  | { type: "todos.updated"; sessionId: string; todos: TodoItem[] }
  | {
      type: "harness.continuation";
      sessionId: string;
      /** Original/root run whose single continuation budget this marker consumes. */
      runId: string;
      attempt: 1;
      reasonCode: "actionable_todos" | "missing_qa";
    }
  | { type: "harness.qa"; sessionId: string; runId: string; result: HarnessQAResult }
  | {
      type: "codegraph.discoveries";
      sessionId: string;
      runId: string;
      hits: CodeGraphDiscoveryHit[];
    }
  | {
      type: "subagent.started";
      sessionId: string;
      childSessionId: string;
      task: string;
      subagentType: string;
      model?: string;
    }
  | {
      type: "subagent.updated";
      sessionId: string;
      childSessionId: string;
      status: SubagentStatus;
      activity?: SubagentActivity;
    }
  | { type: "session.status"; sessionId: string; status: SessionRunStatus }
  | { type: "session.updated"; sessionId: string; title: string }
  | { type: "runtime.error"; sessionId: string; message: string };
