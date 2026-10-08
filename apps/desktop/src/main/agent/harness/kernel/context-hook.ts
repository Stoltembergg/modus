import type { ContextUncertaintyCandidate } from "../../../../shared/contracts";
import { scoreContextCandidates, selectUncertaintyReducingIds } from "../context-engine";
import type {
  ContextResolveInput,
  ContextResolveOutput,
  HarnessContext,
  HarnessHook,
} from "./harness-hooks";

/**
 * Standard Context Resolution Hook:
 * Scores context candidates against criteria, applies token budgets,
 * and passes the optimal candidates to downstream prompt builders.
 */
export const contextResolveHook: HarnessHook<ContextResolveInput, ContextResolveOutput> = {
  name: "context_resolve_scoring",
  phase: "context_resolve",
  priority: 20,
  isCritical: false,
  execute: async (
    input: ContextResolveInput,
    context: HarnessContext,
  ): Promise<ContextResolveOutput> => {
    const rawCandidates =
      input.candidates ?? (context.state.get("raw_context_candidates") as any[]) ?? [];

    // Map into ContextUncertaintyCandidate shape for scoring engine
    const candidates: ContextUncertaintyCandidate[] = rawCandidates.map((c, index) => {
      const estimatedTokens = c.tokens ?? c.tokenCost ?? 100;
      return {
        id: c.id,
        sourceId: c.id,
        trust: (c.trust as any) || "local-memory",
        addressesCriterionIds: [],
        addressesOpenQuestionIds: [],
        freshnessScore: 1.0,
        relevanceScore: c.score ?? 0.8,
        estimatedTokens,
        label: c.label || c.path || `cand-${index}`,
      };
    });

    const candidateTokens = new Map<string, number>();
    for (const c of candidates) {
      candidateTokens.set(c.id, c.estimatedTokens);
    }

    const tokenBudget = input.tokenBudget ?? 8000;
    const scored = scoreContextCandidates({
      candidates,
      unresolvedCriterionIds: [],
      openQuestionIds: [],
      tokenBudget,
    });

    const selectedIds = selectUncertaintyReducingIds(scored, tokenBudget, candidateTokens);

    const selectedSet = new Set(selectedIds);
    const selected = scored.filter((c) => selectedSet.has(c.id));
    const totalTokens = selected.reduce((sum, c) => sum + (candidateTokens.get(c.id) ?? 0), 0);

    // Record selected context in context state
    context.state.set("resolved_context_candidates", selected);

    return {
      selectedCandidates: selected.map((s) => ({
        id: s.id,
        score: s.score,
        tokens: candidateTokens.get(s.id) ?? 0,
      })),
      candidates: selected.map((s) => ({
        id: s.id,
        score: s.score,
        tokens: candidateTokens.get(s.id) ?? 0,
      })),
      totalTokens,
      prunedCount: candidates.length - selected.length,
    };
  },
};
