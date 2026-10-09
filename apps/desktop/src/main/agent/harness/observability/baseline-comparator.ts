import type { HarnessMetrics } from "./harness-metrics";

export type BaselineMetrics = {
  averageTokensPerTurn: number;
  averageTurnDurationMs: number;
  compactionRatePer100Turns: number;
  errorRatePercent: number;
};

export type PhaseDecision = {
  phase: number;
  name: string;
  verdict: "GO" | "NO-GO" | "WARN";
  target: string;
  achieved: string;
  notes: string;
};

export type BaselineComparisonResult = {
  overallVerdict: "GO" | "NO-GO" | "WARN";
  estimatedTokenEconomyPercent: number | null;
  latencyOverheadPercent: number | null;
  phaseDecisions: PhaseDecision[];
  recommendation: string;
};

export const DEFAULT_BASELINE_METRICS: BaselineMetrics = {
  averageTokensPerTurn: 4500,
  averageTurnDurationMs: 1200,
  compactionRatePer100Turns: 8.5,
  errorRatePercent: 2.1,
};

/**
 * BaselineComparator
 * Compares actual harness metrics with pre-harness baseline data,
 * evaluating the automated Go/No-Go Decision Matrix from REVISAO-SUMARIO.md.
 */
export class BaselineComparator {
  private baseline: BaselineMetrics;

  constructor(baseline: BaselineMetrics = DEFAULT_BASELINE_METRICS) {
    this.baseline = baseline;
  }

