import type { GroupRuntimeEvent } from "../../../../shared/contracts";

/**
 * Whether a room event should reload tasks/decisions from the DB.
 *
 * Streaming updates emit many `group.message` pushes (and frequent activity
 * ticks while members work). Re-querying on every one freezes the room.
 * Refresh only when the event can actually change the side panel:
 * - `group.activity` / `group.chain-ended` (turns start or end; tools run there)
 * - `group.message` with `kind === "status"` (Decision/task status lines)
 */
export function shouldRefreshGroupSidePanel(groupId: string, event: GroupRuntimeEvent): boolean {
  if (!("groupId" in event) || event.groupId !== groupId) return false;
  if (event.type === "group.activity" || event.type === "group.chain-ended") return true;
  if (event.type === "group.message") return event.message.kind === "status";
  return false;
}
