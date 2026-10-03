import type { GroupMessage } from "../../../../shared/contracts";
import { isLegacyWaitingForYouBody } from "../../../../shared/group-room-locale";

/**
 * Amber "Waiting for you" (C6), from structured state first:
 *
 * 1. Structured: the turn card itself is `status: "awaiting_user"` (the
 *    `GroupMessageStatus` the runtime has set since 90b751e, when a member's
 *    turn waits on the user: intent gate open or a HyperPlan choice pending).
 * 2. Legacy fallback: rows written before that only carry the English status
 *    body "Waiting for you" (`kind: "status"`, no `status`). Those are still
 *    detected by text, so old transcripts keep their amber / stale styling.
 *
 * No IPC or DB field was added: both signals already exist in `GroupMessage`.
 */
export type GroupWaitingSource = "status" | "legacy-text";

export function groupMessageWaitingSource(
  message: Pick<GroupMessage, "kind" | "status" | "body">,
): GroupWaitingSource | undefined {
  if (message.status === "awaiting_user") return "status";
  if (message.kind === "status" && isLegacyWaitingForYouBody(message.body)) return "legacy-text";
  return undefined;
}

export function isGroupMessageWaitingForYou(
  message: Pick<GroupMessage, "kind" | "status" | "body">,
): boolean {
  return groupMessageWaitingSource(message) !== undefined;
}

function hasSession(ids: ReadonlySet<string> | readonly string[], sessionId: string): boolean {
  if (typeof (ids as ReadonlySet<string>).has === "function") {
    return (ids as ReadonlySet<string>).has(sessionId);
  }
  return (ids as readonly string[]).includes(sessionId);
}

/**
 * `active` = waiting, and its author is in the room's live
 * `waitingSessionIds` (a pending ask_user / approval right now); `stale` =
 * a waiting row whose ask is over (keeps the text, loses the sticky amber).
 */
export function groupMessageWaitingState(
  message: Pick<GroupMessage, "kind" | "status" | "body" | "authorSessionId">,
  activeWaitingSessionIds: ReadonlySet<string> | readonly string[],
): "active" | "stale" | undefined {
  if (!isGroupMessageWaitingForYou(message)) return undefined;
  return message.authorSessionId && hasSession(activeWaitingSessionIds, message.authorSessionId)
    ? "active"
    : "stale";
}