  evaluate(
    metrics: HarnessMetrics,
    totalTurns: number = metrics.turns.total,
  ): BaselineComparisonResult {
    const turns = Math.max(0, totalTurns);
    const phaseDecisions: PhaseDecision[] = [];

    // --- Phase 2: Prompt Token Savings ---
    // Target: Go > 30%, No-Go < 10%
    const totalBaselineTokens = this.baseline.averageTokensPerTurn * turns;
    const promptSavingTokens = metrics.promptSections.estimatedTokensSaved ?? 0;
    const promptSavingPercent =
      totalBaselineTokens > 0 ? (promptSavingTokens / totalBaselineTokens) * 100 : 0;

    const hasPromptEstimate = metrics.promptSections.estimatedTokensSaved !== null;
    let p2Verdict: "GO" | "NO-GO" | "WARN" = hasPromptEstimate ? "GO" : "WARN";
    if (hasPromptEstimate && promptSavingPercent < 10 && promptSavingTokens > 0) {
      p2Verdict = "NO-GO";
    } else if (hasPromptEstimate && promptSavingPercent < 30) {
      p2Verdict = "WARN";
    }

    phaseDecisions.push({
      phase: 2,
      name: "Prompt Registry & Cache Alignment",
      verdict: p2Verdict,
      target: "> 30% saving",
      achieved: hasPromptEstimate
        ? `${promptSavingPercent.toFixed(1)}% (${promptSavingTokens} estimated tokens)`
        : "unavailable",
      notes:
        p2Verdict === "GO"
          ? "Optimal prompt cache prefix and modular sections"
          : "Token economy below target",
    });

    // --- Phase 3: Tool Result Spill Overhead ---
    // Target: Go < 100ms, No-Go > 200ms
    const spillLatency = metrics.toolResults.retrievalLatency;
    let p3Verdict: "GO" | "NO-GO" | "WARN" = "WARN";
    if (spillLatency !== null) {
      p3Verdict = "GO";
      if (spillLatency > 200) p3Verdict = "NO-GO";
      else if (spillLatency > 100) p3Verdict = "WARN";
    }

    phaseDecisions.push({
      phase: 3,
      name: "Tool Result Policy & Spill Storage",
      verdict: p3Verdict,
      target: "< 100ms overhead",
      achieved: spillLatency === null ? "unavailable" : `${spillLatency.toFixed(1)}ms retrieval`,
      notes: `${metrics.toolResults.spilledResults} results spilled safely`,
    });

    // --- Phase 4: Compaction Reduction ---
    // Target: Go > 20%, No-Go < 10%
    const compactionReduction = metrics.compaction.frequencyReductionPercent;
    let p4Verdict: "GO" | "NO-GO" | "WARN" = "WARN";
    if (compactionReduction !== null) {
      p4Verdict = "GO";
      if (compactionReduction < 10 && metrics.compaction.pruningEvents > 0) p4Verdict = "NO-GO";
      else if (compactionReduction < 20 && metrics.compaction.pruningEvents > 0) p4Verdict = "WARN";
    }

    phaseDecisions.push({
      phase: 4,
      name: "Compaction Intelligent Pruning",
      verdict: p4Verdict,
      target: "> 20% reduction",
      achieved: compactionReduction === null ? "unavailable" : `${compactionReduction}% reduction`,
      notes: `${metrics.compaction.totalPrunedBytes} bytes pruned; ${metrics.compaction.nativeCompactionsObserved} native compactions observed. Avoided compactions cannot be inferred.`,
    });

    // --- Phase 5: Repeat Guards False Positive Rate ---
    // Target: Go < 5%, No-Go > 10%
    const totalBlocks = metrics.repeatGuards.blockedLoopCount;
    const fpCount = metrics.repeatGuards.falsePositiveCount;
    const fpRate = fpCount === null ? null : totalBlocks > 0 ? (fpCount / totalBlocks) * 100 : 0;

    let p5Verdict: "GO" | "NO-GO" | "WARN" = fpRate === null ? "WARN" : "GO";
    if (fpRate !== null && fpRate > 10) p5Verdict = "NO-GO";
    else if (fpRate !== null && fpRate > 5) p5Verdict = "WARN";

    phaseDecisions.push({
      phase: 5,
      name: "Repeat Guards & Circuit Breakers",
      verdict: p5Verdict,
      target: "< 5% false positive rate",
      achieved:
        fpRate === null ? "unavailable" : `${fpRate.toFixed(1)}% (${fpCount}/${totalBlocks})`,
      notes: `${totalBlocks} blocked loops across ${metrics.repeatGuards.evaluatedToolCalls} evaluated tool calls; false-positive adjudication and circuit-breaker trips are unavailable.`,
    });

    // --- Phase 6: Groups Mailbox & Concurrency ---
    // Generic Harness hook durations do not measure mailbox latency or contention.
    const p6Verdict: "WARN" = "WARN";
    phaseDecisions.push({
      phase: 6,
      name: "Groups Mailbox & Concurrency",
      verdict: p6Verdict,
      target: "< 100ms latency",
      achieved: "unavailable",
      notes: "No mailbox-specific latency or contention measurement is currently recorded.",
    });

    // --- Phase 7: Response Policy & Output Integrity ---
    // Policy violations are measured, but they are not a content-completeness score.
    const hasResponseEvaluations = metrics.response.evaluatedCount > 0;
    const p7Verdict: "WARN" = "WARN";

    phaseDecisions.push({
      phase: 7,
      name: "Response Policy & Output Integrity",
      verdict: p7Verdict,
      target: "Completed-response evaluations are attributable; output remains unchanged",
      achieved: hasResponseEvaluations
        ? `${metrics.response.evaluatedCount} evaluated responses; ${metrics.response.violationsDetected} policy violations`
        : "unavailable; no completed response was evaluated",
      notes:
        "ResponsePolicy is advisory and does not rewrite streamed output. Policy violations do not prove content completeness, so this phase is not scored as a quality pass.",
    });

    // Total Economy Estimate across Prompt, Spill, and Compaction
    const totalSavedTokens =
      (metrics.promptSections.estimatedTokensSaved ?? 0) +
      metrics.compaction.estimatedTokensSavedByPruning +
      metrics.toolResults.estimatedTokensSaved;

    const hasTokenSavingsMeasurement =
      metrics.promptSections.estimatedTokensSaved !== null ||
      metrics.compaction.pruningEvents > 0 ||
      metrics.toolResults.spilledResults > 0;
    const estimatedTokenEconomyPercent =
      totalBaselineTokens > 0 && hasTokenSavingsMeasurement
        ? Math.min(100, Math.round((totalSavedTokens / totalBaselineTokens) * 100))
        : null;

    // Hook durations are not attributable to complete turns in the aggregate
    // sample, so they cannot be compared honestly with the turn-duration baseline.
    const latencyOverheadPercent: number | null = null;

    const hasNoGo = phaseDecisions.some((d) => d.verdict === "NO-GO");
    const hasUnavailableMeasurements = phaseDecisions.some((d) => d.verdict === "WARN");
    const overallVerdict = hasNoGo ? "NO-GO" : hasUnavailableMeasurements ? "WARN" : "GO";

    const recommendation =
      overallVerdict === "GO"
        ? "All phase criteria satisfied. The Modus harness meets the production readiness thresholds."
        : overallVerdict === "NO-GO"
          ? "One or more phases failed the threshold gates. Review the failed phases before proceeding with broad rollout."
          : "Some production measurements are unavailable. Do not treat this comparison as a readiness approval.";

    return {
      overallVerdict,
      estimatedTokenEconomyPercent,
      latencyOverheadPercent,
      phaseDecisions,
      recommendation,
    };
  }
}
