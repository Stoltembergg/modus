/**
 * Unified Harness Metrics and Observability Types
 * Adheres strictly to the specification in REVISAO-SUMARIO.md and REVIEW.md.
 */

export type PromptSectionsMetrics = {
  tokensSaved: number;
  skippedSections: number;
  totalSectionsSent: number;
};

export type ToolResultsMetrics = {
  spilledResults: number;
  retrievalLatency: number;
  spilledBytes: number;
};

export type CompactionMetrics = {
  frequencyReductionPercent: number;
  totalPrunedBytes: number;
  compactionEvents: number;
  estimatedTokensSavedByPruning: number;
};

export type RepeatGuardsMetrics = {
  falsePositiveCount: number;
  blockedLoopCount: number;
  circuitBreakerTrips: number;
};

export type ResponsePolicyMetrics = {
  criticalSectionsOmitted: number;
  violationsDetected: number;
  charactersSaved: number;
  formattedCount: number;
};

export type PerformanceMetrics = {
  hookSystemOverheadMs: number;
  memoryGrowthPercent: number;
  totalHookExecutions: number;
  averageHookDurationMs: number;
  p95HookDurationMs: number;
};

export type PluginTracingMetrics = {
  totalExecutions: number;
  failureCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  p95DurationMs: number;
  activePluginCount: number;
};

/**
 * Canonical HarnessMetrics interface defined in REVISAO-SUMARIO.md
 */
export type HarnessMetrics = {
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
  tokensSaved: number;
  spilledResults: number;
  hookExecutions: number;
  guardBlocks: number;
  policyViolations: number;
  lastActiveTimestamp: number;
};

export type TelemetryEventType =
  | "harness.hook.executed"
  | "harness.tool.spilled"
  | "harness.tool.retrieved"
  | "harness.compaction.pruned"
  | "harness.prompt.compiled"
  | "harness.guard.tripped"
  | "harness.response.formatted"
  | "harness.gate.evaluated"
  | "harness.plugin.executed"
  | "harness.plugin.failed";

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
