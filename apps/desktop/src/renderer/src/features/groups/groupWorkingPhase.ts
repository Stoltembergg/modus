import type { AgentEvent } from "../../../../shared/contracts";
import { buildGroupSemanticPresence } from "../../../../shared/group-semantic-presence";

/** Phase shown while a group member's turn is live (or queued). */
export type GroupMemberWorkingPhase = "queued" | "thinking" | "writing" | "working" | string;

/**
 * Derive a short phase label from the latest agent events for a member turn.
 * Uses semantic presence (N0) so the room shows Exploring / Implementing / …
 * instead of sticking on a generic Thinking or raw tool verb.
 */
export function groupMemberWorkingPhase(
  events: readonly { event: AgentEvent; createdAt?: string }[],
  mode: "running" | "queued",
): GroupMemberWorkingPhase {
  return buildGroupSemanticPresence(events, mode).label;
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
