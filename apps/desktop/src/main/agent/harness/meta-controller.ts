import type {
  AdaptiveDecision,
  AdaptiveDecisionSnapshot,
  AdaptiveVerificationLevel,
  ChangeStrategyPlan,
} from "../../../shared/contracts";
import { selectChangeStrategy } from "./change-strategy";
import { selectExecutionPolicy } from "./execution-policy";
import { listAvoidedStrategyCodes } from "./failure-intelligence";
import { isFeatureFlagEnabled } from "./feature-flags";
import { detectRepeatHypothesis } from "./guards/repeat-hypothesis-guard";
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

function withChangeStrategy(
  decision: AdaptiveDecision,
  changeStrategy: ChangeStrategyPlan,
): AdaptiveDecision {
  return { ...decision, changeStrategy };
}

/** Gap 5: optional runtime hooks so Oracle bridge can augment without editing pi-sdk-runtime. */
export type AdaptiveSnapshotAugmenter = (
  snapshot: AdaptiveDecisionSnapshot,
) => AdaptiveDecisionSnapshot;
export type AdaptiveHintAugmenter = (
  hint: string | undefined,
  decision: AdaptiveDecision,
) => string | undefined;

let snapshotAugmenter: AdaptiveSnapshotAugmenter | undefined;
let hintAugmenter: AdaptiveHintAugmenter | undefined;

export function setAdaptiveSnapshotAugmenter(
  augmenter: AdaptiveSnapshotAugmenter | undefined,
): void {
  snapshotAugmenter = augmenter;
}

export function setAdaptiveHintAugmenter(augmenter: AdaptiveHintAugmenter | undefined): void {
  hintAugmenter = augmenter;
}

/**
 * Meta Controller. Returns one next action with reason codes.
 * Does not execute tools or bypass permissions — runtime adapters interpret.
 * Loads promoted policies from storage when the snapshot omits them (Gap 4).
 */
