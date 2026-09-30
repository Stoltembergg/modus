import type { AgentEvent } from "../../../../shared/contracts";
import { getToolUiMeta } from "../../../../shared/tools";

/** Phase shown while a group member's turn is live (or queued). */
export type GroupMemberWorkingPhase = "queued" | "thinking" | "writing" | "working" | string;

/**
 * Derive a short phase label from the latest agent events for a member turn.
 * Mirrors ChatPane WorkFold: real events only — no timers, no fabricated phases.
 */
export function groupMemberWorkingPhase(
  events: readonly { event: AgentEvent }[],
  mode: "running" | "queued",
): GroupMemberWorkingPhase {
  if (mode === "queued") return "Queued";

  const openTools = new Set<string>();
  let phase: GroupMemberWorkingPhase = "Thinking";

  for (const { event } of events) {
    switch (event.type) {
      case "run.started":
        openTools.clear();
        phase = "Thinking";
        break;
      case "thinking.delta":
        phase = "Thinking";
        break;
      case "thinking.completed":
        if (openTools.size === 0) phase = "Thinking";
        break;
      case "message.delta":
        phase = "Writing";
        break;
      case "message.started":
        if (event.role === "assistant") phase = "Writing";
        break;
      case "tool.started":
      case "tool.delta": {
        openTools.add(event.toolCallId);
        phase = getToolUiMeta(event.toolName)?.activeVerb ?? "Working";
        break;
      }
      case "tool.ended":
        openTools.delete(event.toolCallId);
        phase = openTools.size > 0 ? phase : "Thinking";
        break;
      case "compaction.started":
        phase = "Compacting context";
        break;
      case "compaction.ended":
        phase = "Thinking";
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.blocked":
        openTools.clear();
        phase = "Thinking";
        break;
      default:
        break;
    }
  }

  return phase;
}

/** Running members first (stable order), then queued — for the room working strip. */
export function listGroupWorkingSessionIds(entry: {
  runningSessionIds: readonly string[];
  queuedSessionIds: readonly string[];
}): Array<{ sessionId: string; mode: "running" | "queued" }> {
  const seen = new Set<string>();
  const out: Array<{ sessionId: string; mode: "running" | "queued" }> = [];
  for (const sessionId of entry.runningSessionIds) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({ sessionId, mode: "running" });
  }
  for (const sessionId of entry.queuedSessionIds) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({ sessionId, mode: "queued" });
  }
  return out;
}
