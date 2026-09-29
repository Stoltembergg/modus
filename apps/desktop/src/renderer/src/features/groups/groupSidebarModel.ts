import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentGroupWithMembers,
  AgentSessionInfo,
} from "../../../../shared/contracts";
import type { SessionActivity } from "../agent/agentEventHub";
import { type AgentAvatarState, agentAvatarState, memberAvatar } from "../agents/agentAvatarModel";
import { type GroupMemberStatesById, memberActivityState } from "./useWorkingGroups";

/**
 * Hidden group room sessions (kind "group_member") never show in Pinned /
 * Projects / Chats. The main process leaves them out of listings; this also
 * drops one passed in with `includeSessionId` (opened from a room). An agent's
 * 1:1 chat (A3, `agentId` set) is listed under its agent in the group instead.
 */
export function isListedChat(session: AgentSessionInfo): boolean {
  return session.kind !== "group_member" && !session.agentId;
}

/** One agent row inside its group in the sidebar (A3). */
export type GroupAgentRow = {
  agentId: string;
  /** The hidden room session (lead / remove actions address it). */
  sessionId: string;
  name: string;
  role: string | undefined;
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  state: AgentAvatarState;
  isLead: boolean;
  /** The agent's 1:1 chat when it exists (created on first open). */
  chatSessionId: string | undefined;
};

/** agentId → its 1:1 chat session, from the sidebar's session list. */
export function agentChatSessions(
  sessions: readonly AgentSessionInfo[],
): ReadonlyMap<string, AgentSessionInfo> {
  const chats = new Map<string, AgentSessionInfo>();
  for (const session of sessions) {
    if (session.agentId && session.kind !== "group_member") chats.set(session.agentId, session);
  }
  return chats;
}

/**
 * The agents listed inside a group: avatar, name, role, state, lead and the
 * 1:1 chat. The avatar state is the room's (waiting > working), else the 1:1
 * chat's (asking for input = waiting, running = working); archived wins. A
 * blocked group (groupBlockedReason) lists its agents the same way.
 */
export function groupAgentRows(
  group: AgentGroupWithMembers,
  chats: ReadonlyMap<string, AgentSessionInfo>,
  states: GroupMemberStatesById | undefined,
  chatActivity: Readonly<Record<string, SessionActivity>> = {},
): GroupAgentRow[] {
  return group.members.map((member) => {
    const avatar = memberAvatar(member);
    const chat = chats.get(member.agentId);
    const room = states ? memberActivityState(states, group.id, member.sessionId) : "idle";
    const direct = chat ? chatActivity[chat.id] : undefined;
    const activity =
      room !== "idle"
        ? room
        : direct?.needsInput
          ? "waiting"
          : direct?.running
            ? "working"
            : "idle";
    return {
      agentId: member.agentId,
      sessionId: member.sessionId,
      name: member.name,
      role: member.role ?? (member.agentRole || undefined),
      face: avatar.face,
      color: avatar.color,
      state: agentAvatarState(activity, member.archived === true),
      isLead: group.leadSessionId === member.sessionId,
      chatSessionId: chat?.id,
    };
  });
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
