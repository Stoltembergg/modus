import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import {
  IconCheck,
  IconCrown,
  IconCrownOff,
  IconDots,
  IconPencil,
  IconTrash,
  IconUserMinus,
  IconUsers,
  IconUsersGroup,
  IconUsersPlus,
} from "@tabler/icons-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import type {
  AgentGroupWithMembers,
  AgentSessionInfo,
  CreateAgentGroupInput,
  WorkspaceInfo,
} from "../../../shared/contracts";
import type { SessionActivity } from "../features/agent/agentEventHub";
import { SessionStatusDot } from "../features/agent/SessionStatusDot";
import { CreateGroupDialog, type GroupMembersChange } from "../features/groups/CreateGroupDialog";
import { groupMemberSessionIds, isGroupWorkingStub } from "../features/groups/groupSidebarModel";
import { MemberName } from "../features/groups/MemberName";
import { type MemberLabel, memberLabels } from "../features/groups/memberLabels";
import { cn } from "../lib/cn";
import { ICON, ICON_STROKE } from "../lib/uiDensity";

/* Same density contract as Sidebar.tsx (one icon rail, 30px rows). */
const SB_RAIL = "pointer-events-none flex w-5 shrink-0 items-center justify-center";
const SB_ROW =
  "flex h-[30px] w-full items-center gap-2 rounded-md pr-1 pl-2 text-xs font-normal transition-colors";
const SB_NEST = "pl-5";
const SB_ICON = ICON.lg;
const SB_STROKE = ICON_STROKE.lg;
const SB_ACTION = ICON.sm;
const SB_ACTION_STROKE = ICON_STROKE.sm;

export type SidebarGroupsProps = {
  groups: readonly AgentGroupWithMembers[];
  /** Root, non-archived sessions (the same list the rest of the sidebar uses). */
  sessions: readonly AgentSessionInfo[];
  /** Projects for the create dialog's Project picker. */
  workspaces: readonly WorkspaceInfo[];
  /** Project preselected in the create dialog (usually the active one). */
  defaultWorkspaceId?: string | null;
  activeSessionId?: string | undefined;
  activityBySession: Record<string, SessionActivity>;
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
  onRenameGroup(groupId: string, name: string): void;
  /** Apply "Manage members" (atomic; rejects so the dialog can show the error). */
  onUpdateMembers(groupId: string, change: GroupMembersChange): Promise<void>;
  onDeleteGroup(groupId: string): void;
  onRemoveMember(groupId: string, sessionId: string): void;
  onSetLead(groupId: string, sessionId: string | null): void;
};

/**
 * Sidebar "Groups" section body (the header lives in Sidebar.tsx). Each group
 * row shows its name, member count and an activity-dot slot; expanding a group
 * lists its member chats, which are hidden from Pinned / Projects / Chats.
 */
