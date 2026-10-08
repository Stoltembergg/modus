import { isFeatureFlagEnabled } from "../feature-flags";
import type {
  HarnessContext,
  HarnessHook,
  ToolsRegisterInput,
  ToolsRegisterOutput,
  TurnSettleInput,
  TurnSettleOutput,
  TurnStartInput,
  TurnStartOutput,
} from "../kernel/harness-hooks";
import { GroupMailbox } from "./group-mailbox";

function passThroughTurnStart(input: TurnStartInput): TurnStartOutput {
  return { ...input, proceed: (input as TurnStartOutput).proceed ?? true };
}

/**
 * Turn Start hook for Group Mailbox.
 * Checks for unread/pending messages for the current session/agent,
 * placing them onto context.state without interfering with turn execution.
 * Fail-open design.
 */
export const defaultTurnStartGroupMailboxHook: HarnessHook<TurnStartInput, TurnStartOutput> = {
  name: "harness_group_mailbox_turn_start",
  phase: "turn_start",
  priority: 28, // Runs after repeat guard (25), before turn executes
  isCritical: false,
  execute: async (input: TurnStartInput, context: HarnessContext): Promise<TurnStartOutput> => {
    if (!isFeatureFlagEnabled("MODUS_GROUPS_MAILBOX")) {
      return passThroughTurnStart(input);
    }

    try {
      const sessionId = context.sessionId;
      const mailbox = GroupMailbox.getInstance();
      const pendingMessages = mailbox.receive(sessionId);

      context.state.set("harness.group_mailbox_pending", pendingMessages);
      context.state.set("harness.group_mailbox_pending_count", pendingMessages.length);

      if (pendingMessages.length > 0) {
        // Log awareness in state for prompt composition or telemetry
        const summary = `Group Mailbox: ${pendingMessages.length} pending message(s) from [${pendingMessages.map((m) => m.from).join(", ")}]`;
        context.state.set("harness.group_mailbox_summary", summary);
      }
    } catch {
      // Fail-open: mailbox errors must not abort the turn
    }

    return passThroughTurnStart(input);
  },
};

/**
 * Turn Settle hook for Group Mailbox.
 * Purges expired messages per retention policies (7 days acked / 30 days unacked).
 */
export const defaultTurnSettleGroupMailboxHook: HarnessHook<TurnSettleInput, TurnSettleOutput> = {
  name: "harness_group_mailbox_turn_settle",
  phase: "turn_settle",
  priority: 35,
  isCritical: false,
  execute: async (input: TurnSettleInput, _context: HarnessContext): Promise<TurnSettleOutput> => {
    if (isFeatureFlagEnabled("MODUS_GROUPS_MAILBOX")) {
      try {
        GroupMailbox.getInstance().purgeExpired();
      } catch {
        // Fail-open
      }
    }

    return {
      settled: input.completed,
      triggerContinuation: false,
    };
  },
};

/**
 * Tools Register hook for Group Mailbox & Revision Tools.
 * Injects group mailbox tools when MODUS_GROUPS_MAILBOX is enabled.
 */
export const defaultToolsRegisterGroupMailboxHook: HarnessHook<
  ToolsRegisterInput,
  ToolsRegisterOutput
> = {
  name: "harness_group_mailbox_tools_register",
  phase: "tools_register",
  priority: 30,
  isCritical: false,
  execute: async (
    input: ToolsRegisterInput,
    _context: HarnessContext,
  ): Promise<ToolsRegisterOutput> => {
    const existing = input.requestedTools ?? [];
    if (!isFeatureFlagEnabled("MODUS_GROUPS_MAILBOX")) {
      return {
        registeredTools: existing,
        spillThresholdBytes: input.activeSpillThresholdBytes ?? 51200,
      };
    }

    const groupTools = [
      "group_mailbox_send",
      "group_mailbox_receive",
      "group_mailbox_ack",
      "group_revision_check",
    ];

    const merged = Array.from(new Set([...existing, ...groupTools]));

    return {
      registeredTools: merged,
      spillThresholdBytes: input.activeSpillThresholdBytes ?? 51200,
    };
  },
};
