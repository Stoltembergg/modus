/** Gap 4 contracts split part 2/7 — do not edit by hand */
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

/** Allowlisted promoted-learning effects only. Unknown ops rejected at parse time. */
export type HarnessPolicyEffect =
  | { op: "raise_min_verification"; level: "light" | "standard" | "strict" }
  | { op: "add_avoid_strategies"; codes: string[] }
  | { op: "prefer_retrieve_local"; bias: true }
  | { op: "cap_parallel_children"; max: 1 | 2 }
  | { op: "prefer_replan_on_qa_fail"; bias: true };

export type HarnessPolicyDocument = {
  version: 1;
  promotionId: string;
  insightId: string;
  kind: HarnessInsightKind;
  effects: HarnessPolicyEffect[];
  source: "promoted_insight";
  promotedAt: string;
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
