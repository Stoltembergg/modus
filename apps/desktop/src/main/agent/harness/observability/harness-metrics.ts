/**
 * Unified Harness Metrics and Observability Types
 * Adheres strictly to the specification in REVISAO-SUMARIO.md and REVIEW.md.
 */

export type PromptSectionsMetrics = {
  estimatedTokensSaved: number | null;
  skippedSections: number;
  totalSectionsSent: number;
};

export type ToolResultsMetrics = {
  spilledResults: number;
  /** Count of successful bounded recoveries represented by retrievalLatency. */
  successfulRetrievals: number;
  retrievalLatency: number | null;
  spilledBytes: number;
  modelContextBytesReduced: number;
  estimatedTokensSaved: number;
};

export type CompactionMetrics = {
  /** Not measurable without an observable native-compaction demand denominator. */
  frequencyReductionPercent: number | null;
  totalPrunedBytes: number;
  pruningEvents: number;
  nativeCompactionsObserved: number;
  estimatedTokensSavedByPruning: number;
};

export type RepeatGuardsMetrics = {
  /** False positives require external adjudication and are not inferred from blocks. */
  falsePositiveCount: null;
  blockedLoopCount: number;
  evaluatedToolCalls: number;
  circuitBreakerTrips: null;
};

export type ResponsePolicyMetrics = {
  evaluatedCount: number;
  violationsDetected: number;
};

export type TurnOutcome = "completed" | "failed" | "blocked" | "cancelled" | "interrupted";

export type TurnMetrics = {
  total: number;
  totalDurationMs: number;
  durationReports: number;
  durationMsByOutcome: Record<TurnOutcome, number>;
  durationReportsByOutcome: Record<TurnOutcome, number>;
  noResponseDurationMs: number;
  noResponseDurationReports: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  interrupted: number;
  noResponse: number;
  providerUsageReports: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  providerCacheReadTokens: number;
  providerCacheWriteTokens: number;
  providerTotalTokens: number;
};

export type PerformanceMetrics = {
  /** Sum of the most recent bounded hook-duration sample; null when empty. */
  sampledHookDurationTotalMs: number | null;
  memoryGrowthPercent: number;
  sampledHookExecutionCount: number;
  averageHookDurationMs: number | null;
  p95HookDurationMs: number | null;
};

export type PluginTracingMetrics = {
  totalExecutions: number;
  failureCount: number;
  cancellationCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  p95DurationMs: number;
  activePluginCount: number;
};

/**
 * Canonical HarnessMetrics interface defined in REVISAO-SUMARIO.md
 */
export type HarnessMetrics = {
  turns: TurnMetrics;
  promptSections: PromptSectionsMetrics;
  toolResults: ToolResultsMetrics;
  compaction: CompactionMetrics;
  repeatGuards: RepeatGuardsMetrics;
  response: ResponsePolicyMetrics;
  performance: PerformanceMetrics;
  plugins?: PluginTracingMetrics | undefined;
};

export type SessionHarnessMetrics = {
  sessionId: string;
  turnCount: number;
  totalDurationMs: number;
  durationReports: number;
  durationMsByOutcome: Record<TurnOutcome, number>;
  durationReportsByOutcome: Record<TurnOutcome, number>;
  noResponseDurationMs: number;
  noResponseDurationReports: number;
  estimatedTokensSaved: number;
  spilledResults: number;
  hookExecutions: number;
  guardBlocks: number;
  policyEvaluations: number;
  policyViolations: number;
  outcomes: Record<TurnOutcome, number>;
  noResponseCount: number;
  providerReportedTotalTokens: number;
  lastActiveTimestamp: number;
};

export type TelemetryEventType =
  | "harness.hook.executed"
  | "harness.tool.spilled"
  | "harness.tool.retrieved"
  | "harness.compaction.pruned"
  | "harness.compaction.native"
  | "harness.prompt.compiled"
  | "harness.guard.evaluated"
  | "harness.response.evaluated"
  | "harness.turn.settled"
  | "harness.gate.evaluated"
  | "harness.plugin.executed"
  | "harness.plugin.failed"
  | "harness.plugin.cancelled";

export type TelemetryEvent = {
  type: TelemetryEventType;
  timestamp: number;
  sessionId?: string;
  runId?: string;
  data: Record<string, any>;
};

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertRegression = {
  metric: string;
  severity: AlertSeverity;
  expected: string | number;
  actual: string | number;
  message: string;
  timestamp: number;
};

export type SystemHealthStatus = {
  status: "healthy" | "degraded" | "critical";
  alerts: AlertRegression[];
  uptimeSeconds: number;
  timestamp: number;
};
