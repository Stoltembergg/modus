import type {
  AgentGroupWithMembers,
  AgentSessionInfo,
  CreateAgentGroupInput,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import type { SessionActivity } from "../../features/agent/agentEventHub";
import type { GroupDialogModel, GroupMembersChange } from "../../features/groups/CreateGroupDialog";
import type { NewGroupServices } from "../../features/groups/NewGroupModal";
import type { GroupMemberStatesById } from "../../features/groups/useWorkingGroups";

export type SidebarGroupsProps = {
  groups: readonly AgentGroupWithMembers[];
  /** Root, non-archived sessions (the same list the rest of the sidebar uses). */
  sessions: readonly AgentSessionInfo[];
  /** Projects for the create dialog's Project picker. */
  workspaces: readonly WorkspaceInfo[];
  /** Models for the dialog's new agents (configured providers). */
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  /** Project preselected in the create dialog (usually the active one). */
  defaultWorkspaceId?: string | null;
  activeSessionId?: string | undefined;
  /** Session activity (the agents' 1:1 chats light their avatars). */
  activityBySession: Record<string, SessionActivity>;
  /** Room member states: each agent's avatar shows working / waiting (A3). */
  memberStates?: GroupMemberStatesById | undefined;
  /**
   * Group-row activity dot. Always false until the group runtime (PR 3)
   * exists; replace the stub with a real selector to light the dot.
   */
  isGroupWorking?: (group: AgentGroupWithMembers) => boolean;
  /** Amber "waiting for you" dot; wins over the working dot. */
  isGroupWaiting?: (group: AgentGroupWithMembers) => boolean;
  /** The group whose room is open (its row is selected like a chat row). */
  activeGroupId?: string | undefined;
  /** Open the group's room. Without it the name toggles the member list (legacy). */
  onSelectGroup?(group: AgentGroupWithMembers): void;
  canCreateGroup?: boolean;
  onSelectSession(session: AgentSessionInfo): void;
  onCreateGroup(input: CreateAgentGroupInput): Promise<void>;
  /** The create modal's app services (agents list, Add folder…, profile generation). */
  newGroupServices?: NewGroupServices | undefined;
  onRenameGroup(groupId: string, name: string): void;
  /** Apply "Manage members" (atomic; rejects so the dialog can show the error). */
  onUpdateMembers(groupId: string, change: GroupMembersChange): Promise<void>;
  onDeleteGroup(groupId: string): void;
  onRemoveMember(groupId: string, sessionId: string): void;
  onSetLead(groupId: string, sessionId: string | null): void;
  /**
   * Open an agent's 1:1 chat (A3; created on first open). Without it a member
   * row opens its room session, or the room (legacy).
   */
  onOpenAgentChat?: ((agentId: string) => void) | undefined;
  /** "Edit agent" on a member row (the agent dialog). */
  onEditAgent?: ((agentId: string) => void) | undefined;
  /** "Add agent" in the group menu (the agent dialog, create mode). */
  onAddAgent?: ((groupId: string) => void) | undefined;
};

/**
 * Sidebar "Groups" section body (the header lives in Sidebar.tsx). Each group
 * row shows its name, member count and an activity-dot slot; expanding a group
 * lists its agents (avatar, name, role). Clicking one opens its 1:1 chat, which
 * (like the room sessions) is hidden from Pinned / Projects / Chats. A blocked
 * group lists its agents the same way.
 */
