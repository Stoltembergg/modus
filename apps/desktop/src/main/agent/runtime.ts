import type { BrowserWindow as BrowserWindowType } from "electron";
import type {
  AgentEvent,
  AgentMode,
  AgentRunInfo,
  AgentSessionInfo,
  CodeGraphDiscoveryRef,
  ContextItem,
  ModelInfo,
  ProjectMemoryCategory,
  PromptDelivery,
  PromptImageAttachment,
  SkillSelection,
  ThinkingLevel,
} from "../../shared/contracts";
import type { HyperPlanDraftOwnerEpoch } from "./harness/hyperplan-draft-store";

export type CreateAgentRuntimeInput = {
  id?: string;
  workspaceId: string;
  cwd: string;
  title: string;
  model?: string;
  parentSessionId?: string;
  subagentTask?: string;
  subagentType?: string;
  subagentReadOnly?: boolean;
  subagentWorktree?: AgentSessionInfo["subagentWorktree"];
};

export type PromptAgentInput = {
  sessionId: string;
  message: string;
  context: ContextItem[];
  delivery?: PromptDelivery;
  userMessageId?: string;
  attachments?: PromptImageAttachment[];
  /** Skills explicitly selected with `/name` in the composer for this prompt. */
  skills?: SkillSelection[];
  /** Execution mode for this turn. Defaults to `build`. */
  mode?: AgentMode;
  /**
   * Model + thinking for THIS turn. The composer's current selection travels with
   * every prompt and is applied authoritatively at turn start, so a turn is
   * self-describing and never runs with stale model/thinking — surviving
   * mid-session switches, rollback/edit-resend, and session resume without
   * relying on session-state plumbing. Omitted ⇒ keep the session's current model.
   */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingVariant?: string;
  /** Set when this prompt is a "Build this plan" action; binds the turn to the plan. */
  planId?: string;
};

export type HyperPlanBuildStart = {
  sessionId: string;
  planId: string;
  planFingerprint: string;
  runId: string;
};

export type HyperPlanBuildStartInput = {
  ownerId: number;
  ownerEpoch?: HyperPlanDraftOwnerEpoch;
  requestId: string;
  sessionId: string;
  planId: string;
  planFingerprint: string;
  idempotencyKey: string;
  selectionId?: string;
  existingRunId?: string;
  onRunCreated: (runId: string) => void;
};

/**
 * How a `prompt()` turn ended, for programmatic callers (the group runtime).
 * - `ok`: the turn completed; `finalText` is the run's last assistant text (if any).
 * - `failed`: the run failed (model error, no output, setup failure).
 * - `aborted`: the run was cancelled/stopped (or rolled back).
 * - `blocked`: the turn stopped waiting on the user: the intent gate did not
 *   get its confirmation, or a HyperPlan choice is pending after the turn.
 * A prompt that throws never produces a result; callers treat it as `failed`.
 */
export type PromptTurnOutcome = "ok" | "failed" | "aborted" | "blocked";
export type PromptTurnResult = { finalText?: string; outcome: PromptTurnOutcome };

/** A turn settled on a session, whoever started it (see `onTurnSettled`). */
export type TurnSettledEvent = {
  sessionId: string;
  /** `prompt`: any `prompt()` call; `plan-build`: a HyperPlan build started by the user. */
  origin: "prompt" | "plan-build";
  result: PromptTurnResult;
};

export type AgentRuntime = {
  create(window: BrowserWindowType, input: CreateAgentRuntimeInput): Promise<AgentSessionInfo>;
  ensure(window: BrowserWindowType, sessionId: string): Promise<AgentSessionInfo>;
  /** Additive result: existing callers may ignore it. */
  prompt(window: BrowserWindowType, input: PromptAgentInput): Promise<PromptTurnResult>;
  /** pi's own `isStreaming` for a live session (false when not loaded). */
  isSessionStreaming(sessionId: string): boolean;
  /** Observe every settled run-backed turn; returns an unsubscribe function. */
  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void;
  startPlanBuild(
    window: BrowserWindowType,
    input: HyperPlanBuildStartInput,
  ): Promise<HyperPlanBuildStart>;
  startOriginalPlanBuild(
    window: BrowserWindowType,
    input: HyperPlanBuildStartInput,
  ): Promise<HyperPlanBuildStart>;
  compact(window: BrowserWindowType, sessionId: string): Promise<void>;
  /** Spawn a child subagent and return immediately. Collect results with waitBackground. */
  runSubagent(
    window: BrowserWindowType,
    input: {
      parentSessionId: string;
      task: string;
      prompt: string;
      subagentType: string;
      subagent?: {
        name: string;
        body: string;
        model: string;
        readOnly: boolean;
        tools?: string[];
        disallowedTools?: string[];
        isolation?: "shared" | "worktree";
      };
    },
  ): Promise<{ session: AgentSessionInfo }>;
  /**
   * Block the current tool call until background subagents settle
   * or timeout — keeps the same agent turn open. Sole harvest path for task().
   */
  waitBackground(input: {
    sessionId: string;
    timeoutMs: number;
    subagentIds?: string[];
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
  }): Promise<BackgroundWaitResult>;
  abort(sessionId: string): Promise<void>;
  listRuns(sessionId: string): Promise<AgentRunInfo[]>;
  dispose(sessionId: string): Promise<void>;
  /**
   * Drop this session's in-memory SDK runtime without aborting descendants or
   * rewriting DB status. Pane unmount / idle eviction — not delete/rollback.
   */
  releaseRuntime(sessionId: string): Promise<void>;
  setModel(
    window: BrowserWindowType,
    sessionId: string,
    model: string,
    thinkingVariant?: string,
  ): Promise<AgentSessionInfo>;
  cycleModel(
    window: BrowserWindowType | undefined,
    sessionId: string | undefined,
    direction?: "forward" | "backward",
  ): Promise<ModelInfo>;
  /**
   * True while any agent turn (including subagents and compaction) is starting or
   * running in this process. In-memory only: DB run rows can be stale after a crash.
   */
  hasActiveTurns(): boolean;
};

export type BackgroundWaitResult = {
  waitedMs: number;
  timedOut: boolean;
  subagents: Array<{
    id: string;
    task: string;
    status: "running" | "completed" | "error" | "missing";
    output?: string;
    memoryCandidates?: WaitMemoryCandidateSummary[];
    discoveries?: Array<CodeGraphDiscoveryRef & { provisional?: true }>;
  }>;
};

export type WaitMemoryCandidateSummary = {
  id: string;
  category: ProjectMemoryCategory;
  claim: string;
};

export type EmitAgentEvent = (event: AgentEvent) => void;
