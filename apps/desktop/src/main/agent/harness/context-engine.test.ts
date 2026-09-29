import { describe, expect, it } from "vitest";
import { scoreContextCandidates, selectUncertaintyReducingIds } from "./context-engine";

describe("context-engine", () => {
  it("prefers candidates that cover unresolved criteria over mere relevance", () => {
    const ranked = scoreContextCandidates({
      unresolvedCriterionIds: ["c1"],
      openQuestionIds: [],
      candidates: [
        {
          id: "similar",
          sourceId: "mem",
          trust: "local-memory",
          estimatedTokens: 100,
          addressesCriterionIds: [],
          addressesOpenQuestionIds: [],
          freshnessScore: 1,
          relevanceScore: 1,
        },
        {
          id: "covers",
          sourceId: "plan",
          trust: "plan",
          estimatedTokens: 120,
          addressesCriterionIds: ["c1"],
          addressesOpenQuestionIds: [],
          freshnessScore: 0.5,
          relevanceScore: 0.2,
        },
      ],
    });
    expect(ranked[0]?.id).toBe("covers");
    expect(ranked[0]?.reasons).toContain("covers_unresolved_criteria");
    expect(ranked[1]?.reasons).toContain("low_uncertainty_reduction");
  });

  it("selects a bounded set within the token budget", () => {
    const scores = scoreContextCandidates({
      unresolvedCriterionIds: ["a"],
      openQuestionIds: ["q"],
      candidates: [
        {
          id: "one",
          sourceId: "code",
          trust: "code-map",
          estimatedTokens: 400,
          addressesCriterionIds: ["a"],
          addressesOpenQuestionIds: [],
          freshnessScore: 1,
          relevanceScore: 1,
        },
        {
          id: "two",
          sourceId: "docs",
          trust: "docs",
          estimatedTokens: 400,
          addressesCriterionIds: [],
          addressesOpenQuestionIds: ["q"],
          freshnessScore: 1,
          relevanceScore: 1,
        },
        {
          id: "three",
          sourceId: "ext",
          trust: "external-reference",
          estimatedTokens: 800,
          addressesCriterionIds: [],
          addressesOpenQuestionIds: [],
          freshnessScore: 1,
          relevanceScore: 1,
        },
      ],
    });
    const selected = selectUncertaintyReducingIds(
      scores,
      700,
      new Map([
        ["one", 400],
        ["two", 400],
        ["three", 800],
      ]),
    );
    expect(selected).toContain("one");
    expect(selected).not.toContain("three");
  });
});