export function decideNext(snapshot: AdaptiveDecisionSnapshot): AdaptiveDecision {
  if (snapshotAugmenter) {
    snapshot = snapshotAugmenter(snapshot);
  }
  // Gap 4: hydrate promoted policies when the adapter omitted them (pi-sdk parity).
  // Fail-closed if storage/Electron is unavailable (unit tests, early boot).
  if (snapshot.promotedPolicies === undefined) {
    try {
      const loaded = loadPromotedPolicies(snapshot.workspaceId);
      if (loaded.length > 0) {
        snapshot = { ...snapshot, promotedPolicies: loaded };
      }
    } catch {
      // leave promotedPolicies undefined → treated as []
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
  if (isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")) {
    const repeatHypo = detectRepeatHypothesis(snapshot.failureAttempts);
    if (repeatHypo.isRepeating) {
      for (const dominant of repeatHypo.dominantSignatures) {
        if (!failureAvoided.includes(dominant.strategyCode)) {
          failureAvoided.push(dominant.strategyCode);
        }
      }
    }
  }
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
  const oracleConsulted = snapshot.oracleConsulted === true;
  const qaFailed = qa === "failed" || verification === "failed";
  // Phase 5: verdict from the failure-loop guard (repeat guards + circuit breaker).
  const loopAction =
    isFeatureFlagEnabled("MODUS_REPEAT_GUARDS") && qaFailed
      ? snapshot.failureLoopAction
      : undefined;
  const changeStrategy = selectChangeStrategy({
    avoided,
    qaFailed,
    oracleConsulted,
    openQuestionCount: openQuestions,
    preferReplanOnQaFail: promoted.preferReplanOnQaFail,
    preferRetrieveLocal: promoted.preferRetrieveLocal,
    ...(promoted.effects.length > 0 ? { promotedEffects: promoted.effects } : {}),
  });

  const base = {
    version: 1 as const,
    mode,
    policy,
    avoidStrategyCodes: avoided,
    verificationLevel: policy.verificationLevel,
    budgetTokens: budgetFor(policy.verificationLevel, complex),
    changeStrategy,
  };

  if (openQuestions > 0 && snapshot.taskState?.phase === "awaiting_user") {
    return {
      ...base,
      action: "ask_user",
      reasonCodes: [
        "open_questions",
        "awaiting_user_phase",
        ...changeStrategy.reasonCodes.filter((code) => code.startsWith("change_strategy_")),
      ].slice(0, 8),
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

  if (qaFailed) {
    // Phase 5 hard stop: the circuit breaker tripped, so replan instead of
    // retrying the same failing strategy (or consulting Oracle again).
    if (loopAction?.action === "circuit_break") {
      return withChangeStrategy(
        {
          ...base,
          action: "replan",
          reasonCodes: [
            "verification_failed",
            "repeat_guard_circuit_break",
            ...loopAction.reasonCodes,
          ].slice(0, 8),
          confidence: "high",
          expectedUncertaintyReduction: 12,
        },
        changeStrategy,
      );
    }

    // Gap 5: after Oracle findings, prefer a different strategy — never re-spawn Oracle.
    if (oracleConsulted) {
      if (changeStrategy.recommended === "ask_clarification") {
        return withChangeStrategy(
          {
            ...base,
            action: "ask_user",
            reasonCodes: [
              "change_strategy_ask_clarification",
              "oracle_findings_present",
              ...changeStrategy.reasonCodes,
            ].slice(0, 8),
            confidence: "high",
            expectedUncertaintyReduction: 16,
          },
          changeStrategy,
        );
      }
      if (changeStrategy.recommended === "retrieve_then_edit") {
        return withChangeStrategy(
          {
            ...base,
            action: "retrieve_local",
            reasonCodes: [
              "change_strategy_retrieve_then_edit",
              "oracle_findings_present",
              ...changeStrategy.reasonCodes,
            ].slice(0, 8),
            confidence: "medium",
            expectedUncertaintyReduction: 12,
          },
          changeStrategy,
        );
      }
      return withChangeStrategy(
        {
          ...base,
          action: "replan",
          reasonCodes: [
            "change_strategy_replan_scope",
            "oracle_findings_present",
            "verification_failed",
            ...changeStrategy.reasonCodes,
          ].slice(0, 8),
          confidence: "medium",
          expectedUncertaintyReduction: 12,
        },
        changeStrategy,
      );
    }

    const needsOracle =
      complex ||
      snapshot.impact?.blastRadius === "cross_module" ||
      snapshot.classification.suggestedRole === "oracle" ||
      snapshot.classification.suggestedRole === "debugger";
    const strategyAvoided =
      avoided.includes("same_edit_retry") ||
      avoided.includes("blind_retry") ||
      (isFeatureFlagEnabled("MODUS_REPEAT_GUARDS") &&
        (loopAction !== undefined ||
          (avoided.length > 0 && snapshot.failureAttempts.length >= 2)));

    // Gap 5: when a failed strategy is avoided but Oracle has not been consulted,
    // prefer Gap 1 spawn / advisory suggest_oracle over locking avoid_retry.
    if (strategyAvoided && needsOracle) {
      if (mode === "active") {
        return withChangeStrategy(
          {
            ...base,
            action: "spawn_readonly_specialist",
            specialistRole: policy.suggestedRole === "debugger" ? "debugger" : "oracle",
            reasonCodes: [
              "verification_failed",
              "high_risk_or_blast",
              "safe_readonly_spawn",
              "change_strategy_await_oracle",
            ],
            confidence: "medium",
            expectedUncertaintyReduction: 12,
          },
          changeStrategy,
        );
      }
      return withChangeStrategy(
        {
          ...base,
          action: "suggest_oracle",
          reasonCodes: [
            "verification_failed",
            "high_risk_or_blast",
            "change_strategy_await_oracle",
          ],
          confidence: "medium",
          expectedUncertaintyReduction: 12,
        },
        changeStrategy,
      );
    }

    // Soft blacklist / promoted avoid still blocks blind retries when Oracle is not needed.
    if (strategyAvoided) {
      return withChangeStrategy(
        {
          ...base,
          action: "avoid_retry",
          reasonCodes: [
            "duplicate_failed_strategy",
            "failure_intelligence_block",
            "change_strategy_replan_scope",
            ...promoted.reasonCodes.filter((code) => code.includes("avoid")),
          ].slice(0, 8),
          confidence: "high",
          expectedUncertaintyReduction: 8,
        },
        {
          ...changeStrategy,
          recommended:
            changeStrategy.recommended === "none" ? "replan_scope" : changeStrategy.recommended,
          reasonCodes: [...changeStrategy.reasonCodes, "change_strategy_replan_scope"].slice(0, 8),
        },
      );
    }

    // Gap 4: promoted prefer_replan when avoid codes did not fire (Oracle may still be pending).
    if (promoted.preferReplanOnQaFail) {
      return withChangeStrategy(
        {
          ...base,
          action: "replan",
          reasonCodes: [
            "verification_failed",
            "replan_after_failure",
            "promoted_policy_prefer_replan_on_qa_fail",
            ...changeStrategy.reasonCodes,
          ].slice(0, 8),
          confidence: "medium",
          expectedUncertaintyReduction: 10,
        },
        changeStrategy,
      );
    }

    if (needsOracle) {
      if (mode === "active") {
        return withChangeStrategy(
          {
            ...base,
            action: "spawn_readonly_specialist",
            specialistRole: policy.suggestedRole === "debugger" ? "debugger" : "oracle",
            reasonCodes: ["verification_failed", "high_risk_or_blast", "safe_readonly_spawn"],
            confidence: "medium",
            expectedUncertaintyReduction: 12,
          },
          changeStrategy,
        );
      }
      return withChangeStrategy(
        {
          ...base,
          action: "suggest_oracle",
          reasonCodes: ["verification_failed", "high_risk_or_blast"],
          confidence: "medium",
          expectedUncertaintyReduction: 12,
        },
        changeStrategy,
      );
    }
    return withChangeStrategy(
      {
        ...base,
        action: "replan",
        reasonCodes: ["verification_failed", "replan_after_failure"],
        confidence: "medium",
        expectedUncertaintyReduction: 10,
      },
      changeStrategy,
    );
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
  const recommended = decision.changeStrategy?.recommended;
  const strategySuffix =
    recommended && recommended !== "none"
      ? ` Recommended change strategy: ${recommended.replace(/_/g, " ")}.`
      : "";
  let hint: string | undefined;
  switch (decision.action) {
    case "suggest_plan":
      hint =
        "Adaptive policy: complex/high-blast scope detected. Consider Plan Mode or HyperPlan review; continue only if the user already chose otherwise.";
      break;
    case "suggest_oracle":
      hint =
        "Adaptive policy: high uncertainty or failed verification. Prefer read-only Oracle/reviewer advice before repeating the same edit strategy.";
      break;
    case "spawn_readonly_specialist":
      hint = `Adaptive policy: a read-only ${decision.specialistRole ?? "oracle"} specialist was auto-dispatched (Intent Gate + ToolRegistry permissions still apply). Wait for its findings before continuing edits.`;
      break;
    case "mcp_preflight":
      hint =
        "Adaptive policy: a read-only librarian MCP preflight was auto-dispatched. Allowlisted MCP tools run only through ToolRegistry + the permission broker; do not call non-allowlisted MCP tools.";
      break;
    case "verify":
      hint =
        "Adaptive policy: verification evidence is still required before treating this task as done. Use only the eligible required check scripts already named for this turn.";
      break;
    case "avoid_retry":
      hint = `Adaptive policy: an equivalent failed strategy was already tested at this revision. Do not repeat it; reformulate, gather new evidence, or ask the user.${strategySuffix}`;
      break;
    case "replan":
      hint = `Adaptive policy: last verification failed. Replan with a different strategy and record what was ruled out.${strategySuffix}`;
      break;
    case "retrieve_local":
      hint =
        "Adaptive policy: prefer bounded local CodeGraph/git/memory retrieval that reduces named uncertainties before broad file reads.";
      break;
    case "ask_user":
      hint =
        "Adaptive policy: open questions remain. Ask a focused clarifying question before continuing consequential work.";
      break;
    default:
      hint = undefined;
  }
  return hintAugmenter ? hintAugmenter(hint, decision) : hint;
}
