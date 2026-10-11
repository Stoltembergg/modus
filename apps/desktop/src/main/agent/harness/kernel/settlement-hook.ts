import type {
  HarnessContext,
  HarnessHook,
  TurnSettleInput,
  TurnSettleOutput,
} from "./harness-hooks";

/**
 * Standard Turn Settle Hook:\n * Finalizes turn state, evaluates if todo items require auto-continuation,
 * and seals the execution step.
 */
export const turnSettleHook: HarnessHook<TurnSettleInput, TurnSettleOutput> = {
  name: "turn_settle_continuation",
  phase: "turn_settle",
  priority: 10,
  isCritical: false,
  execute: async (input: TurnSettleInput, context: HarnessContext): Promise<TurnSettleOutput> => {
    // Check if task continuation is flagged in context or input
    const hasUnfinishedWork =
      context.state.get("has_unfinished_work") === true || input.hasActiveTodos;

    return {
      settled: true,
      triggerContinuation: hasUnfinishedWork,
      shouldContinue: hasUnfinishedWork,
      continuationPrompt: hasUnfinishedWork ? "Continue executing pending task items." : undefined,
      taskComplete: !hasUnfinishedWork,
    };
  },
};
