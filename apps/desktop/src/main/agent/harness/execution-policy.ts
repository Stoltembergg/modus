import type {
  AdaptiveExecutionPolicy,
  AdaptiveVerificationLevel,
  BuiltinAgentRole,
  HarnessTaskClassification,
  ProjectImpactEstimate,
} from "../../../shared/contracts";

export type SelectExecutionPolicyInput = {
  classification: HarnessTaskClassification;
  impact?: ProjectImpactEstimate;
  unresolvedCriterionCount: number;
  openQuestionCount: number;
  avoidedStrategyCodes?: string[];
  enabledModelIds?: string[];
  preferredModelId?: string;
  activeChildCount?: number;
  maxParallelChildrenCap?: number;
};

const MAX_PARALLEL_CAP = 6;

function verificationLevelFor(
  classification: HarnessTaskClassification,
  unresolvedCriterionCount: number,
  impact?: ProjectImpactEstimate,
): AdaptiveVerificationLevel {
  if (
    classification.complexity === "simple" &&
    classification.risk === "low" &&
    unresolvedCriterionCount === 0 &&
    (impact?.blastRadius === "none" || impact?.blastRadius === "local" || impact === undefined)
  ) {
    return "none";
  }
  if (
    classification.risk === "high" ||
    classification.complexity === "complex" ||
    impact?.blastRadius === "cross_module" ||
    unresolvedCriterionCount >= 3
  ) {
    return "strict";
  }
  if (
    classification.complexity === "moderate" ||
    classification.risk === "medium" ||
    impact?.blastRadius === "module" ||
    unresolvedCriterionCount > 0
  ) {
    return "standard";
  }
  return "light";
}

/**
 * Deterministic adaptive execution policy. Catalog-only model choice;
 * never widens permissions or raises hard concurrency caps.
 */
export function selectExecutionPolicy(input: SelectExecutionPolicyInput): AdaptiveExecutionPolicy {
  const reasonCodes: string[] = [...input.classification.reasons];
  const verificationLevel = verificationLevelFor(
    input.classification,
    input.unresolvedCriterionCount,
    input.impact,
  );
  reasonCodes.push(`verification_${verificationLevel}`);

  const suggestHyperPlan =
    input.classification.complexity === "complex" ||
    input.classification.risk === "high" ||
    input.impact?.blastRadius === "cross_module";
  if (suggestHyperPlan) reasonCodes.push("hyperplan_justified");

  let suggestedRole: BuiltinAgentRole | undefined = input.classification.suggestedRole;
  if (
    !suggestedRole &&
    input.classification.confidence === "high" &&
    input.classification.taskType !== "implementation" &&
    input.classification.taskType !== "unknown"
  ) {
    suggestedRole = input.classification.taskType;
  }
  if (suggestedRole) reasonCodes.push(`role_${suggestedRole}`);

  const cap = Math.min(
    Math.max(input.maxParallelChildrenCap ?? MAX_PARALLEL_CAP, 1),
    MAX_PARALLEL_CAP,
  );
  let maxParallelChildren = 1;
  if (
    input.classification.complexity === "complex" &&
    input.classification.risk !== "high" &&
    (input.impact?.confidence === "medium" || input.impact?.confidence === "high")
  ) {
    maxParallelChildren = Math.min(3, cap);
    reasonCodes.push("parallelism_moderate");
  } else if (input.classification.complexity === "moderate") {
    maxParallelChildren = Math.min(2, cap);
    reasonCodes.push("parallelism_light");
  } else {
    reasonCodes.push("parallelism_serial");
  }
  if ((input.activeChildCount ?? 0) >= cap) {
    maxParallelChildren = 0;
    reasonCodes.push("parallelism_at_cap");
  }

  const enabled = new Set(input.enabledModelIds ?? []);
  let preferredModelId: string | undefined;
  if (input.preferredModelId && enabled.has(input.preferredModelId)) {
    preferredModelId = input.preferredModelId;
    reasonCodes.push("model_catalog_hit");
  } else if (input.preferredModelId) {
    reasonCodes.push("model_not_in_catalog");
  }

  if (input.avoidedStrategyCodes?.includes("same_edit_retry")) {
    reasonCodes.push("prior_failure_bias");
  }
  if (input.openQuestionCount > 0) reasonCodes.push("open_questions_present");

  return {
    version: 1,
    verificationLevel,
    suggestHyperPlan,
    ...(suggestedRole ? { suggestedRole } : {}),
    maxParallelChildren,
    ...(preferredModelId ? { preferredModelId } : {}),
    reasonCodes: [...new Set(reasonCodes)].slice(0, 32),
  };
}
