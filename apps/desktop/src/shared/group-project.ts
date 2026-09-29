import { CHATS_WORKSPACE_ID } from "./contracts";

/**
 * A group "needs a folder" when it has no Project: `workspace_id` null (legacy
 * groups from before the folder became mandatory) or the Chats inbox id. Such a
 * group is read-only (no send, mention, assign or wake) until a folder is
 * picked, and creating or moving a group there fails with
 * `group-project-required`. The one predicate shared by IPC, store, runtime
 * and renderer.
 */
export function groupNeedsProject(group: { workspaceId?: string | null | undefined }): boolean {
  return !group.workspaceId || group.workspaceId === CHATS_WORKSPACE_ID;
}
