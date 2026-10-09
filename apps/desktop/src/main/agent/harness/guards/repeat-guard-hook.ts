import type { AdaptiveFailureAttempt } from "../../../../shared/contracts";
import { isFeatureFlagEnabled } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  ToolCallInput,
  ToolCallOutput,
  ToolResultInput,
  ToolResultOutput,
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
import {
  type RepeatGuardDecision,
  detectRepeatTools,
  detectUnproductiveToolRepeat,
  ToolInvocationTracker,
} from "./repeat-tool-guard";

/** Pi SDK pre-execution hook: its block decision is consumed before tool execution. */
export const defaultToolCallRepeatGuardHook: HarnessHook<ToolCallInput, ToolCallOutput> = {
  name: "harness_repeat_guard_tool_call",
  phase: "tool_call",
  priority: 10,
  isCritical: false,
  execute: (input: ToolCallInput, context: HarnessContext): ToolCallOutput => {
    if (!isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")) return input;

    const pattern = detectUnproductiveToolRepeat(
      ToolInvocationTracker.getInstance().getInvocations(context.sessionId, context.runId),
      input.toolName,
      input.input,
    );
    if (!pattern) return input;

    const attempts: AdaptiveFailureAttempt[] = context.state.get("harness.failure_attempts") ?? [];
    const loopAction = detectFailureLoop({ attempts, repeatTools: [pattern] }) ?? {
      action: "change_strategy" as const,
      suggestion: `Do not repeat the same ${input.toolName} call without new progress. Change its inputs or strategy.`,
      reasonCodes: ["tool_loop_detected", "tool_loop_change_strategy", ...pattern.reasons],
    };
    const failureLoopAction = {
      ...loopAction,
      reasonCodes: [...new Set(["tool_loop_detected", ...loopAction.reasonCodes])].slice(0, 8),
    };
    const decision: RepeatGuardDecision = {
      action: "block",
      sessionId: context.sessionId,
      runId: context.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      reasonCode: "repeat_guard_tool_loop",
      reason: `Blocked ${input.toolName}: ${pattern.count} consecutive identical calls made no progress. Change the inputs or approach.`,
      pattern,
      failureLoopAction,
    };
    context.state.set("harness.repeat_guard_decision", decision);
    return { ...input, repeatGuardDecision: decision };
  },
};

/** Pi SDK post-execution hook: records only calls authorized by the pre-execution hook. */
export const defaultToolResultRepeatGuardHook: HarnessHook<ToolResultInput, ToolResultOutput> = {
  name: "harness_repeat_guard_tool_result",
  phase: "tool_result",
  priority: 10,
  isCritical: false,
  execute: (input: ToolResultInput, context: HarnessContext): ToolResultOutput => {
    if (isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")) {
      ToolInvocationTracker.getInstance().record(
        context.sessionId,
        context.runId,
        input.toolName,
        input.input,
        {
          toolCallId: input.toolCallId,
          outcome: input.outcome,
          resultFingerprint: input.resultFingerprint,
          progressFingerprint: input.progressFingerprint,
        },
      );
    }
    return input;
  },
};

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
export const defaultTurnStartRepeatGuardHook: HarnessHook<TurnStartInput, TurnStartOutput> = {
  name: "harness_repeat_guard_turn_start",
  phase: "turn_start",
  priority: 25, // Runs after classification/intent gate
  isCritical: false,
  execute: async (input: TurnStartInput, context: HarnessContext): Promise<TurnStartOutput> => {
    if (!isFeatureFlagEnabled("MODUS_REPEAT_GUARDS")) {
      return passThroughTurnStart(input);
    }

    try {
      const sessionId = context.sessionId;
      const tracker = ToolInvocationTracker.getInstance();
      const breaker = CircuitBreakerRegistry.getInstance();

      const invocations = tracker.getInvocations(sessionId, context.runId);
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

      const invocations = tracker.getInvocations(sessionId, context.runId);
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
