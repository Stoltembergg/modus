import type {
  AdaptiveDecision,
  AdaptiveDecisionSnapshot,
  AdaptiveVerificationLevel,
} from "../../../shared/contracts";
import { selectExecutionPolicy } from "./execution-policy";
import { listAvoidedStrategyCodes } from "./failure-intelligence";
import { mergePolicyEffects } from "./policy-dsl";
import { loadPromotedPolicies } from "./promoted-policy-store";

function unresolvedCriteria(snapshot: AdaptiveDecisionSnapshot): number {
  if (snapshot.unresolvedCriterionCount > 0) return snapshot.unresolvedCriterionCount;
  const criteria = snapshot.taskState?.criteria ?? [];
  return criteria.filter(
    (criterion) =>
      criterion.status === "pending" ||
      criterion.status === "unknown" ||
      criterion.status === "failed" ||
      criterion.status === "blocked",
  ).length;
}

function budgetFor(level: AdaptiveVerificationLevel, complex: boolean): number {
  if (level === "strict") return complex ? 2400 : 1600;
  if (level === "standard") return 1200;
  if (level === "light") return 800;
  return 400;
}

/**
 * Meta Controller. Returns one next action with reason codes.
 * Does not execute tools or bypass permissions — runtime adapters interpret.
 * Loads promoted policies from storage when the snapshot omits them (Gap 4).
 */
export function decideNext(snapshot: AdaptiveDecisionSnapshot): AdaptiveDecision {
  // Gap 4: hydrate promoted policies when the adapter omitted them (pi-sdk parity).
  if (snapshot.promotedPolicies === undefined) {
    const loaded = loadPromotedPolicies(snapshot.workspaceId);
    if (loaded.length > 0) {
      snapshot = { ...snapshot, promotedPolicies: loaded };
    }
  }
  const unresolved = unresolvedCriteria(snapshot);
  const openQuestions = Math.max(
    snapshot.openQuestionCount,
    snapshot.taskState?.openQuestionRefs.length ?? 0,
  );
  const promoted = mergePolicyEffects(snapshot.promotedPolicies ?? []);
  const failureAvoided = listAvoidedStrategyCodes(
    snapshot.failureAttempts,
    snapshot.impact?.revision,
  );
  const avoided = [...new Set([...failureAvoided, ...promoted.avoidStrategyCodes])].slice(0, 24);
  const policy = selectExecutionPolicy({
    classification: snapshot.classification,
    ...(snapshot.impact ? { impact: snapshot.impact } : {}),
    unresolvedCriterionCount: unresolved,
    openQuestionCount: openQuestions,
    avoidedStrategyCodes: avoided,
    enabledModelIds: snapshot.enabledModelIds,
    ...(promoted.effects.length > 0 ? { promotedEffects: promoted.effects } : {}),
  });
  const verification = snapshot.taskState?.verificationStatus;
  const qa = snapshot.qaStatus;
  const mode = snapshot.decisionMode;
  const complex =
    snapshot.classification.complexity === "complex" || snapshot.classification.risk === "high";

  const base = {
    version: 1 as const,
    mode,
    policy,
    avoidStrategyCodes: avoided,
    verificationLevel: policy.verificationLevel,
    budgetTokens: budgetFor(policy.verificationLevel, complex),
  };

  if (openQuestions > 0 && snapshot.taskState?.phase === "awaiting_user") {
    return {
      ...base,
      action: "ask_user",
      reasonCodes: ["open_questions", "awaiting_user_phase"],
      confidence: "high",
      expectedUncertaintyReduction: 20,
    };
  }

  if (
    verification === "verified" ||
    verification === "user_confirmed" ||
    verification === "not_required" ||
    qa === "passed" ||
    qa === "not_required" ||
    qa === "user_confirmed"
  ) {
    if (unresolved === 0) {
      return {
        ...base,
        action: "finish",
        reasonCodes: ["verification_satisfied", `qa_${qa ?? verification ?? "unknown"}`],
        confidence: "high",
        expectedUncertaintyReduction: 0,
      };
    }
  }

  if (qa === "failed" || verification === "failed") {
    if (avoided.includes("same_edit_retry") || avoided.includes("blind_retry")) {
      return {
        ...base,
        action: "avoid_retry",
        reasonCodes: [
          "duplicate_failed_strategy",
          "failure_intelligence_block",
          ...promoted.reasonCodes.filter((code) => code.includes("avoid")),
        ].slice(0, 8),
        confidence: "high",
        expectedUncertaintyReduction: 8,
      };
    }
    if (promoted.preferReplanOnQaFail) {
      return {
        ...base,
        action: "replan",
        reasonCodes: [
          "verification_failed",
          "replan_after_failure",
          "promoted_policy_prefer_replan_on_qa_fail",
        ],
        confidence: "medium",
        expectedUncertaintyReduction: 10,
      };
    }
    if (complex || snapshot.impact?.blastRadius === "cross_module") {
      if (mode === "active") {
        return {
          ...base,
          action: "spawn_readonly_specialist",
          specialistRole: policy.suggestedRole === "debugger" ? "debugger" : "oracle",
          reasonCodes: ["verification_failed", "high_risk_or_blast", "safe_readonly_spawn"],
          confidence: "medium",
          expectedUncertaintyReduction: 12,
        };
      }
      return {
        ...base,
        action: "suggest_oracle",
        reasonCodes: ["verification_failed", "high_risk_or_blast"],
        confidence: "medium",
        expectedUncertaintyReduction: 12,
      };
    }
    return {
      ...base,
      action: "replan",
      reasonCodes: ["verification_failed", "replan_after_failure"],
      confidence: "medium",
      expectedUncertaintyReduction: 10,
    };
  }

  if (
    (qa === "missing" || verification === "pending" || verification === "unknown") &&
    (policy.verificationLevel === "standard" || policy.verificationLevel === "strict") &&
    unresolved > 0
  ) {
    return {
      ...base,
      action: "verify",
      reasonCodes: [
        "evidence_required",
        `verification_${policy.verificationLevel}`,
        ...promoted.reasonCodes.filter((code) => code.includes("verification")),
      ].slice(0, 8),
      confidence: "high",
      expectedUncertaintyReduction: 14,
    };
  }

  const uncertain =
    snapshot.impact?.confidence === "unknown" ||
    snapshot.impact?.unknownReasons.includes("no_typed_paths") === true ||
    unresolved > 0;

  // Promoted context-pressure bias: prefer local retrieve before plan/spawn (still allowlisted).
  if (promoted.preferRetrieveLocal && uncertain) {
    return {
      ...base,
      action: "retrieve_local",
      reasonCodes: [
        "uncertainty_high",
        "local_preflight_candidate",
        "promoted_policy_prefer_retrieve_local",
      ],
      confidence: "medium",
      expectedUncertaintyReduction: 11,
    };
  }

  // Gap 1: explicit read-only research roles beat HyperPlan suggestion in active mode.
  if (mode === "active" && uncertain && complex) {
    if (snapshot.classification.suggestedRole === "librarian") {
      return {
        ...base,
        action: "mcp_preflight",
        specialistRole: "librarian",
        reasonCodes: ["uncertainty_high", "mcp_preflight_librarian"],
        confidence: "medium",
        expectedUncertaintyReduction: 11,
      };
    }
    if (snapshot.classification.suggestedRole === "explore") {
      return {
        ...base,
        action: "spawn_readonly_specialist",
        specialistRole: "explore",
        reasonCodes: ["uncertainty_high", "safe_readonly_spawn", "explore_preflight"],
        confidence: "medium",
        expectedUncertaintyReduction: 11,
      };
    }
  }

  if (
    policy.suggestHyperPlan &&
    snapshot.mode !== "plan" &&
    snapshot.taskState?.phase !== "planning"
  ) {
    return {
      ...base,
      action: "suggest_plan",
      reasonCodes: ["hyperplan_or_complex_scope", ...policy.reasonCodes.slice(0, 4)],
      confidence: snapshot.classification.confidence === "high" ? "medium" : "low",
      expectedUncertaintyReduction: 9,
    };
  }

  if (uncertain && complex) {
    return {
      ...base,
      action: "retrieve_local",
      reasonCodes: ["uncertainty_high", "local_preflight_candidate"],
      confidence: "medium",
      expectedUncertaintyReduction: 11,
    };
  }

  if (
    snapshot.classification.suggestedRole === "oracle" ||
    (complex && snapshot.classification.confidence === "low")
  ) {
    if (mode === "active") {
      return {
        ...base,
        action: "spawn_readonly_specialist",
        specialistRole: policy.suggestedRole ?? "oracle",
        reasonCodes: ["architecture_or_low_confidence", "safe_readonly_spawn"],
        confidence: "medium",
        expectedUncertaintyReduction: 10,
      };
    }
    return {
      ...base,
      action: "suggest_oracle",
      reasonCodes: ["architecture_or_low_confidence"],
      confidence: "medium",
      expectedUncertaintyReduction: 10,
    };
  }

  return {
    ...base,
    action: "execute",
    reasonCodes: ["default_execute", ...snapshot.classification.reasons.slice(0, 4)],
    confidence: snapshot.classification.confidence === "high" ? "high" : "medium",
    expectedUncertaintyReduction: 3,
  };
}

