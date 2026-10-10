import type { AdaptiveFailureAttempt } from "../../../../shared/contracts";
import { failureAttemptSignature } from "../failure-intelligence";
import { getRepeatGuardConfig, type RepeatGuardConfig } from "./repeat-guard-config";

export type HypothesisRepeatAnalysis = {
  isRepeating: boolean;
  totalAttempts: number;
  uniqueSignatures: number;
  ratio: number;
  dominantSignatures: Array<{
    signature: string;
    count: number;
    strategyCode: string;
  }>;
  reasons: string[];
};

/**
 * Detects whether the agent is cycling through identical or nearly identical hypotheses
 * and strategies across recent failure attempts.
 */
export function detectRepeatHypothesis(
  attempts: readonly AdaptiveFailureAttempt[],
  configOverrides?: Partial<RepeatGuardConfig>,
): HypothesisRepeatAnalysis {
  const config = { ...getRepeatGuardConfig(), ...configOverrides };
  const minAttempts = 2;

  // Filter to failed or discarded attempts
  const relevantAttempts = attempts.filter(
    (a) => a.status === "failed" || a.status === "discarded",
  );

  if (relevantAttempts.length < minAttempts) {
    return {
      isRepeating: false,
      totalAttempts: relevantAttempts.length,
      uniqueSignatures: relevantAttempts.length,
      ratio: 1.0,
      dominantSignatures: [],
      reasons: [],
    };
  }

  const signatureCounts = new Map<string, { count: number; strategyCode: string }>();
  for (const attempt of relevantAttempts) {
    const sig = failureAttemptSignature(attempt);
    const existing = signatureCounts.get(sig);
    if (existing) {
      existing.count += 1;
    } else {
      signatureCounts.set(sig, { count: 1, strategyCode: attempt.strategyCode });
    }
  }

  const uniqueSignatures = signatureCounts.size;
  const total = relevantAttempts.length;
  const ratio = uniqueSignatures / total;

  const isRepeating = ratio <= config.hypothesisRepeatRatio;

  const dominantSignatures = [...signatureCounts.entries()]
    .filter(([, data]) => data.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([sig, data]) => ({
      signature: sig,
      count: data.count,
      strategyCode: data.strategyCode,
    }));

  const reasons: string[] = [];
  if (isRepeating) {
    reasons.push(
      `low_hypothesis_diversity:${Math.round(ratio * 100)}%_unique`,
      `attempts_${total}_with_${uniqueSignatures}_signatures`,
    );
    for (const dominant of dominantSignatures) {
      reasons.push(`stuck_strategy:${dominant.strategyCode}:${dominant.count}_times`);
    }
  }

  return {
    isRepeating,
    totalAttempts: total,
    uniqueSignatures,
    ratio,
    dominantSignatures,
    reasons,
  };
}
