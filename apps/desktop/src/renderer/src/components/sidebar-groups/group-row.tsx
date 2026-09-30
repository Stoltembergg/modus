import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { IconDots, IconUsersGroup } from "@tabler/icons-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { GroupMenuItems } from "./menu";
import { GroupRenameInput } from "./rename";
import { SB_ACTION, SB_ACTION_STROKE, SB_ICON, SB_RAIL, SB_ROW, SB_STROKE } from "./shared";

export function GroupRow({
  name,
  memberCount,
  working,
  waiting = false,
  selected = false,
  expanded,
  renaming,
  onSelect,
  onToggle,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onManageMembers,
  onDelete,
  onAddAgent,
}: {
  name: string;
  memberCount: number;
  working: boolean;
  waiting?: boolean;
  selected?: boolean;
  expanded: boolean;
  renaming: boolean;
  /** Opens the room. */
  onSelect?: () => void;
  /** Rail click: opens the room (member list lives in the room Agents panel). */
  onToggle(): void;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
  onManageMembers(): void;
  onDelete(): void;
  onAddAgent?: (() => void) | undefined;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const items = (
    <GroupMenuItems
      agentCount={memberCount}
      confirmDelete={confirmDelete}
      onConfirmDelete={setConfirmDelete}
      onDelete={onDelete}
      onManageMembers={onManageMembers}
      onStartRename={onStartRename}
      {...(onAddAgent ? { onAddAgent } : {})}
    />
  );
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        setContextOpen(open);
        if (!open) setConfirmDelete(false);
      }}
      open={contextOpen}
    >
      <ContextMenu.Trigger
        className={cn(
          SB_ROW,
          "group",
          selected ? "row-selected" : "text-fg-muted hover:bg-hover hover:text-fg",
          contextOpen && !selected && "bg-hover text-fg",
        )}
        data-selected={selected || undefined}
        data-testid="group-row"
      >
        {onSelect ? (
          <button
            aria-label="Open group"
            className={cn(SB_RAIL, "pointer-events-auto relative text-current")}
            onClick={onSelect}
            type="button"
          >
            <IconUsersGroup size={SB_ICON} stroke={SB_STROKE} />
            <GroupRowDot waiting={waiting} working={working} />
          </button>
        ) : (
          <span className={cn(SB_RAIL, "relative text-current")}>
            <IconUsersGroup size={SB_ICON} stroke={SB_STROKE} />
            <GroupRowDot waiting={waiting} working={working} />
          </span>
        )}
        {renaming ? (
          <GroupRenameInput initial={name} onCancel={onCancelRename} onCommit={onCommitRename} />
        ) : (
          <button
            {...(onSelect && selected ? { "aria-current": "page" as const } : {})}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={onSelect ?? onToggle}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span
              className="shrink-0 px-1 text-2xs text-fg-faint tabular-nums"
              data-testid="group-member-count"
              title={`${memberCount} member${memberCount === 1 ? "" : "s"}`}
            >
              {memberCount}
              <span className="sr-only"> member{memberCount === 1 ? "" : "s"}</span>
            </span>
          </button>
        )}
        <Menu.Root
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setConfirmDelete(false);
          }}
          open={menuOpen}
        >
          <span
            className={cn(
              "shrink-0 items-center",
              menuOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex",
            )}
          >
            <Menu.Trigger
              aria-label="Group actions"
              className="flex size-6 items-center justify-center rounded-md text-fg-faint outline-none transition-colors hover:bg-active hover:text-fg-muted data-popup-open:bg-active data-popup-open:text-fg-muted"
            >
              <IconDots size={SB_ACTION} stroke={SB_ACTION_STROKE} />
            </Menu.Trigger>
          </span>
          <Menu.Portal>
            <Menu.Positioner align="start" side="bottom" sideOffset={4}>
              <Menu.Popup className="origin-(--transform-origin) min-w-[184px] popup-chrome popup-motion p-1">
                {items}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup
            className="origin-(--transform-origin) min-w-[184px] popup-chrome popup-motion p-1"
            data-testid="group-context-menu"
          >
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Exact confirm label of the two-step Delete item. */

/** Group row dot: amber "waiting for you" wins over the working dot. */
function GroupRowDot({ working, waiting }: { working: boolean; waiting: boolean }) {
  if (waiting) {
    return (
      <span
        className="absolute top-0 right-0 size-1.5 rounded-full bg-amber-400"
        data-testid="group-waiting-dot"
        title="A member is waiting for you"
      >
        <span className="sr-only">A member is waiting for you</span>
      </span>
    );
  }
  if (!working) return null;
  return (
    <span
      className="absolute top-0 right-0 size-1.5 rounded-full bg-accent"
      data-testid="group-activity-dot"
      title="A member is working"
    >
      <span className="sr-only">A member is working</span>
    </span>
  );
}

/**
 * Rename / Manage members / Delete, shared by the "…" menu, the row's context
 * menu and the room header menu.
 */
