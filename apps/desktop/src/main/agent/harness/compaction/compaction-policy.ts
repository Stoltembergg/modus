/**
 * Compaction Policy Engine:
 * Defines context window limits, token headroom, reserve budgets,
 * and evidence preservation categories for each supported LLM.
 */

export type CompactionEvidenceCategory =
  | "qa_check"
  | "harness_decision"
  | "plan_acceptance"
  | "checkpoint"
  | "failure_attempt"
  | "user_confirmation";

export type CompactionPolicy = {
  modelId: string;
  contextWindow: number;
  outputReserve: number;
  headroom: number;
  thresholdRatio: number; // Ratio of effective window to trigger compaction (e.g. 0.80)
  targetRatioAfterPrune: number; // Desired ratio after pruning (e.g. 0.65)
  preserveCategories: CompactionEvidenceCategory[];
};

export const DEFAULT_COMPACTION_POLICIES: Record<string, CompactionPolicy> = {
  "claude-opus-5": {
    modelId: "claude-opus-5",
    contextWindow: 200_000,
    outputReserve: 16_000,
    headroom: 20_000,
    thresholdRatio: 0.85,
    targetRatioAfterPrune: 0.65,
    preserveCategories: [
      "qa_check",
      "harness_decision",
      "plan_acceptance",
      "checkpoint",
      "failure_attempt",
      "user_confirmation",
    ],
  },
  "claude-sonnet-4-5": {
    modelId: "claude-sonnet-4-5",
    contextWindow: 200_000,
    outputReserve: 8_000,
    headroom: 15_000,
    thresholdRatio: 0.8,
    targetRatioAfterPrune: 0.65,
    preserveCategories: [
      "qa_check",
      "harness_decision",
      "plan_acceptance",
      "checkpoint",
      "failure_attempt",
      "user_confirmation",
    ],
  },
  "claude-haiku-4-5": {
    modelId: "claude-haiku-4-5",
    contextWindow: 200_000,
    outputReserve: 8_000,
    headroom: 15_000,
    thresholdRatio: 0.78,
    targetRatioAfterPrune: 0.6,
    preserveCategories: ["qa_check", "harness_decision", "plan_acceptance", "checkpoint"],
  },
  "gpt-4o": {
    modelId: "gpt-4o",
    contextWindow: 128_000,
    outputReserve: 8_000,
    headroom: 12_000,
    thresholdRatio: 0.8,
    targetRatioAfterPrune: 0.65,
    preserveCategories: [
      "qa_check",
      "harness_decision",
      "plan_acceptance",
      "checkpoint",
      "user_confirmation",
    ],
  },
  "deepseek-chat": {
    modelId: "deepseek-chat",
    contextWindow: 64_000,
    outputReserve: 8_000,
    headroom: 8_000,
    thresholdRatio: 0.75,
    targetRatioAfterPrune: 0.6,
    preserveCategories: ["qa_check", "harness_decision", "plan_acceptance", "checkpoint"],
  },
};

export const FALLBACK_COMPACTION_POLICY: CompactionPolicy = {
  modelId: "default-fallback",
  contextWindow: 128_000,
  outputReserve: 8_000,
  headroom: 12_000,
  thresholdRatio: 0.8,
  targetRatioAfterPrune: 0.65,
  preserveCategories: [
    "qa_check",
    "harness_decision",
    "plan_acceptance",
    "checkpoint",
    "user_confirmation",
  ],
};

/**
 * Resolves the compaction policy for a specific model ID.
 * Falls back to closest prefix match or default fallback policy.
 * When the runtime reports the model's real `contextWindow`, it is authoritative:
 * models missing from the table (and models whose table entry disagrees) must not
 * be constrained by the 128k fallback, otherwise compaction never triggers on
 * larger windows and always triggers on smaller ones.
 */
export function getCompactionPolicy(modelId?: string, contextWindow?: number): CompactionPolicy {
  const declaredWindow =
    typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    contextWindow < 10_000_000
      ? Math.floor(contextWindow)
      : undefined;

  const withDeclaredWindow = (policy: CompactionPolicy): CompactionPolicy =>
    declaredWindow !== undefined && declaredWindow !== policy.contextWindow
      ? { ...policy, contextWindow: declaredWindow }
      : policy;

  if (!modelId) {
    return withDeclaredWindow(FALLBACK_COMPACTION_POLICY);
  }

  const normalized = modelId.toLowerCase().trim();
  if (DEFAULT_COMPACTION_POLICIES[normalized]) {
    return withDeclaredWindow({ ...DEFAULT_COMPACTION_POLICIES[normalized], modelId });
  }

  for (const [key, policy] of Object.entries(DEFAULT_COMPACTION_POLICIES)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return withDeclaredWindow({ ...policy, modelId });
    }
  }

  return withDeclaredWindow({ ...FALLBACK_COMPACTION_POLICY, modelId });
}

/**
 * Calculates current token thresholds and headroom for a given policy and token load.
 */
export function calculateCompactionMetrics(
  policy: CompactionPolicy,
  currentTokens: number,
): {
  effectiveCapacity: number;
  triggerThresholdTokens: number;
  targetTokensAfterPrune: number;
  tokensToPrune: number;
  isOverThreshold: boolean;
  remainingHeadroom: number;
} {
  const effectiveCapacity = Math.max(0, policy.contextWindow - policy.outputReserve);
  const triggerThresholdTokens = Math.floor(effectiveCapacity * policy.thresholdRatio);
  const targetTokensAfterPrune = Math.floor(effectiveCapacity * policy.targetRatioAfterPrune);
  const isOverThreshold = currentTokens >= triggerThresholdTokens;
  const tokensToPrune = isOverThreshold ? Math.max(0, currentTokens - targetTokensAfterPrune) : 0;
  const remainingHeadroom = Math.max(0, effectiveCapacity - currentTokens);

  return {
    effectiveCapacity,
    triggerThresholdTokens,
    targetTokensAfterPrune,
    tokensToPrune,
    isOverThreshold,
    remainingHeadroom,
  };
}
