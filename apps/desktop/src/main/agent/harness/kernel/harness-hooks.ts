import type { ContextItem, HarnessTaskClassification } from "../../../../shared/contracts";
import type { IntentGateResult } from "../intent-gate";

export type HarnessPhase =
  | "turn_start"
  | "tool_call"
  | "tool_result"
  | "context_resolve"
  | "prompt_build"
  | "model_select"
  | "tools_register"
  | "verification_check"
  | "turn_settle"
  | "compact_prune";

export type HarnessContext = {
  sessionId: string;
  runId: string;
  /** Session lifetime identity used to reject work from a released incarnation. */
  sessionToken?: symbol | undefined;
  /** False after the session or run that owns this hook execution is no longer current. */
  isCurrent?: (() => boolean) | undefined;
  workspaceId?: string | undefined;
  cwd?: string | undefined;
  mode: "build" | "plan" | "spec";
  state: Map<string, any>;
  startedAt?: number | undefined;
};

export type HarnessHook<TInput = any, TOutput = any> = {
  name: string;
  phase: HarnessPhase;
  priority: number; // Lower executes first (e.g., 10 before 50)
  dependsOn?: string[] | undefined;
  isCritical?: boolean | undefined; // If true, throwing stops phase execution; if false, degrades gracefully
  execute: (input: TInput, context: HarnessContext) => Promise<TOutput> | TOutput;
};

/* Phase 1: turn_start */
export type TurnStartInput = {
  message?: string | undefined;
  userPrompt?: string | undefined;
  sessionId?: string | undefined;
  context?: ContextItem[] | undefined;
  contextPaths?: string[] | undefined;
  mode?: "build" | "plan" | "spec" | undefined;
  branch?: string | undefined;
};

export type TurnStartOutput = {
  proceed: boolean;
  abortReason?: string | undefined;
  classification?: HarnessTaskClassification | undefined;
  gateResult?: IntentGateResult | undefined;
  effectiveMessage?: string | undefined;
};

/* Pi SDK tool execution phases */
export type ToolCallInput = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ToolCallOutput = ToolCallInput & {
  repeatGuardDecision?: import("../guards/repeat-tool-guard").RepeatGuardDecision | undefined;
};

export type ToolResultInput = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  outcome: "success" | "failed" | "cancelled";
  resultFingerprint: string;
  progressFingerprint: string;
};

export type ToolResultOutput = ToolResultInput;

/* Phase 2: context_resolve */
export type ContextResolveInput = {
  sessionId?: string | undefined;
  runId?: string | undefined;
  candidates?:
    | Array<{
        id: string;
        type?: string | undefined;
        path?: string | undefined;
        score?: number | undefined;
        tokens?: number | undefined;
        tokenCost?: number | undefined;
        trust?: string | undefined;
        label?: string | undefined;
        uncertaintyReduction?: number | undefined;
      }>
    | undefined;
  tokenBudget?: number | undefined;
  paths?: string[] | undefined;
  symbols?: string[] | undefined;
  userQuery?: string | undefined;
};

export type ContextResolveOutput = {
  selectedCandidates: Array<{
    id: string;
    score: number;
    tokens: number;
  }>;
  candidates?:
    | Array<{
        id: string;
        score: number;
        tokens: number;
      }>
    | undefined;
  totalTokens: number;
  prunedCount: number;
};

/* Phase 3: prompt_build */
export type PromptBuildInput = {
  basePrompt: string;
  systemSections?:
    | Array<{
        id: string;
        priority?: number | undefined;
        content: string;
        volatile?: boolean | undefined;
      }>
    | undefined;
};

export type PromptBuildOutput = {
  finalSystemPrompt: string;
  activePromptSections: Array<{
    id: string;
    content: string;
    volatile: boolean;
  }>;
};

/* Phase 4: model_select */
export type ModelSelectInput = {
  requestedModel?: string | undefined;
  requestedThinking?: number | undefined;
  taskComplexity?: "low" | "medium" | "high" | undefined;
  taskClassification?: any;
};

export type ModelSelectOutput = {
  selectedModel: string;
  effectiveModel?: string | undefined;
  thinkingBudget: number;
  provider?: string | undefined;
  thinkingLevel?: "low" | "medium" | "high" | undefined;
  maxTokens?: number | undefined;
};

/* Phase 5: tools_register */
export type ToolsRegisterInput = {
  requestedTools?: string[] | undefined;
  sessionProfile?: "build" | "plan" | "spec" | undefined;
  activeSpillThresholdBytes?: number | undefined;
  permissions?: string[] | undefined;
  availableTools?: string[] | undefined;
};

export type ToolsRegisterOutput = {
  registeredTools: string[];
  enabledTools?: string[] | undefined;
  spillThresholdBytes: number;
  spillPolicies?: Record<string, { spillThresholdBytes?: number | undefined }> | undefined;
};

/* Phase 6: verification_check */
export type VerificationCheckInput = {
  runId: string;
  commandExecuted?: string | undefined;
  exitCode?: number | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  toolExecutions?: any[] | undefined;
};

export type VerificationCheckOutput = {
  verified: boolean;
  failureReason?: string | undefined;
  suggestedAction?: "retry" | "replan" | "proceed" | undefined;
  checksRun?: number | undefined;
  allPassed?: boolean | undefined;
  violations?: string[] | undefined;
  evidenceRef?: string | undefined;
};

/* Phase 7: turn_settle */
export type TurnSettleInput = {
  runId: string;
  completed: boolean;
  outcome?: "completed" | "failed" | "blocked" | "cancelled" | "interrupted" | undefined;
  hasAssistantResponse?: boolean | undefined;
  hasActiveTodos: boolean;
  turnTokens: number;
  providerTokenUsage?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
      }
    | undefined;
};

export type TurnSettleOutput = {
  settled: boolean;
  triggerContinuation: boolean;
  shouldContinue?: boolean | undefined;
  continuationPrompt?: string | undefined;
  taskComplete?: boolean | undefined;
};

/* Phase 8: compact_prune */
export type CompactPruneInput = {
  currentTokens: number;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "tool" | "system";
    content: string | Array<{ type: string; text?: string; [key: string]: any }>;
    toolName?: string | undefined;
    timestamp?: number | undefined;
  }>;
  modelId?: string | undefined;
  baseSummary?: string | undefined;
  evidence?: any[] | undefined;
};

export type CompactPruneOutput = {
  shouldCancelCompaction: boolean;
  reason: "under_threshold" | "headroom_restored_via_pruning" | "compaction_required";
  savedTokens: number;
  savedBytes: number;
  prunedCount: number;
  remainingTokens: number;
  enhancedSummary?: string | undefined;
};

export type HookExecutionRecord = {
  hookName: string;
  phase: HarnessPhase;
  durationMs: number;
  success: boolean;
  error?: string | undefined;
};
