import { Menu } from "@base-ui/react/menu";
import { IconCheck, IconPencil, IconTrash, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { groupDeleteConfirmLabel } from "../../features/groups/groupSidebarModel";
import { GroupMenuItem } from "./helpers";
import { SB_ACTION, SB_ACTION_STROKE } from "./shared";

export function GroupMenuItems({
  agentCount,
  confirmDelete,
  onConfirmDelete,
  onStartRename,
  onManageMembers,
  onDelete,
  onAddAgent,
  coordinator,
}: {
  /** The group's agents (deleted with it): for the delete confirmation. */
  agentCount: number;
  confirmDelete: boolean;
  onConfirmDelete(next: boolean): void;
  onStartRename(): void;
  onManageMembers(): void;
  onDelete(): void;
  /** "Add agent" (A3): a new custom agent in the group, via the agent dialog. */
  onAddAgent?: (() => void) | undefined;
  /** The room's "Coordinator mode" toggle (PR 7); disabled while the group has no Lead. */
  coordinator?: { checked: boolean; disabled: boolean; onToggle(): void } | undefined;
}) {
  return (
    <>
      <GroupMenuItem
        icon={<IconPencil size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
        onClick={onStartRename}
      >
        Rename
      </GroupMenuItem>
      {onAddAgent ? (
        <GroupMenuItem
          icon={<IconUserPlus size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
          onClick={onAddAgent}
        >
          Add agent
        </GroupMenuItem>
      ) : null}
      <GroupMenuItem
        icon={<IconUsers size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
        onClick={onManageMembers}
      >
        Manage members
      </GroupMenuItem>
      {coordinator ? (
        <Menu.CheckboxItem
          checked={coordinator.checked}
          className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none select-none data-disabled:text-fg-faint data-highlighted:bg-hover"
          disabled={coordinator.disabled}
          onCheckedChange={() => coordinator.onToggle()}
          title={coordinator.disabled ? "Set a Lead first: the Lead coordinates" : undefined}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {coordinator.checked ? <IconCheck size={SB_ACTION} stroke={SB_ACTION_STROKE} /> : null}
          </span>
          Coordinator mode
          {coordinator.disabled ? (
            <span className="ml-auto text-2xs text-fg-faint">Needs a Lead</span>
          ) : null}
        </Menu.CheckboxItem>
      ) : null}
      <div className="my-1 h-px bg-hairline" />
      <GroupMenuItem
        closeOnClick={confirmDelete}
        danger
        icon={<IconTrash size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
        onClick={() => {
          if (!confirmDelete) {
            onConfirmDelete(true);
            return;
          }
          onConfirmDelete(false);
          onDelete();
        }}
      >
        {confirmDelete ? groupDeleteConfirmLabel(agentCount) : "Delete"}
      </GroupMenuItem>
    </>
  );
}