export function SidebarGroups({
  groups,
  sessions,
  workspaces,
  defaultWorkspaceId = null,
  activeSessionId,
  activityBySession,
  isGroupWorking = isGroupWorkingStub,
  isGroupWaiting,
  activeGroupId,
  onSelectGroup,
  canCreateGroup = true,
  onSelectSession,
  onCreateGroup,
  onRenameGroup,
  onUpdateMembers,
  onDeleteGroup,
  onRemoveMember,
  onSetLead,
}: SidebarGroupsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const memberIds = useMemo(() => groupMemberSessionIds(groups), [groups]);
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
        const memberSessions = group.members
          .map((member) => sessionsById.get(member.sessionId))
          .filter((session): session is AgentSessionInfo => Boolean(session));
        const labels = memberLabels(
          memberSessions.map((session) => ({ sessionId: session.id, title: session.title })),
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
              onManageMembers={() => setManagingId(group.id)}
              onStartRename={() => setRenamingId(group.id)}
              onToggle={() => toggle(group.id)}
              renaming={renamingId === group.id}
              selected={activeGroupId === group.id}
              waiting={isGroupWaiting?.(group) ?? false}
              working={isGroupWorking(group)}
              {...(onSelectGroup ? { onSelect: () => onSelectGroup(group) } : {})}
            />
            {expanded && memberSessions.length > 0 ? (
              <div className={SB_NEST}>
                {memberSessions.map((session) => {
                  const isLead = group.leadSessionId === session.id;
                  return (
                    <MemberRow
                      activity={activityBySession[session.id]}
                      isActive={activeSessionId === session.id}
                      isLead={isLead}
                      key={session.id}
                      onRemove={() => onRemoveMember(group.id, session.id)}
                      onSelect={() => onSelectSession(session)}
                      onToggleLead={() => onSetLead(group.id, isLead ? null : session.id)}
                      role={group.members.find((m) => m.sessionId === session.id)?.role}
                      label={labels.get(session.id) ?? { title: session.title }}
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

      <CreateGroupDialog
        defaultWorkspaceId={defaultWorkspaceId}
        memberSessionIds={memberIds}
        onCreate={onCreateGroup}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        sessions={sessions}
        workspaces={workspaces}
      />
      {managingGroup ? (
        <CreateGroupDialog
          group={managingGroup}
          memberSessionIds={memberIds}
          mode="edit"
          onOpenChange={(open) => {
            if (!open) setManagingId(null);
          }}
          onSave={(change) => onUpdateMembers(managingGroup.id, change)}
          open
          sessions={sessions}
          workspaces={workspaces}
        />
      ) : null}
    </div>
  );
}

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
}: {
  name: string;
  memberCount: number;
  working: boolean;
  waiting?: boolean;
  selected?: boolean;
  expanded: boolean;
  renaming: boolean;
  /** Opens the room; the rail icon then toggles the member list. */
  onSelect?: () => void;
  onToggle(): void;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
  onManageMembers(): void;
  onDelete(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const items = (
    <GroupMenuItems
      confirmDelete={confirmDelete}
      onConfirmDelete={setConfirmDelete}
      onDelete={onDelete}
      onManageMembers={onManageMembers}
      onStartRename={onStartRename}
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
            aria-expanded={expanded}
            aria-label={expanded ? "Hide members" : "Show members"}
            className={cn(SB_RAIL, "pointer-events-auto relative text-current")}
            onClick={onToggle}
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
            {...(onSelect
              ? selected
                ? { "aria-current": "page" as const }
                : {}
              : { "aria-expanded": expanded })}
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
export const GROUP_DELETE_CONFIRM_LABEL = "Member sessions return to the sidebar";

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
export function GroupMenuItems({
  confirmDelete,
  onConfirmDelete,
  onStartRename,
  onManageMembers,
  onDelete,
  coordinator,
}: {
  confirmDelete: boolean;
  onConfirmDelete(next: boolean): void;
  onStartRename(): void;
  onManageMembers(): void;
  onDelete(): void;
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
        {confirmDelete ? GROUP_DELETE_CONFIRM_LABEL : "Delete"}
      </GroupMenuItem>
    </>
  );
}

function MemberRow({
  label,
  role,
  isLead,
  isActive,
  activity,
  onSelect,
  onToggleLead,
  onRemove,
}: {
  label: MemberLabel;
  role: string | undefined;
  isLead: boolean;
  isActive: boolean;
  activity: SessionActivity | undefined;
  onSelect(): void;
  onToggleLead(): void;
  onRemove(): void;
}) {
  return (
    <div
      className={cn(
        SB_ROW,
        "group",
        isActive ? "row-selected" : "text-fg-subtle hover:bg-hover hover:text-fg-muted",
      )}
      data-testid="group-member-row"
    >
      <span className={SB_RAIL}>
        <SessionStatusDot activity={activity} />
      </span>
      <button
        className="flex min-w-0 flex-1 items-center gap-1 pr-1 text-left"
        onClick={onSelect}
        title="Open"
        type="button"
      >
        <span className="min-w-0 flex-1 truncate-fade">
          <MemberName label={label} />
        </span>
        {isLead ? (
          <span className="shrink-0 text-fg-faint" title="Lead">
            <IconCrown aria-hidden size={ICON.xs} stroke={ICON_STROKE.xs} />
            <span className="sr-only">Lead</span>
          </span>
        ) : null}
        {role ? <span className="shrink-0 text-2xs text-fg-faint">{role}</span> : null}
      </button>
      <span className="ml-0.5 hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        <RowIconButton label={isLead ? "Remove as lead" : "Make lead"} onClick={onToggleLead}>
          {isLead ? (
            <IconCrownOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          ) : (
            <IconCrown size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          )}
        </RowIconButton>
        <RowIconButton label="Remove from group" onClick={onRemove}>
          <IconUserMinus size={SB_ACTION} stroke={SB_ACTION_STROKE} />
        </RowIconButton>
      </span>
    </div>
  );
}

export function GroupRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const commit = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };
  return (
    <input
      aria-label="Group name"
      // biome-ignore lint/a11y/noAutofocus: renaming starts a focused edit by design
      autoFocus
      className="min-w-0 flex-1 rounded-md border border-composer-border bg-elevated px-1.5 py-1 text-fg text-xs outline-none focus:border-accent"
      maxLength={120}
      onBlur={commit}
      onChange={(event) => setValue(event.currentTarget.value)}
      onFocusCapture={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          doneRef.current = true;
          onCancel();
        }
      }}
      type="text"
      value={value}
    />
  );
}

function GroupMenuItem({
  icon,
  children,
  onClick,
  danger = false,
  closeOnClick = true,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick(): void;
  danger?: boolean;
  closeOnClick?: boolean;
}) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-hover",
        danger ? "text-danger" : "text-fg",
      )}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      {children}
    </Menu.Item>
  );
}

function RowIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-6 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-active hover:text-fg-muted"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
