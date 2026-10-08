import {
  type CompactionPolicy,
  calculateCompactionMetrics,
  getCompactionPolicy,
} from "./compaction-policy";
import {
  identifyPruneCandidates,
  type MessageLike,
  type PruneResult,
  pruneCandidates,
} from "./compaction-pruner";
import {
  filterPreservedEvidence,
  formatPreservedEvidenceMarkdown,
  type PreservedEvidence,
} from "./evidence-preservation";

export type CompactionCoordinationInput = {
  sessionId: string;
  runId?: string | undefined;
  modelId?: string | undefined;
  currentTokens: number;
  messages: MessageLike[];
  evidence?: PreservedEvidence[] | undefined;
  customPolicy?: CompactionPolicy | undefined;
  baseSummary?: string | undefined;
};

export type CompactionCoordinationResult = {
  shouldCancelCompaction: boolean;
  reason: "under_threshold" | "headroom_restored_via_pruning" | "compaction_required";
  savedTokens: number;
  savedBytes: number;
  prunedCount: number;
  remainingTokens: number;
  pruneResult: PruneResult;
  enhancedSummary?: string | undefined;
  preservedEvidenceCount: number;
};

export type CompactionTelemetrySnapshot = {
  totalEvaluations: number;
  compactionsCanceled: number;
  compactionsExecuted: number;
  totalTokensSaved: number;
  totalBytesSaved: number;
  totalEvidencePreserved: number;
};

class CompactionTelemetry {
  private totalEvaluations = 0;
  private compactionsCanceled = 0;
  private compactionsExecuted = 0;
  private totalTokensSaved = 0;
  private totalBytesSaved = 0;
  private totalEvidencePreserved = 0;

  record(result: CompactionCoordinationResult): void {
    this.totalEvaluations++;
    if (result.shouldCancelCompaction) {
      this.compactionsCanceled++;
    } else {
      this.compactionsExecuted++;
    }
    this.totalTokensSaved += result.savedTokens;
    this.totalBytesSaved += result.savedBytes;
    this.totalEvidencePreserved += result.preservedEvidenceCount;
  }

  getSnapshot(): CompactionTelemetrySnapshot {
    return {
      totalEvaluations: this.totalEvaluations,
      compactionsCanceled: this.compactionsCanceled,
      compactionsExecuted: this.compactionsExecuted,
      totalTokensSaved: this.totalTokensSaved,
      totalBytesSaved: this.totalBytesSaved,
      totalEvidencePreserved: this.totalEvidencePreserved,
    };
  }

  reset(): void {
    this.totalEvaluations = 0;
    this.compactionsCanceled = 0;
    this.compactionsExecuted = 0;
    this.totalTokensSaved = 0;
    this.totalBytesSaved = 0;
    this.totalEvidencePreserved = 0;
  }
}

export const compactionTelemetry = new CompactionTelemetry();

/**
 * Evaluates session token load and intelligently coordinates pruning and compaction.
 */
export function coordinateCompaction(
  input: CompactionCoordinationInput
): CompactionCoordinationResult {
  const policy = input.customPolicy ?? getCompactionPolicy(input.modelId);
  const metrics = calculateCompactionMetrics(policy, input.currentTokens);

  // If not even over threshold, cancel compaction immediately
  if (!metrics.isOverThreshold) {
    const emptyResult: CompactionCoordinationResult = {
      shouldCancelCompaction: true,
      reason: "under_threshold",
      savedTokens: 0,
      savedBytes: 0,
      prunedCount: 0,
      remainingTokens: input.currentTokens,
      pruneResult: {
        prunedIds: [],
        savedBytes: 0,
        savedTokens: 0,
        replacements: new Map(),
      },
      preservedEvidenceCount: 0,
    };
    compactionTelemetry.record(emptyResult);
    return emptyResult;
  }

  // Identify prune candidates
  const candidates = identifyPruneCandidates(input.messages);

  // Execute pruning to meet target ratio
  const pruneResult = pruneCandidates(candidates, metrics.tokensToPrune);
  const remainingTokens = Math.max(0, input.currentTokens - pruneResult.savedTokens);

  // Check if pruning restored enough headroom
  const headroomRestored = remainingTokens < metrics.triggerThresholdTokens;

  // Process and format preserved evidence
  const rawEvidence = input.evidence ?? [];
  const filteredEvidence = filterPreservedEvidence(rawEvidence, policy.preserveCategories);
  const evidenceMarkdown = formatPreservedEvidenceMarkdown(filteredEvidence);

  let enhancedSummary: string | undefined = undefined;
  if (evidenceMarkdown) {
    enhancedSummary = input.baseSummary
      ? `${input.baseSummary}\n\n${evidenceMarkdown}`
      : evidenceMarkdown;
  } else if (input.baseSummary) {
    enhancedSummary = input.baseSummary;
  }

  const result: CompactionCoordinationResult = {
    shouldCancelCompaction: headroomRestored,
    reason: headroomRestored ? "headroom_restored_via_pruning" : "compaction_required",
    savedTokens: pruneResult.savedTokens,
    savedBytes: pruneResult.savedBytes,
    prunedCount: pruneResult.prunedIds.length,
    remainingTokens,
    pruneResult,
    ...(enhancedSummary ? { enhancedSummary } : {}),
    preservedEvidenceCount: filteredEvidence.length,
  };

  compactionTelemetry.record(result);
  return result;
}

/**
 * CompactionCoordinator class wrapper for object-oriented delegation in PiSdkRuntime.
 */
export class CompactionCoordinator {
  coordinate(input: CompactionCoordinationInput): CompactionCoordinationResult {
    return coordinateCompaction(input);
  }

  getTelemetry(): CompactionTelemetrySnapshot {
    return compactionTelemetry.getSnapshot();
  }
}
