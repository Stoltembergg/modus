import { isFeatureFlagEnabled } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  TurnSettleInput,
  TurnSettleOutput,
} from "../kernel/harness-hooks";
import { HarnessObserver } from "./harness-observer";

/**
 * defaultObservabilityTurnSettleHook
 * Phase: turn_settle, Priority: 55
 * Consumes the ResponsePolicy evaluation produced by the preceding settle hook.
 * Turn outcomes and provider usage are recorded at the runtime boundary, where
 * terminal cancellation remains observable even after the kernel invalidates hooks.
 */
export const defaultObservabilityTurnSettleHook: HarnessHook<TurnSettleInput, TurnSettleOutput> = {
  name: "observability_turn_settle",
  phase: "turn_settle",
  priority: 55,
  isCritical: false,

  async execute(_input: TurnSettleInput, context: HarnessContext): Promise<TurnSettleOutput> {
    const defaultOutput: TurnSettleOutput = {
      settled: true,
      triggerContinuation: false,
    };

    if (
      !isFeatureFlagEnabled("MODUS_OBSERVABILITY") ||
      (context.isCurrent && !context.isCurrent())
    ) {
      return defaultOutput;
    }

    try {
      const observer = HarnessObserver.getInstance();
      const evaluation = context.state?.get("harness.response_policy_evaluation") as
        | { runId?: string; status?: string; violated?: boolean }
        | undefined;
      if (
        isFeatureFlagEnabled("MODUS_RESPONSE_POLICY") &&
        evaluation?.runId === context.runId &&
        evaluation.status === "evaluated" &&
        context.sessionToken &&
        context.state?.get("harness.response_policy_observed") !== true
      ) {
        observer.recordResponsePolicyEvaluation(
          evaluation.violated === true,
          context.sessionId,
          context.sessionToken,
          context.runId,
        );
        context.state.set("harness.response_policy_observed", true);
      }

      // Context state tag indicating observability harvested
      if (!context.isCurrent || context.isCurrent()) {
        context.state?.set("harness.observability_harvested", true);
      }

      return defaultOutput;
    } catch (err) {
      console.warn(
        `[Harness:Observability] Failed to harvest metrics in turn_settle: ${err instanceof Error ? err.message : String(err)}. Failing open.`,
      );
      return defaultOutput;
    }
  },
};
