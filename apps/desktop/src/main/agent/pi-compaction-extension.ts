import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  calculateCompactionMetrics,
  getCompactionPolicy,
} from "./harness/compaction/compaction-policy";
import {
  pruneDuplicateToolResults,
  SAFE_DUPLICATE_PRUNE_TOOL_NAMES,
} from "./harness/compaction/compaction-pruner";
import { isFeatureFlagEnabled } from "./harness/feature-flags";
import { HarnessObserver } from "./harness/observability/harness-observer";

export type CompactionPruningScope = {
  sessionId: string;
  runId: string;
  observerSessionToken: symbol;
  /** Runtime-validated builtin, informational, read-only tools. */
  toolNames?: readonly string[];
};

/**
 * Installs a fail-open context hook for exact duplicate read-only tool results.
 * Pi's own manual, threshold, automatic, and overflow compaction paths remain
 * untouched; this extension never registers `session_before_compact`.
 */
export function createModusCompactionExtension(
  getCurrentScope: () => CompactionPruningScope | undefined,
): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event, ctx) => {
      try {
        if (!isFeatureFlagEnabled("MODUS_COMPACTION_PRUNING") || ctx.signal?.aborted) {
          return undefined;
        }

        const scope = getCurrentScope();
        if (
          !scope?.sessionId ||
          !scope.runId ||
          !HarnessObserver.getInstance().isSessionCurrent(
            scope.sessionId,
            scope.observerSessionToken,
          )
        ) {
          return undefined;
        }

        const usage = ctx.getContextUsage();
        if (!usage || typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens)) {
          return undefined;
        }

        const model = ctx.model;
        const policy = getCompactionPolicy(model?.id, model?.contextWindow);
        const metrics = calculateCompactionMetrics(policy, Math.max(0, usage.tokens));
        if (!metrics.isOverThreshold || metrics.tokensToPrune <= 0) return undefined;

        const toolNames = new Set(scope.toolNames ?? SAFE_DUPLICATE_PRUNE_TOOL_NAMES);
        const pruned = pruneDuplicateToolResults(event.messages, toolNames);
        if (pruned.prunedCount === 0 || pruned.measuredContextBytesRemoved <= 0) {
          return undefined;
        }

        // Scope and lifetime are checked again by the observer before metrics
        // are accepted, so a released/recreated session cannot publish stale data.
        HarnessObserver.getInstance().recordCompactionPruning(
          pruned.measuredContextBytesRemoved,
          pruned.estimatedTokensSaved,
          scope.sessionId,
          scope.observerSessionToken,
          scope.runId,
        );

        return { messages: pruned.messages };
      } catch {
        // A pruning failure must never block or alter the model request.
        return undefined;
      }
    });
  };
}
