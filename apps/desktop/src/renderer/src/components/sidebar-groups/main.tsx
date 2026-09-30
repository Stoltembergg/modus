import { IconUsersPlus } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { CreateGroupDialog } from "../../features/groups/CreateGroupDialog";
import { groupMemberOpenTarget } from "../../features/groups/groupMemberOpenTarget";
import {
  agentChatSessions,
  groupAgentRows,
  isGroupWorkingStub,
} from "../../features/groups/groupSidebarModel";
import { memberLabels } from "../../features/groups/memberLabels";
import { NewGroupModal } from "../../features/groups/NewGroupModal";
import { memberActivityState } from "../../features/groups/useWorkingGroups";
import { cn } from "../../lib/cn";
import { GroupRow } from "./group-row";
import { MemberRow } from "./member-row";
import type { SidebarGroupsProps } from "./props";
import { NO_NEW_GROUP_SERVICES, SB_ICON, SB_NEST, SB_RAIL, SB_ROW, SB_STROKE } from "./shared";

export function SidebarGroups({
  groups,
  sessions,
  workspaces,
  models = [],
  defaultModelId,
  defaultWorkspaceId = null,
  activeSessionId,
  activityBySession,
  memberStates,
  isGroupWorking = isGroupWorkingStub,
  isGroupWaiting,
  activeGroupId,
  onSelectGroup,
  canCreateGroup = true,
  onSelectSession,
  onCreateGroup,
  newGroupServices = NO_NEW_GROUP_SERVICES,
  onRenameGroup,
  onUpdateMembers,
  onDeleteGroup,
  onRemoveMember,
  onSetLead,
  onOpenAgentChat,
  onEditAgent,
  onAddAgent,
}: SidebarGroupsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const chats = useMemo(() => agentChatSessions(sessions), [sessions]);
  const managingGroup = managingId ? groups.find((group) => group.id === managingId) : undefined;

  function toggle(groupId: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <div data-testid="sidebar-groups">
      {groups.map((group) => {
        const expanded = !collapsed.has(group.id);
        // Members come from the group itself (agent name and archived state):
        // their hidden room sessions are not in the sidebar's session list.
        const labels = memberLabels(
          group.members.map((member) => ({ sessionId: member.sessionId, title: member.name })),
        );
        return (
          <div data-group-id={group.id} key={group.id}>
            <GroupRow
              expanded={expanded}
              memberCount={group.members.length}
              name={group.name}
              onCancelRename={() => setRenamingId(null)}
              onCommitRename={(name) => {
                setRenamingId(null);
                const next = name.trim();
                if (next && next !== group.name) onRenameGroup(group.id, next);
              }}
              onDelete={() => onDeleteGroup(group.id)}
              {...(onAddAgent ? { onAddAgent: () => onAddAgent(group.id) } : {})}
              onManageMembers={() => setManagingId(group.id)}
              onStartRename={() => setRenamingId(group.id)}
              onToggle={() => toggle(group.id)}
              renaming={renamingId === group.id}
              selected={activeGroupId === group.id}
              waiting={isGroupWaiting?.(group) ?? false}
              working={isGroupWorking(group)}
              {...(onSelectGroup ? { onSelect: () => onSelectGroup(group) } : {})}
            />
            {expanded && group.members.length > 0 ? (
              <div className={SB_NEST}>
                {groupAgentRows(group, chats, memberStates, activityBySession).map((row) => {
                  const session = sessionsById.get(row.sessionId);
                  return (
                    <MemberRow
                      isActive={
                        activeSessionId !== undefined &&
                        (activeSessionId === row.chatSessionId || activeSessionId === row.sessionId)
                      }
                      key={row.sessionId}
                      label={labels.get(row.sessionId) ?? { title: row.name }}
                      onRemove={() => onRemoveMember(group.id, row.sessionId)}
                      onSelect={() => {
                        const room = memberStates
                          ? memberActivityState(memberStates, group.id, row.sessionId)
                          : "idle";
                        if (groupMemberOpenTarget(room) === "group") {
                          onSelectGroup?.(group);
                          return;
                        }
                        if (onOpenAgentChat) onOpenAgentChat(row.agentId);
                        else if (session) onSelectSession(session);
                        else onSelectGroup?.(group);
                      }}
                      onToggleLead={() => onSetLead(group.id, row.isLead ? null : row.sessionId)}
                      row={row}
                      {...(onEditAgent ? { onEdit: () => onEditAgent(row.agentId) } : {})}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      <button
        className={cn(
          SB_ROW,
          "text-left text-fg-faint hover:bg-hover hover:text-fg-muted",
          !canCreateGroup && "cursor-not-allowed opacity-40 hover:bg-transparent",
        )}
        disabled={!canCreateGroup}
        onClick={() => setDialogOpen(true)}
        type="button"
      >
        <span className={SB_RAIL}>
          <IconUsersPlus size={SB_ICON} stroke={SB_STROKE} />
        </span>
        <span className="min-w-0 flex-1 truncate">New group</span>
      </button>

      {dialogOpen ? (
        <NewGroupModal
          defaultModelId={defaultModelId}
          defaultWorkspaceId={defaultWorkspaceId}
          groups={groups}
          models={models}
          onCreate={onCreateGroup}
          onOpenChange={setDialogOpen}
          open
          services={newGroupServices}
          workspaces={workspaces}
        />
      ) : null}
      {managingGroup ? (
        <CreateGroupDialog
          defaultModelId={defaultModelId}
          group={managingGroup}
          mode="edit"
          models={models}
          onOpenChange={(open) => {
            if (!open) setManagingId(null);
          }}
          onSave={(change) => onUpdateMembers(managingGroup.id, change)}
          open
          workspaces={workspaces}
        />
      ) : null}
    </div>
  );
}
