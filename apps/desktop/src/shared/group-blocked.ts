import { groupNeedsProject } from "./group-project";

/** A group has between 2 and 10 member agents (archived ones count). */
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 10;

export type GroupBlockedReason = "project-required" | "min-members";

/**
 * Why a group is read-only, or null when it works. The ONE check shared by IPC,
 * runtime and the room banner. While blocked, send, mention, assign and wake are
 * refused; adding a member and choosing a folder stay allowed (the way out).
 * - "project-required": `workspace_id` null or the Chats inbox (groupNeedsProject).
 * - "min-members": fewer than 2 members (e.g. an agent was deleted).
 * A legacy group with more than 10 members is NOT blocked (only adding is refused).
 */
export function groupBlockedReason(
  group: { workspaceId?: string | null | undefined },
  members: readonly unknown[] | number,
): GroupBlockedReason | null {
  if (groupNeedsProject(group)) return "project-required";
  const count = typeof members === "number" ? members : members.length;
  if (count < GROUP_MIN_MEMBERS) return "min-members";
  return null;
}

/** The error code a blocked group answers with when someone sends, mentions or assigns. */
export function groupBlockedErrorCode(
  reason: GroupBlockedReason,
): "group-project-required" | "group-min-members" {
  return reason === "project-required" ? "group-project-required" : "group-min-members";
}

/** The member-count rule on create: 2..10 agents. */
export function groupCreateCountError(
  count: number,
): "group-min-members" | "group-max-members" | null {
  if (count < GROUP_MIN_MEMBERS) return "group-min-members";
  if (count > GROUP_MAX_MEMBERS) return "group-max-members";
  return null;
}

/**
 * The member-count rule for a membership change from `current` to `next`
 * members. Only the direction of the change is checked, so a legacy group
 * outside 2..10 is left alone until someone moves it further out:
 * - growing beyond 10 → "group-max-members" (an 11-member legacy group works,
 *   but cannot grow);
 * - shrinking below 2 → "group-min-members" (removing at 2 is refused; a
 *   1-member legacy group may grow back).
 */
export function groupMemberCountError(
  current: number,
  next: number,
): "group-min-members" | "group-max-members" | null {
  if (next > current && next > GROUP_MAX_MEMBERS) return "group-max-members";
  if (next < current && next < GROUP_MIN_MEMBERS) return "group-min-members";
  return null;
}

/**
 * The 2..10 rule for ONE `group:update-members` change, on the FINAL count
 * (`current - removed + added`): fewer than 2 → min. Above 10 → max when the
 * change adds anyone; a legacy group above 10 may still remove members (its
 * count only shrinks toward the range), but can never add while above 10.
 */
export function groupMembersUpdateCountError(
  current: number,
  added: number,
  removed: number,
): "group-min-members" | "group-max-members" | null {
  const final = current - removed + added;
  if (final < GROUP_MIN_MEMBERS) return "group-min-members";
  if (added > 0 && final > GROUP_MAX_MEMBERS) return "group-max-members";
  return null;
}

/** The room banner (and error message) for each blocked reason. */
export const GROUP_BLOCKED_TEXT: Record<GroupBlockedReason, string> = {
  "project-required": "Choose a folder to continue this group",
  "min-members": "Add a member to continue",
};
