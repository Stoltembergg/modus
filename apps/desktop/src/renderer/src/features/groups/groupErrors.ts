import { decodeGroupErrorMessage, type GroupErrorCode } from "../../../../shared/group-errors";

/** Readable English message per group error code (the store's text is for logs). */
export const GROUP_ERROR_MESSAGES: Record<GroupErrorCode, string> = {
  "group-not-found": "This group no longer exists.",
  "workspace-not-found": "The selected project no longer exists.",
  "session-not-found": "One of the selected chats no longer exists.",
  "message-not-found": "That message isn't part of this group.",
  "task-not-found": "That task no longer exists.",
  "decision-not-found": "That decision no longer exists.",
  "workspace-mismatch":
    "Every member must belong to the group's project (or have no folder when the group has no project).",
  "already-in-group": "One of the selected chats is already in another group.",
  "subagent-session": "Subagent chats can't join a group.",
  "archived-session": "Archived chats can't join a group. Restore the chat first.",
  "not-a-member": "That chat isn't a member of this group.",
  "invalid-value": "Some of the group details are invalid.",
  "not-owner": "Only the task's owner can do that.",
  "not-reviewer": "Only the task's reviewer can do that.",
  "task-taken": "That task already has an owner.",
  "invalid-transition": "That task can't move to that status from where it is.",
  "self-review": "A task's owner can't review their own task.",
};

/**
 * User-facing text for an error from `window.modus.group.*`: the mapped
 * message for a known code; otherwise the raw message (without Electron's
 * "Error invoking remote method" prefix).
 */
export function describeGroupError(error: unknown): string {
  const { code, message } = decodeGroupErrorMessage(error);
  return code ? GROUP_ERROR_MESSAGES[code] : message;
}
