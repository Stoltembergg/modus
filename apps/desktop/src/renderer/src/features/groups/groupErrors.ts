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
  "verification-required": "Complete the task's required verification before closing it.",
  "permission-denied": "Allow Git access before applying or aborting this task integration.",
  "stale-task": "The task changed. Refresh it and try again.",
  "dependency-cycle": "The task dependencies contain a cycle.",
  "invalid-dependency": "Choose tasks in this group as dependencies.",
  "stale-evidence": "The task evidence is out of date. Run verification again.",
  "self-review": "A task's owner can't review their own task.",
  "ambiguous-member": "More than one member has that name. Pick the chat by its id.",
  "no-git-project": "Member worktrees need the group's Project to be a Git repository.",
  "branch-checked-out":
    "The member's branch is checked out in another folder. Switch that checkout to another branch first.",
  "call-alone": "The member must start its worktree with a message that makes no other tool call.",
  "invalid-text": "A decision needs 1 to 500 characters of text.",
  "limit-reached": "This group already has 100 decisions. Delete one first.",
  "not-coordinator": "Only the group's Lead can assign tasks.",
  "coordinator-off": "Coordinator mode is off, or the group has no Lead.",
  "agent-not-found": "That agent no longer exists.",
  "agent-name-taken": "Another agent already has that name.",
  "group-project-required": "Choose a folder to continue this group.",
  "member-archived": "That agent is archived. Restore it first.",
  "group-min-members": "A group needs at least 2 agents.",
  "group-max-members": "A group can have at most 10 agents.",
  "agent-model-required": "Choose a model for this agent.",
  "agent-model-unavailable": "That model is not available. Connect its provider or choose another.",
  "agent-avatar-shape-taken": "Another agent in this group already uses that shape.",
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
