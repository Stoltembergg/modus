import type { HarnessMetrics, SessionHarnessMetrics } from "./harness-metrics";

/**
 * MetricsExporter
 * Generates JSON and CSV export artifacts for analysis, telemetry archives,
 * and reporting dashboards.
 */
export class MetricsExporter {
  static exportJSON(metrics: HarnessMetrics, pretty: boolean = true): string {
    return JSON.stringify(metrics, null, pretty ? 2 : undefined);
  }

  static exportSessionsCSV(sessions: SessionHarnessMetrics[]): string {
    const headers = [
      "sessionId",
      "turnCount",
      "totalDurationMs",
      "durationReports",
      "completedDurationMs",
      "completedDurationReports",
      "failedDurationMs",
      "failedDurationReports",
      "blockedDurationMs",
      "blockedDurationReports",
      "cancelledDurationMs",
      "cancelledDurationReports",
      "interruptedDurationMs",
      "interruptedDurationReports",
      "noResponseDurationMs",
      "noResponseDurationReports",
      "estimatedTokensSaved",
      "spilledResults",
      "hookExecutions",
      "guardBlocks",
      "policyEvaluations",
      "policyViolations",
      "lastActiveTimestamp",
    ];

    const rows = sessions.map((s) => [
      `"${s.sessionId}"`,
      s.turnCount,
      s.totalDurationMs,
      s.durationReports,
      s.durationMsByOutcome.completed,
      s.durationReportsByOutcome.completed,
      s.durationMsByOutcome.failed,
      s.durationReportsByOutcome.failed,
      s.durationMsByOutcome.blocked,
      s.durationReportsByOutcome.blocked,
      s.durationMsByOutcome.cancelled,
      s.durationReportsByOutcome.cancelled,
      s.durationMsByOutcome.interrupted,
      s.durationReportsByOutcome.interrupted,
      s.noResponseDurationMs,
      s.noResponseDurationReports,
      s.estimatedTokensSaved,
      s.spilledResults,
      s.hookExecutions,
      s.guardBlocks,
      s.policyEvaluations,
      s.policyViolations,
      s.lastActiveTimestamp,
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }

  static exportSummaryCSV(metrics: HarnessMetrics): string {
    const rows = [
      ["Category", "Metric", "Value"],
      ["turns", "completed", metrics.turns.completed],
      ["turns", "failed", metrics.turns.failed],
      ["turns", "blocked", metrics.turns.blocked],
      ["turns", "cancelled", metrics.turns.cancelled],
      ["turns", "interrupted", metrics.turns.interrupted],
      ["turns", "noResponse", metrics.turns.noResponse],
      ["turns", "totalDurationMs", metrics.turns.totalDurationMs],
      ["turns", "durationReports", metrics.turns.durationReports],
      ["turns", "completedDurationMs", metrics.turns.durationMsByOutcome.completed],
      ["turns", "completedDurationReports", metrics.turns.durationReportsByOutcome.completed],
      ["turns", "failedDurationMs", metrics.turns.durationMsByOutcome.failed],
      ["turns", "failedDurationReports", metrics.turns.durationReportsByOutcome.failed],
      ["turns", "blockedDurationMs", metrics.turns.durationMsByOutcome.blocked],
      ["turns", "blockedDurationReports", metrics.turns.durationReportsByOutcome.blocked],
      ["turns", "cancelledDurationMs", metrics.turns.durationMsByOutcome.cancelled],
      ["turns", "cancelledDurationReports", metrics.turns.durationReportsByOutcome.cancelled],
      ["turns", "interruptedDurationMs", metrics.turns.durationMsByOutcome.interrupted],
      ["turns", "interruptedDurationReports", metrics.turns.durationReportsByOutcome.interrupted],
      ["turns", "noResponseDurationMs", metrics.turns.noResponseDurationMs],
      ["turns", "noResponseDurationReports", metrics.turns.noResponseDurationReports],
      ["turns", "providerUsageReports", metrics.turns.providerUsageReports],
      ["turns", "providerTotalTokens", metrics.turns.providerTotalTokens],
      [
        "promptSections",
        "estimatedTokensSaved",
        metrics.promptSections.estimatedTokensSaved ?? "unavailable",
      ],
      ["promptSections", "skippedSections", metrics.promptSections.skippedSections],
      ["promptSections", "totalSectionsSent", metrics.promptSections.totalSectionsSent],
      ["toolResults", "spilledResults", metrics.toolResults.spilledResults],
      ["toolResults", "successfulRetrievals", metrics.toolResults.successfulRetrievals],
      [
        "toolResults",
        "successfulRetrievalLatencyMs",
        metrics.toolResults.retrievalLatency?.toFixed(2) ?? "unavailable",
      ],
      ["toolResults", "spilledBytes", metrics.toolResults.spilledBytes],
      ["toolResults", "modelContextBytesReduced", metrics.toolResults.modelContextBytesReduced],
      ["toolResults", "estimatedTokensSaved", metrics.toolResults.estimatedTokensSaved],
      [
        "compaction",
        "frequencyReductionPercent",
        metrics.compaction.frequencyReductionPercent === null
          ? "unavailable"
          : `${metrics.compaction.frequencyReductionPercent}%`,
      ],
      ["compaction", "pruningEvents", metrics.compaction.pruningEvents],
      ["compaction", "nativeCompactionsObserved", metrics.compaction.nativeCompactionsObserved],
      ["compaction", "totalPrunedBytes", metrics.compaction.totalPrunedBytes],
      [
        "compaction",
        "estimatedTokensSavedByPruning",
        metrics.compaction.estimatedTokensSavedByPruning,
      ],
      ["repeatGuards", "falsePositiveCount", metrics.repeatGuards.falsePositiveCount],
      ["repeatGuards", "blockedLoopCount", metrics.repeatGuards.blockedLoopCount],
      ["repeatGuards", "circuitBreakerTrips", metrics.repeatGuards.circuitBreakerTrips],
      ["response", "evaluatedCount", metrics.response.evaluatedCount],
      ["response", "violationsDetected", metrics.response.violationsDetected],
      [
        "performance",
        "averageHookDurationMs",
        metrics.performance.averageHookDurationMs?.toFixed(2) ?? "unavailable",
      ],
      [
        "performance",
        "p95HookDurationMs",
        metrics.performance.p95HookDurationMs?.toFixed(2) ?? "unavailable",
      ],
      [
        "performance",
        "sampledHookDurationTotalMs",
        metrics.performance.sampledHookDurationTotalMs?.toFixed(2) ?? "unavailable",
      ],
      ["performance", "sampledHookExecutionCount", metrics.performance.sampledHookExecutionCount],
      ["performance", "memoryGrowthPercent", `${metrics.performance.memoryGrowthPercent}%`],
    ];

    return rows.map((r) => r.join(",")).join("\n");
  }
}
