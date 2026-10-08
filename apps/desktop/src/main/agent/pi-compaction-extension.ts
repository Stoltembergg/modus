import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  calculateCompactionMetrics,
  getCompactionPolicy,
} from "./harness/compaction/compaction-policy";
import {
  estimateTokens,
  identifyPruneCandidates,
  type MessageLike,
  pruneCandidates,
} from "./harness/compaction/compaction-pruner";
import { isFeatureFlagEnabled } from "./harness/feature-flags";

type AgentMessage = any;

/**
 * Converts AgentMessage[] to MessageLike[] for pruning analysis.
 */
function toMessageLikes(messages: AgentMessage[]): MessageLike[] {
  return messages.map((msg: any, idx: number) => {
    const role = msg.role ?? (msg.type === "message" ? msg.message?.role : "user") ?? "user";
    const content = msg.content ?? msg.message?.content ?? "";
    const toolName =
      msg.toolName ??
      msg.tool ??
      (Array.isArray(content)
        ? content.find((c: any) => c.toolName || c.type === "tool_use" || c.type === "toolCall")?.toolName
        : undefined);

    return {
      id: msg.id ?? `msg-${idx}`,
      role,
      content,
      ...(toolName ? { toolName } : {}),
      timestamp: msg.timestamp ?? Date.now(),
    };
  });
}

/**
 * PI SDK Extension Factory that:
 * 1. Hooks into `context` to apply non-destructive pruning directly to messages sent to the LLM.
 * 2. Hooks into `session_before_compact` to safely cancel compaction only when under threshold,
 *    respecting manual compaction and never replacing real LLM summaries with previousSummary.
 */
export function createModusCompactionExtension(sessionId: string): ExtensionFactory {
  return (pi) => {
    // 1. Context hook: Intelligent preventive pruning for model requests
    pi.on("context", async (event, ctx) => {
      if (!isFeatureFlagEnabled("MODUS_COMPACTION_PRUNING")) {
        return undefined;
      }

      if (!event.messages || event.messages.length === 0) {
        return undefined;
      }

      const modelId = ctx?.model?.id;
      const policy = getCompactionPolicy(modelId, ctx?.model?.contextWindow);
      const messageLikes = toMessageLikes(event.messages);

      const usageTokens = ctx?.getContextUsage?.()?.tokens;
      const currentTokens =
        usageTokens && usageTokens > 0
          ? usageTokens
          : messageLikes.reduce((acc, m) => {
              const text =
                typeof m.content === "string"
                  ? m.content
                  : (m.content as any[]).map((c) => c.text ?? "").join("\n");
              return acc + estimateTokens(text);
            }, 0);

      const metrics = calculateCompactionMetrics(policy, currentTokens);
      if (!metrics.isOverThreshold || metrics.tokensToPrune <= 0) {
        return undefined;
      }

      const candidates = identifyPruneCandidates(messageLikes);
      if (candidates.length === 0) {
        return undefined;
      }

      const pruneResult = pruneCandidates(candidates, metrics.tokensToPrune);
      if (pruneResult.replacements.size === 0) {
        return undefined;
      }

      // Apply replacements non-destructively to the messages returned for LLM context
      const prunedMessages: AgentMessage[] = event.messages.map((msg: any, idx: number) => {
        const id = msg.id ?? `msg-${idx}`;
        const tombstone = pruneResult.replacements.get(id);
        if (!tombstone) {
          return msg;
        }

        if (typeof msg.content === "string") {
          return { ...msg, content: tombstone };
        }

        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: [{ type: "text", text: tombstone }],
          };
        }

        return { ...msg, content: tombstone };
      });

      return { messages: prunedMessages };
    });

    // 2. Compaction hook: Guard against unnecessary compactions without loss of context
    pi.on("session_before_compact", async (event, ctx) => {
      if (!isFeatureFlagEnabled("MODUS_COMPACTION_PRUNING")) {
        return undefined;
      }

      // Never cancel manual compaction triggered by the user (/compact)
      if (event.reason === "manual") {
        return undefined;
      }

      const preparation = event.preparation;
      if (!preparation) {
        return undefined;
      }

      const modelId = ctx?.model?.id;
      const policy = getCompactionPolicy(modelId, ctx?.model?.contextWindow);
      const tokensBefore = preparation.tokensBefore ?? 0;
      const metrics = calculateCompactionMetrics(policy, tokensBefore);

      // Overflow recovery is never redundant: the context already exceeded the real
      // window, so cancelling here would retry into the same overflow.
      const overflowRecovery = event.reason === "overflow";
      const exceededWindow = tokensBefore > policy.contextWindow;

      // If under threshold (and not already past the window), compaction is redundant
      if (!overflowRecovery && !exceededWindow && !metrics.isOverThreshold) {
        return { cancel: true };
      }

      // Compaction is genuinely required: return undefined so PI SDK executes
      // its native LLM compact() method to generate a real, high-fidelity summary.
      // We NEVER return a pseudo-summary containing only previousSummary + evidence,
      // as that drops messagesToSummarize without summarizing them.
      return undefined;
    });
  };
}
