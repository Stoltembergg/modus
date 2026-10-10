import type {
  CompactPruneInput,
  CompactPruneOutput,
  HarnessContext,
  HarnessHook,
} from "../kernel/harness-hooks";
import { coordinateCompaction } from "./compaction-coordinator";

/**
 * Standard Harness Hook for Compaction & Intelligent Pruning.
 * Runs in the "compact_prune" phase.
 */
export const defaultCompactionHook: HarnessHook<CompactPruneInput, CompactPruneOutput> = {
  name: "harness_compaction_prune",
  phase: "compact_prune",
  priority: 10,
  isCritical: false,
  execute: (input: CompactPruneInput, context: HarnessContext): CompactPruneOutput => {
    const result = coordinateCompaction({
      sessionId: context.sessionId,
      runId: context.runId,
      currentTokens: input.currentTokens,
      messages: input.messages,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.baseSummary ? { baseSummary: input.baseSummary } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
    });

    return {
      shouldCancelCompaction: result.shouldCancelCompaction,
      reason: result.reason,
      savedTokens: result.savedTokens,
      savedBytes: result.savedBytes,
      prunedCount: result.prunedCount,
      remainingTokens: result.remainingTokens,
      ...(result.enhancedSummary ? { enhancedSummary: result.enhancedSummary } : {}),
    };
  },
};
