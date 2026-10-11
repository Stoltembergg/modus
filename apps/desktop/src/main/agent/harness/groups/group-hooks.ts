import { isFeatureFlagEnabled } from "../feature-flags";
import type { HarnessHook, TurnSettleInput, TurnSettleOutput } from "../kernel/harness-hooks";
import { GroupMailbox } from "./group-mailbox";

/**
 * Retention cleanup runs after ResponsePolicy and HarnessObserver consume the
 * complete turn outcome; this hook must not replace their settle input.
 */
export const defaultTurnSettleGroupMailboxHook: HarnessHook<TurnSettleInput, TurnSettleOutput> = {
  name: "harness_group_mailbox_turn_settle",
  phase: "turn_settle",
  priority: 65,
  isCritical: false,
  execute: async (_input: TurnSettleInput): Promise<TurnSettleOutput> => {
    if (isFeatureFlagEnabled("MODUS_GROUPS_MAILBOX")) GroupMailbox.getInstance().purgeExpired();
    return {
      settled: true,
      triggerContinuation: false,
    };
  },
};
