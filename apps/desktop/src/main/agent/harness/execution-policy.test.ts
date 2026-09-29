import { describe, expect, it } from "vitest";
import type { HarnessTaskClassification } from "../../../shared/contracts";
import { selectExecutionPolicy } from "./execution-policy";

const base: HarnessTaskClassification = {
  taskType: "implementation",
  complexity: "simple",
  risk: "low",
  confidence: "high",
  reasons: ["clear_implementation_request"],
};

describe("execution-policy", () => {
  it("keeps simple low-risk work lightweight", () => {
    const policy = selectExecutionPolicy({
      classification: base,
      unresolvedCriterionCount: 0,
      openQuestionCount: 0,
      enabledModelIds: ["openai:gpt"],
      preferredModelId: "openai:gpt",
    });
    expect(policy.verificationLevel).toBe("none");
    expect(policy.suggestHyperPlan).toBe(false);
    expect(policy.maxParallelChildren).toBe(1);
    expect(policy.preferredModelId).toBe("openai:gpt");
  });

  it("raises verification and HyperPlan for complex/high-blast work", () => {
    const policy = selectExecutionPolicy({
      classification: {
        ...base,
        complexity: "complex",
        risk: "high",
        suggestedRole: "oracle",
        reasons: ["architecture_request"],
      },
      unresolvedCriterionCount: 3,
      openQuestionCount: 1,
      impact: {
        blastRadius: "cross_module",
        impactedPathCount: 10,
        confidence: "high",
        unknownReasons: [],
        reasonCodes: ["cross_module_scope"],
      },
      enabledModelIds: ["a"],
      preferredModelId: "missing",
      maxParallelChildrenCap: 6,
    });
    expect(policy.verificationLevel).toBe("strict");
    expect(policy.suggestHyperPlan).toBe(true);
    expect(policy.suggestedRole).toBe("oracle");
    expect(policy.preferredModelId).toBeUndefined();
    expect(policy.reasonCodes).toContain("model_not_in_catalog");
  });

  it("never exceeds the hard parallelism cap", () => {
    const policy = selectExecutionPolicy({
      classification: { ...base, complexity: "complex", risk: "low" },
      unresolvedCriterionCount: 0,
      openQuestionCount: 0,
      impact: {
        blastRadius: "module",
        impactedPathCount: 4,
        confidence: "high",
        unknownReasons: [],
        reasonCodes: [],
      },
      activeChildCount: 6,
      maxParallelChildrenCap: 6,
    });
    expect(policy.maxParallelChildren).toBe(0);
    expect(policy.reasonCodes).toContain("parallelism_at_cap");
  });
});
