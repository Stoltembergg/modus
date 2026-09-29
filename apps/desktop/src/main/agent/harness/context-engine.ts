import type {
  ContextUncertaintyCandidate,
  ContextUncertaintyScore,
} from "../../../shared/contracts";

export type ScoreContextCandidatesInput = {
  candidates: ContextUncertaintyCandidate[];
  unresolvedCriterionIds: string[];
  openQuestionIds: string[];
  tokenBudget?: number;
  limit?: number;
};

const TRUST_WEIGHT: Record<ContextUncertaintyCandidate["trust"], number> = {
  plan: 14,
  "local-memory": 12,
  "code-map": 10,
  git: 9,
  docs: 7,
  "external-reference": 2,
};

const DEFAULT_TOKEN_BUDGET = 1200;
const DEFAULT_LIMIT = 24;

/**
 * Rank context by expected uncertainty reduction for named unknowns —
 * not semantic similarity alone. Wraps Context Planner candidate shapes.
 */
export function scoreContextCandidates(
  input: ScoreContextCandidatesInput,
): ContextUncertaintyScore[] {
  const unresolved = new Set(input.unresolvedCriterionIds);
  const questions = new Set(input.openQuestionIds);
  const budget = Math.min(Math.max(input.tokenBudget ?? DEFAULT_TOKEN_BUDGET, 64), 4096);
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 80);
  const scored: ContextUncertaintyScore[] = [];

  for (const candidate of input.candidates) {
    const criterionHits = candidate.addressesCriterionIds.filter((id) => unresolved.has(id)).length;
    const questionHits = candidate.addressesOpenQuestionIds.filter((id) =>
      questions.has(id),
    ).length;
    const unknownCoverage = criterionHits * 18 + questionHits * 16;
    const trust = TRUST_WEIGHT[candidate.trust] ?? 0;
    const freshness = Math.max(0, Math.min(1, candidate.freshnessScore)) * 10;
    const relevance = Math.max(0, Math.min(1, candidate.relevanceScore)) * 12;
    const tokenPenalty =
      candidate.estimatedTokens <= 0 ? 8 : Math.min(14, (candidate.estimatedTokens / budget) * 20);
    const expectedUncertaintyReduction = Math.max(
      0,
      unknownCoverage + trust * 0.35 + freshness * 0.25 + relevance * 0.3 - tokenPenalty,
    );
    const score =
      expectedUncertaintyReduction +
      (criterionHits > 0 || questionHits > 0 ? 6 : -4) +
      (candidate.trust === "external-reference" && unknownCoverage === 0 ? -8 : 0);

    const reasons: string[] = [];
    if (criterionHits > 0) reasons.push("covers_unresolved_criteria");
    if (questionHits > 0) reasons.push("covers_open_questions");
    if (candidate.trust === "local-memory" || candidate.trust === "plan") {
      reasons.push("trusted_local_source");
    }
    if (candidate.trust === "external-reference") reasons.push("external_untrusted");
    if (candidate.estimatedTokens > budget * 0.35) reasons.push("high_token_cost");
    if (unknownCoverage === 0) reasons.push("low_uncertainty_reduction");

    scored.push({
      id: candidate.id,
      sourceId: candidate.sourceId,
      score,
      expectedUncertaintyReduction,
      reasons,
    });
  }

  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function selectUncertaintyReducingIds(
  scores: readonly ContextUncertaintyScore[],
  tokenBudget: number,
  candidateTokens: ReadonlyMap<string, number>,
): string[] {
  const selected: string[] = [];
  let used = 0;
  for (const score of scores) {
    if (score.expectedUncertaintyReduction <= 0) continue;
    const tokens = candidateTokens.get(score.id) ?? 0;
    if (used + tokens > tokenBudget && selected.length > 0) continue;
    selected.push(score.id);
    used += tokens;
    if (selected.length >= 12) break;
  }
  return selected;
}
