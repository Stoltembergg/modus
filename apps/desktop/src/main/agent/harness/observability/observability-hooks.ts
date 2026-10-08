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

    if (!isFeatureFlagEnabled("MODUS_OBSERVABILITY")) {
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
        observer.recordSessionTurn(sessionId, durationMs);
      }

      // Mirror response-policy evaluations recorded earlier in this turn_settle
      // (the response hook runs at priority 40, before this hook at 55).
      // Without this, violations/formatted/charsSaved would never reach the
      // observer in production: the registry has no other reader.
      // Delta-based, so repeated turns never double count.
      const responseMetrics = ResponsePolicyRegistry.getInstance().getMetrics();
      observer.mirrorResponsePolicyMetrics(
        {
          violationsDetected: responseMetrics.violationsDetected,
          totalFormatted: responseMetrics.totalFormatted,
          charactersSaved: responseMetrics.charactersSaved,
        },
        sessionId
      );

      // Record any prompt tokens saved from the current turn
      const tokensSaved = context.state?.get("harness.prompt_tokens_saved");
      if (typeof tokensSaved === "number" && tokensSaved > 0) {
        observer.recordPromptSections([], [], tokensSaved, sessionId);
      }

      // Track assistant token metrics from the input
      if (input.turnTokens > 0) {
        observer.recordPromptSections([], [], 0, sessionId);
      }

      // Context state tag indicating observability harvested
      context.state?.set("harness.observability_harvested", true);

      return defaultOutput;
    } catch (err) {
      console.warn(
        `[Harness:Observability] Failed to harvest metrics in turn_settle: ${err instanceof Error ? err.message : String(err)}. Failing open.`
      );
      return defaultOutput;
    }
  },
};