/** Bounded advisory hint injected into the turn message (never system policy). */
export function formatAdaptiveDecisionHint(decision: AdaptiveDecision): string | undefined {
  if (decision.mode === "shadow") return undefined;
  switch (decision.action) {
    case "suggest_plan":
      return "Adaptive policy: complex/high-blast scope detected. Consider Plan Mode or HyperPlan review; continue only if the user already chose otherwise.";
    case "suggest_oracle":
      return "Adaptive policy: high uncertainty or failed verification. Prefer read-only Oracle/reviewer advice before repeating the same edit strategy.";
    case "spawn_readonly_specialist":
      return `Adaptive policy: a read-only ${decision.specialistRole ?? "oracle"} specialist was auto-dispatched (Intent Gate + ToolRegistry permissions still apply). Wait for its findings before continuing edits.`;
    case "mcp_preflight":
      return "Adaptive policy: a read-only librarian MCP preflight was auto-dispatched. Allowlisted MCP tools run only through ToolRegistry + the permission broker; do not call non-allowlisted MCP tools.";
    case "verify":
      return "Adaptive policy: verification evidence is still required before treating this task as done. Use only the eligible required check scripts already named for this turn.";
    case "avoid_retry":
      return "Adaptive policy: an equivalent failed strategy was already tested at this revision. Do not repeat it; reformulate, gather new evidence, or ask the user.";
    case "replan":
      return "Adaptive policy: last verification failed. Replan with a different strategy and record what was ruled out.";
    case "retrieve_local":
      return "Adaptive policy: prefer bounded local CodeGraph/git/memory retrieval that reduces named uncertainties before broad file reads.";
    case "ask_user":
      return "Adaptive policy: open questions remain. Ask a focused clarifying question before continuing consequential work.";
    default:
      return undefined;
  }
}
