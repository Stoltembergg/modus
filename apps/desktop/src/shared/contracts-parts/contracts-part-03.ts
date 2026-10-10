import type {
  AdaptiveDecision,
  AdaptiveFailureAttempt,
  CompactionReason,
  ContextUsageInfo,
  HarnessQAResult,
  HarnessRouteEvent,
  HarnessTaskState,
  PromptDelivery,
  PromptImageAttachment,
} from "./contracts-part-01";
import type {
  AgentResponseModel,
  AgentRunTokenUsage,
  CheckpointInfo,
  CodeGraphDiscoveryHit,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  SessionRunStatus,
  SubagentActivity,
  SubagentStatus,
  TodoItem,
} from "./contracts-part-02";
import type { ContextItem, PermissionDecision } from "./contracts-part-04";
import type { MessageContextChip } from "./contracts-part-05";
import type { AgentReviewResult, PlanRef } from "./contracts-part-06";
import type { SkillSelection } from "./contracts-part-07";

/** Durable SQLite event position, used to merge history with live IPC safely. */
export type AgentEvent = AgentEventPayload & { eventCursor?: number };

type AgentEventPayload =
  | HarnessRouteEvent
  | { type: "harness.task_state"; sessionId: string; runId: string; state: HarnessTaskState }
  | {
      type: "harness.decision";
      sessionId: string;
      runId: string;
      decision: AdaptiveDecision;
      boundary: "pre_prompt" | "post_qa" | "post_failure" | "tool_guard";
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
      timedOut?: boolean;
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
  /** L2: the session switched branch while idle; the next run uses it. */
  | { type: "session.branch_changed"; sessionId: string; branch: string }
  | { type: "runtime.error"; sessionId: string; message: string };

export type TerminalStatus = "running" | "exited";

/** Who opened the terminal: an interactive user shell, or an agent-run command. */
export type TerminalOrigin = "user" | "agent";

export type TerminalInfo = {
  id: string;
  workspaceId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  /** "running" while the PTY is live; "exited" once the process ends. */
  status: TerminalStatus;
  /** Distinguishes user-opened shells from agent-run command terminals. */
  origin: TerminalOrigin;
  /** The command line an agent ran here (absent for interactive shells). */
  command?: string;
  /** Short label shown in the panel tab / tool cards. */
  title?: string;
  /** Modus agent session that spawned it, when origin === "agent". */
  sessionId?: string;
  /** Agent run that owns this process, when spawned during a run. */
  runId?: string;
  /** OS process id, once spawned. */
  pid?: number;
  /** Exit code, once status === "exited". */
  exitCode?: number;
  /** ISO timestamp when the terminal started. */
  startedAt: string;
  /** ISO timestamp when the process exited. */
  endedAt?: string;
};

export type TerminalEvent =
  | { type: "terminal.created"; terminal: TerminalInfo }
  | { type: "terminal.data"; terminalId: string; data: string }
  | {
      type: "terminal.exit";
      terminalId: string;
      exitCode: number;
      signal?: number;
    };

/**
 * Unified "managed process" — the single source of truth that backs both the
 * composer running-process bar and the right-panel terminal grouping. A managed
 * process is either a PTY-backed terminal or a detached GUI app, opened by a
 * user or an agent. Both UIs render the same shape and filter it by scope, so a
 * new process kind only needs a mapper to appear everywhere.
 */
export type ManagedProcessKind = "terminal" | "app";
export type ManagedProcessOrigin = TerminalOrigin;
export type ManagedProcessStatus = TerminalStatus;

export type ManagedProcessInfo = {
  id: string;
  kind: ManagedProcessKind;
  origin: ManagedProcessOrigin;
  /** Workspace that owns the process (always set for user terminals). */
  workspaceId?: string;
  /** Agent session that started it; the isolation key for agent processes. */
  sessionId?: string;
  /** Agent run that started it; used to stop only work owned by that run. */
  runId?: string;
  /** Human-readable label: the agent command, app name, or shell name. */
  label: string;
  status: ManagedProcessStatus;
  /** ISO timestamp when the process started; drives the elapsed timer. */
  startedAt: string;
  pid?: number;
  /** Window title for GUI apps. */
  windowTitle?: string;
  exitCode?: number;
};

export type FileChange = {
  path: string;
  status: string;
  staged?: boolean;
  unstaged?: boolean;
  untracked?: boolean;
  renamedFrom?: string;
};

export type ReviewFile = FileChange & {
  added: number;
  removed: number;
  binary: boolean;
};

export type DiffMode = "unstaged" | "staged" | "working-state";

/** Authoritative comparison selected by the Git review panel. */
export type DiffTarget =
  | { type: "unstaged" }
  | { type: "staged" }
  | { type: "commit"; commit: string }
  | { type: "branch"; base?: string }
  | { type: "last-turn"; sessionId: string };

/** Per-file line counters for change summaries (turn cards / composer strip). */
export type FileChangeStat = {
  path: string;
  /** Lines added ("+" side). 0 for binary files. */
  added: number;
  /** Lines removed ("-" side). 0 for binary files. */
  removed: number;
  /** True for files git does not track yet (counts come from the file body). */
  untracked: boolean;
  /** True when either side of the diff is binary (counters are 0). */
  binary: boolean;
};

/**
 * Aggregated change summary — used for the working tree (composer strip,
 * apply review) and for a single completed turn (timeline changes card).
 */
export type WorkingChangeStats = {
  files: FileChangeStat[];
  /** Total lines added across files. */
  added: number;
  /** Total lines removed across files. */
  removed: number;
  fileCount: number;
  /** True when the file list was capped for IPC size. */
  truncated: boolean;
};

export type DiffTotals = {
  added: number;
  removed: number;
  fileCount: number;
};
