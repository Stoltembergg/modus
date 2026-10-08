import type { AdaptiveFailureAttempt } from "../../../../shared/contracts";
import { isFeatureFlagEnabled } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  TurnStartInput,
  TurnStartOutput,
  VerificationCheckInput,
  VerificationCheckOutput,
} from "../kernel/harness-hooks";
import {
  CircuitBreakerRegistry,
  detectFailureLoop,
  type FailureLoopAction,
} from "./failure-loop-guard";
import { detectRepeatHypothesis } from "./repeat-hypothesis-guard";
import { detectRepeatTools, ToolInvocationTracker } from "./repeat-tool-guard";

/**
 * Preserves everything the upstream intent hook produced (classification,
 * gateResult, effectiveMessage and, crucially, an abort via `proceed: false`),
 * defaulting `proceed` to true only when this hook is the sole one in the phase.
 */
function passThroughTurnStart(input: TurnStartInput): TurnStartOutput {
  return { ...input, proceed: (input as TurnStartOutput).proceed ?? true };
}

/**
 * Turn Start hook that assesses repeat tool loops and circuit breaker status.
 * Fail-open design: logs warnings and never overrides an upstream gate abort.
 */
export const defaultTurnStartRepeatGuardHook: HarnessHook<
  TurnStartInput,
  TurnStartOutput
> = {
  name: "harness_repeat_guard_turn_start",
  phase: "turn_start",
  priority: 25, // Runs after classification/intent gate
  isCritical: false,
  execute: async (
    input: TurnStartInput,
    context: HarnessContext,
  ): Promise<TurnStartOutput> => {
    if (!isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")) {
      return passThroughTurnStart(input);
    }

    try {
      const sessionId = context.sessionId;
      const tracker = ToolInvocationTracker.getInstance();
      const breaker = CircuitBreakerRegistry.getInstance();

      const invocations = tracker.getInvocations(sessionId);
      const repeatPatterns = detectRepeatTools(invocations);

      // Store analysis on context.state for consumption by meta-controller or runtime
      context.state.set("harness.repeat_tools", repeatPatterns);
      context.state.set("harness.circuit_breaker_open", breaker.isOpen(sessionId));

      if (breaker.isOpen(sessionId)) {
        const record = breaker.getRecord(sessionId);
        // We log circuit breaker condition but maintain proceed with warning metadata
        // so interactive recovery is always possible without freezing the session.
        context.state.set("harness.circuit_breaker_warning", record.trippedReason);
      }

      return passThroughTurnStart(input);
    } catch (err) {
      console.warn("[modus-harness] Repeat guard turn start hook error (fail-open):", err);
      return passThroughTurnStart(input);
    }
  },
};

/**
 * Verification Check hook that detects repetitive failure loops and trips circuit breaker if needed.
 */
export const defaultVerificationRepeatGuardHook: HarnessHook<
  VerificationCheckInput,
  VerificationCheckOutput
> = {
  name: "harness_repeat_guard_verification",
  phase: "verification_check",
  priority: 30,
  isCritical: false,
  execute: async (
    input: VerificationCheckInput,
    context: HarnessContext,
  ): Promise<VerificationCheckOutput> => {
    // This hook runs after `verification_check_qa`, which chains its output into
    // this hook's input. Prefer the explicit exit code, otherwise keep the
    // upstream verdict instead of re-deriving it from a field that is no longer there.
    const upstreamVerified = (input as { verified?: boolean | undefined }).verified;
    const resolveVerified = (): boolean =>
      input.exitCode !== undefined ? input.exitCode === 0 : (upstreamVerified ?? false);

    const failOpen = (): VerificationCheckOutput => ({
      ...(input as unknown as VerificationCheckOutput),
      verified: resolveVerified(),
      suggestedAction: resolveVerified() ? "proceed" : "retry",
    });

    if (!isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")) {
      return failOpen();
    }

    try {
      const sessionId = context.sessionId;
      const tracker = ToolInvocationTracker.getInstance();
      const breaker = CircuitBreakerRegistry.getInstance();

      const invocations = tracker.getInvocations(sessionId);
      const repeatTools = detectRepeatTools(invocations);

      const attempts: AdaptiveFailureAttempt[] =
        context.state.get("harness.failure_attempts") ?? [];

      const loopAction: FailureLoopAction | undefined = detectFailureLoop({
        attempts,
        repeatTools,
      });

      if (loopAction) {
        context.state.set("harness.loop_action", loopAction);

        if (loopAction.action === "circuit_break") {
          breaker.trip(sessionId, loopAction.reason);
          return {
            ...(input as unknown as VerificationCheckOutput),
            verified: false,
            failureReason: loopAction.reason,
            suggestedAction: "replan",
            violations: loopAction.reasonCodes,
          };
        }

        if (
          loopAction.action === "change_strategy" ||
          loopAction.action === "consult_oracle" ||
          loopAction.action === "delegate"
        ) {
          return {
            ...(input as unknown as VerificationCheckOutput),
            verified: false,
            failureReason:
              loopAction.action === "change_strategy"
                ? loopAction.suggestion
                : loopAction.action === "delegate"
                  ? loopAction.task
                  : loopAction.reason,
            suggestedAction: "replan",
            violations: loopAction.reasonCodes,
          };
        }
      }

      return failOpen();
    } catch (err) {
      console.warn("[modus-harness] Repeat guard verification hook error (fail-open):", err);
      return failOpen();
    }
  },
};
