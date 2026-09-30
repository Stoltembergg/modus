import { IconUsersPlus } from "@tabler/icons-react";
import { useState } from "react";
import { CreateGroupDialog } from "../../features/groups/CreateGroupDialog";
import { isGroupWorkingStub } from "../../features/groups/groupSidebarModel";
import { NewGroupModal } from "../../features/groups/NewGroupModal";
import { cn } from "../../lib/cn";
import { GroupRow } from "./group-row";
import type { SidebarGroupsProps } from "./props";
import { NO_NEW_GROUP_SERVICES, SB_ICON, SB_RAIL, SB_ROW, SB_STROKE } from "./shared";

export function SidebarGroups({
  groups,
  workspaces,
  models = [],
  defaultModelId,
  defaultWorkspaceId = null,
  memberStates: _memberStates,
  isGroupWorking = isGroupWorkingStub,
  isGroupWaiting,
  activeGroupId,
  onSelectGroup,
  canCreateGroup = true,
  onCreateGroup,
  newGroupServices = NO_NEW_GROUP_SERVICES,
  onRenameGroup,
  onUpdateMembers,
  onDeleteGroup,
  onAddAgent,
}: SidebarGroupsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const managingGroup = managingId ? groups.find((group) => group.id === managingId) : undefined;

  return (
    <div data-testid="sidebar-groups">
      {groups.map((group) => (
        <div data-group-id={group.id} key={group.id}>
          <GroupRow
            expanded={false}
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
            onToggle={() => onSelectGroup?.(group)}
            renaming={renamingId === group.id}
            selected={activeGroupId === group.id}
            waiting={isGroupWaiting?.(group) ?? false}
            working={isGroupWorking(group)}
            {...(onSelectGroup ? { onSelect: () => onSelectGroup(group) } : {})}
          />
        </div>
      ))}

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
