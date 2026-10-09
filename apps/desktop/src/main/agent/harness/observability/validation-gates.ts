import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from "../feature-flags";
import { CircuitBreakerRegistry } from "../guards";
import { ResponsePolicyRegistry } from "../response/response-registry";
import { SubagentProviderRegistry } from "../subagents/subagent-provider-registry";
import type { HarnessMetrics } from "./harness-metrics";
import { HarnessObserver } from "./harness-observer";

export type GateEvaluation = {
  gateName: string;
  passed: boolean;
  score: number | string;
  threshold: string;
  details: string;
};

export type ValidationGatesReport = {
  allGatesPassed: boolean;
  timestamp: number;
  gates: GateEvaluation[];
  rollbackRequired: boolean;
};

/**
 * ValidationGates
 * Evaluates the three formal production gates defined in AJUSTE 3 of the evolution review:
 * 1. Token Economy Gate (Economy >= 30%)
 * 2. Correctness Gate (0 critical sections dropped, false positive < 5%)
 * 3. Performance Gate (Avg hook latency <= 5ms, memory growth <= 50%)
 */
export class ValidationGates {
  /**
   * Evaluates all three gates against the provided metrics.
   */
  static evaluate(
    metrics: HarnessMetrics,
    options: {
      minTokenEconomyPercent?: number;
      maxAvgHookLatencyMs?: number;
      maxFalsePositivePercent?: number;
      maxMemoryGrowthPercent?: number;
      baselineTotalTokens?: number;
    } = {},
  ): ValidationGatesReport {
    const minTokenEconomy = options.minTokenEconomyPercent ?? 30;
    const maxAvgHookLatency = options.maxAvgHookLatencyMs ?? 5;
    const maxFalsePositive = options.maxFalsePositivePercent ?? 5;
    const maxMemoryGrowth = options.maxMemoryGrowthPercent ?? 50;

    const gates: GateEvaluation[] = [];

    // --- 1. Token Economy Gate ---
    const totalTokensSaved =
      metrics.promptSections.tokensSaved +
      metrics.compaction.estimatedTokensSavedByPruning +
      Math.floor(metrics.toolResults.spilledBytes / 4);

    const baselineTokens = options.baselineTotalTokens ?? 45000;
    const achievedEconomyPercent =
      baselineTokens > 0 ? Math.min(100, Math.round((totalTokensSaved / baselineTokens) * 100)) : 0;

    const economyPassed = achievedEconomyPercent >= minTokenEconomy;
    gates.push({
      gateName: "Token Economy Gate",
      passed: economyPassed,
      score: `${achievedEconomyPercent}%`,
      threshold: `>= ${minTokenEconomy}%`,
      details: `${totalTokensSaved} total tokens saved across prompt, compaction, and spill.`,
    });

    // --- 2. Correctness Gate ---
    const criticalOmitted = metrics.response.criticalSectionsOmitted;
    const totalBlocks = metrics.repeatGuards.blockedLoopCount;
    const fpCount = metrics.repeatGuards.falsePositiveCount;
    const fpRate = totalBlocks > 0 ? (fpCount / totalBlocks) * 100 : 0;

    const correctnessPassed = criticalOmitted === 0 && fpRate <= maxFalsePositive;
    gates.push({
      gateName: "Correctness Gate",
      passed: correctnessPassed,
      score: `Critical Omitted: ${criticalOmitted}, FP Rate: ${fpRate.toFixed(1)}%`,
      threshold: `Critical Omitted == 0 && FP Rate <= ${maxFalsePositive}%`,
      details:
        criticalOmitted === 0
          ? "All critical errors, blockers, and warnings preserved without omission."
          : `CRITICAL FAILURE: ${criticalOmitted} critical sections were omitted!`,
    });

    // --- 3. Performance Gate ---
    const avgHookLatency = metrics.performance.averageHookDurationMs;
    const memoryGrowth = metrics.performance.memoryGrowthPercent;

    const performancePassed =
      avgHookLatency <= maxAvgHookLatency && memoryGrowth <= maxMemoryGrowth;
    gates.push({
      gateName: "Performance Gate",
      passed: performancePassed,
      score: `Avg Latency: ${avgHookLatency.toFixed(2)}ms, Mem Growth: ${memoryGrowth}%`,
      threshold: `Avg Latency <= ${maxAvgHookLatency}ms && Mem Growth <= ${maxMemoryGrowth}%`,
      details: `Hook system overhead ${metrics.performance.hookSystemOverheadMs.toFixed(2)}ms across ${metrics.performance.totalHookExecutions} executions.`,
    });

    const allGatesPassed = gates.every((g) => g.passed);

    return {
      allGatesPassed,
      timestamp: Date.now(),
      gates,
      rollbackRequired: !allGatesPassed,
    };
  }
}

/**
 * RollbackCoordinator
 * Manages atomic emergency rollbacks of the harness system according to AJUSTE 3.
 * Safely resets feature flags, clears caches, and preserves data integrity.
 */
export class RollbackCoordinator {
  /**
   * Executes emergency rollback:
   * 1. Resets feature flags to safe baseline (disabling experimental features).
   * 2. Clears in-memory registries (circuit breakers, response policies).
   * 3. Resets observer telemetry.
   */
  static executeRollback(options: { keepKernel?: boolean } = {}): {
    success: boolean;
    actionsTaken: string[];
    timestamp: number;
  } {
    const actionsTaken: string[] = [];

    // 1. Reset feature flags
    if (options.keepKernel) {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_PROMPT_REGISTRY: false,
        MODUS_TOOL_RESULT_SPILL: false,
        MODUS_COMPACTION_PRUNING: false,
        MODUS_REPEAT_GUARDS: false,
        MODUS_GROUPS_MAILBOX: false,
        MODUS_RESPONSE_POLICY: false,
        MODUS_OBSERVABILITY: false,
      });
      actionsTaken.push("Feature flags reset to kernel-only baseline");
    } else {
      resetFeatureFlagOverrides();
      actionsTaken.push("All feature flag overrides cleared");
    }

    // 2. Clear subsystem registries
    try {
      CircuitBreakerRegistry.getInstance().clearAll();
      actionsTaken.push("Circuit breakers reset");
    } catch {
      // Ignored if not initialized
    }

    try {
      ResponsePolicyRegistry.resetInstance();
      actionsTaken.push("Response policy registry reset");
    } catch {
      // Ignored
    }

    try {
      SubagentProviderRegistry.resetInstance();
      actionsTaken.push("Subagent provider registry reset");
    } catch {
      // Ignored
    }

    // 3. Clear observer telemetry
    try {
      HarnessObserver.getInstance().clear();
      actionsTaken.push("Harness observer telemetry reset");
    } catch {
      // Ignored
    }

    return {
      success: true,
      actionsTaken,
      timestamp: Date.now(),
    };
  }
}
