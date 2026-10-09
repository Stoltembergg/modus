import { isFeatureFlagEnabled } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  TurnSettleInput,
  TurnSettleOutput,
} from "../kernel/harness-hooks";
import { ResponsePolicyRegistry } from "../response/response-registry";
import { HarnessObserver } from "./harness-observer";

/**
 * defaultObservabilityTurnSettleHook
 * Phase: turn_settle, Priority: 55
 * Automatically harvests turn metrics, session activity, and telemetry for the Observability Dashboard.
 * Operates strictly with fail-open safeguards.
 */
export const defaultObservabilityTurnSettleHook: HarnessHook<TurnSettleInput, TurnSettleOutput> = {
  name: "observability_turn_settle",
  phase: "turn_settle",
  priority: 55,
  isCritical: false,

  async execute(input: TurnSettleInput, context: HarnessContext): Promise<TurnSettleOutput> {
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
      const sessionId = context.sessionId;

      // Calculate turn duration if start timestamp is present in context state
      const startMs = context.state?.get("harness.turn_start_time");
      const durationMs =
        typeof startMs === "number" && startMs > 0 ? Math.max(0, Date.now() - startMs) : 0;

      if (sessionId) {
        observer.recordSessionTurn(sessionId, durationMs, context.sessionToken);
      }

      // Attribute response outcomes from this turn's state. Registry totals
      // are global, so assigning their deltas to the current session can leak
      // concurrent work into the wrong session.
      const responsePolicyFromRun = context.state?.get("harness.response_policy") as
        | { enforcementMode?: string }
        | undefined;
      const responsePolicy =
        responsePolicyFromRun ??
        (sessionId ? ResponsePolicyRegistry.getInstance().getSessionPolicy(sessionId) : undefined);
      const rawResponse = context.state?.get("harness.assistant_response");
      const formattedResponse = context.state?.get("harness.formatted_response");
      const violation = context.state?.get("harness.response_violated") === true;
      if (
        isFeatureFlagEnabled("MODUS_RESPONSE_POLICY") &&
        responsePolicy &&
        typeof rawResponse === "string" &&
        typeof formattedResponse === "string" &&
        context.state?.get("harness.response_policy_observed") !== true
      ) {
        const formatted = violation && responsePolicy.enforcementMode === "strict";
        const charsSaved =
          formatted && typeof formattedResponse === "string"
            ? Math.max(0, rawResponse.length - formattedResponse.length)
            : 0;
        observer.recordResponsePolicyEvaluation(
          violation,
          formatted,
          charsSaved,
          0,
          sessionId,
          context.sessionToken,
        );
        context.state.set("harness.response_policy_observed", true);
      }

      // Record any prompt tokens saved from the current turn
      const tokensSaved = context.state?.get("harness.prompt_tokens_saved");
      if (typeof tokensSaved === "number" && tokensSaved > 0) {
        observer.recordPromptSections([], [], tokensSaved, sessionId, context.sessionToken);
      }

      // Track assistant token metrics from the input
      if (input.turnTokens > 0) {
        observer.recordPromptSections([], [], 0, sessionId, context.sessionToken);
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
