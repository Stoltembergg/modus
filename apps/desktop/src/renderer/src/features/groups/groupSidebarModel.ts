import type { AgentGroupWithMembers, AgentSessionInfo } from "../../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../../shared/contracts";

/** Every session id that belongs to some group; the sidebar hides these from other sections. */
export function groupMemberSessionIds(groups: readonly AgentGroupWithMembers[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const member of group.members) ids.add(member.sessionId);
  }
  return ids;
}

/**
 * Sessions the create-group dialog may offer for a group owned by
 * `workspaceId` (null = no Project). Mirrors the store's rules so the dialog
 * never lists a session the store would refuse: same workspace (the Chats
 * inbox when there is no Project), not already in a group, not a subagent,
 * not archived.
 */
export function eligibleGroupSessions(
  sessions: readonly AgentSessionInfo[],
  workspaceId: string | null,
  memberSessionIds: ReadonlySet<string>,
): AgentSessionInfo[] {
  const expectedWorkspaceId = workspaceId ?? CHATS_WORKSPACE_ID;
  return sessions.filter(
    (session) =>
      session.workspaceId === expectedWorkspaceId &&
      !memberSessionIds.has(session.id) &&
      !session.parentSessionId &&
      !session.archivedAt,
  );
}

/**
 * Selector for the Groups row activity dot: true while any member is working.
 * Always false until the group runtime lands (PR 3); keep the signature so the
 * sidebar only needs a real implementation wired in, not new props.
 */
export function isGroupWorkingStub(_group: AgentGroupWithMembers): boolean {
  return false;
}
