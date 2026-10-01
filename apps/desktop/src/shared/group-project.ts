import {
  CHATS_WORKSPACE_ID,
  type GroupProjectContextSnapshot,
  type GroupProjectContextStatus,
} from "./contracts";

export type { GroupProjectContextSnapshot, GroupProjectContextStatus };

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

/** Primary room label: Mapping… or compact Ready / Updating / Needs refresh. */
export function formatGroupProjectContextLabel(status: GroupProjectContextStatus): string {
  switch (status) {
    case "mapping":
      return "Mapping project…";
    case "ready":
      return "Project context · Ready";
    case "updating":
      return "Project context · Updating";
    case "needs_refresh":
    case "failed":
      return "Project context · Needs refresh";
  }
}

/** Activity Details lines (diagnostics stay off the primary chat surface). */
export function formatGroupProjectContextDetails(
  snapshot: GroupProjectContextSnapshot,
): readonly string[] {
  const lines = [
    `Status: ${snapshot.status}`,
    snapshot.fingerprint
      ? `Fingerprint: ${snapshot.fingerprint.slice(0, 12)}`
      : "Fingerprint: (pending)",
    `Project Model edges: ${snapshot.edgeCount}`,
  ];
  if (snapshot.codegraphState) lines.push(`CodeGraph: ${snapshot.codegraphState}`);
  if (snapshot.revision) lines.push(`Revision: ${snapshot.revision.slice(0, 12)}`);
  if (snapshot.detail) lines.push(`Detail: ${snapshot.detail}`);
  if (snapshot.lastReadyAt) lines.push(`Last ready: ${snapshot.lastReadyAt}`);
  lines.push(`Updated: ${snapshot.updatedAt}`);
  return lines;
}
