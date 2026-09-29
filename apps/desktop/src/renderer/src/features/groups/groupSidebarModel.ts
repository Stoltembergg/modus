import type { AgentGroupWithMembers, AgentSessionInfo } from "../../../../shared/contracts";

/**
 * Hidden group room sessions (kind "group_member") never show in Pinned /
 * Projects / Chats. The main process leaves them out of listings; this also
 * drops one passed in with `includeSessionId` (opened from a room).
 */
export function isListedChat(session: AgentSessionInfo): boolean {
  return session.kind !== "group_member";
}

/** The names of the groups a Project owns (they are deleted with it by "Remove project"). */
export function projectGroupNames(
  groups: readonly AgentGroupWithMembers[],
  workspaceId: string,
): string[] {
  return groups.filter((group) => group.workspaceId === workspaceId).map((group) => group.name);
}

/** Remove-project confirmation when the Project owns groups (at least one name). */
export function removeProjectGroupsWarning(names: readonly string[]): string {
  const count = names.length;
  const groups = count === 1 ? "1 group" : `${count} groups`;
  return `This also deletes ${groups} with their agents, chats and messages: ${names.join(", ")}`;
}

/** Delete-group confirmation: an agent belongs to one group, so it goes with it. */
export function groupDeleteConfirmLabel(agentCount: number): string {
  const agents = agentCount === 1 ? "1 agent" : `${agentCount} agents`;
  return `This deletes its ${agents}, their chats and all group messages`;
}

/**
 * Default for the Groups row activity dot when no runtime state is passed
 * (tests, stories). The app passes the real selector from useWorkingGroups.
 */
export function isGroupWorkingStub(_group: AgentGroupWithMembers): boolean {
  return false;
}
