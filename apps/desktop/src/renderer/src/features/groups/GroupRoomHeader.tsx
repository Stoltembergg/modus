import { Menu } from "@base-ui/react/menu";
import {
  IconCheck,
  IconDots,
  IconLayoutSidebarRight,
  IconPlayerStop,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { AgentGroupMode, AgentGroupWithMembers } from "../../../../shared/contracts";
import type { GroupCollabStageSnapshot } from "../../../../shared/group-collab-status";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import { GroupMenuItems, GroupRenameInput } from "../../components/SidebarGroups";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import {
  TOP_BAR_BREAKPOINTS,
  useWidthTier,
  type WidthTier,
  type WidthTierBreakpoints,
} from "../../lib/useWidthTier";
import { AgentPresenceDot } from "../agents/AgentPresenceDot";
import type { GroupDialogModel } from "./CreateGroupDialog";
import { GroupAgentsPopover } from "./GroupAgentsPopover";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import { useGroupText } from "./groupRoomI18n";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";
import type { GroupActivityState, GroupMemberStatesById } from "./useWorkingGroups";

/** Member state dot: working orb, amber for waiting for you, nothing when idle. */
export function GroupStateDot({ state }: { state: GroupActivityState }) {
  if (state === "idle") return null;
  return <AgentPresenceDot className="-my-1" state={state} />;
}

export function GroupStageChip({
  stage,
  labels,
}: {
  stage: GroupCollabStageSnapshot;
  labels: ReadonlyMap<string, MemberLabel>;
}) {
  const t = useGroupText();
  const ownerLabel = stage.ownerSessionId
    ? (labels.get(stage.ownerSessionId) ??
      (stage.ownerName ? { title: stage.ownerName } : undefined))
    : stage.ownerName
      ? { title: stage.ownerName }
      : undefined;
  const stageName = t(`stage.${stage.stage}`);
  return (
    <span
      className="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
      data-stage={stage.stage}
      data-testid="group-stage-chip"
      title={t("header.stageTitle")}
    >
      {ownerLabel ? (
        <>
          {t("header.owner")} <MemberName label={ownerLabel} /> · {stageName}
        </>
      ) : (
        t("header.stage", { stage: stageName })
      )}
    </span>
  );
}

/**
 * L3c: the header's own width picks the layout.
 * - `lg` (≥ 760px): full bar, as before.
 * - `md` (520–759px): project badge folds into the title tooltip; Stop and Activity
 *   are icon-only (Activity keeps its count); at most 3 agent avatars, then "+N".
 * - `sm` (< 520px): search becomes an icon button that expands over the title;
 *   Activity moves into the "Group actions" overflow menu; at most 2 avatars.
 */
export const GROUP_HEADER_BREAKPOINTS: WidthTierBreakpoints = TOP_BAR_BREAKPOINTS;
const MAX_AVATARS: Record<WidthTier, number | undefined> = { sm: 2, md: 3, lg: undefined };

/** The Activity panel toggle (rendered by the header so it can collapse by width). */
export type GroupHeaderActivity = {
  open: boolean;
  count: number;
  /** Accessible name, e.g. "Activity, 2 open tasks". */
  label: string;
  title: string;
  onToggle(): void;
};

export function GroupRoomHeader({
  avatars,
  group,
  memberStates,
  projectName,
  searchQuery,
  onSearchChange,
  running,
  activity,
  models,
  defaultModelId,
  onStop,
  onRename,
  onSetMode,
  onManageMembers,
  onDelete,
  onAddAgent,
  onAgentsChanged,
  variant = "standalone",
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  group: AgentGroupWithMembers;
  memberStates: GroupMemberStatesById;
  projectName: string | undefined;
  searchQuery: string;
  onSearchChange(query: string): void;
  running: boolean;
  activity: GroupHeaderActivity;
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onStop(): void;
  onRename(name: string): void;
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
  onManageMembers(): void;
  onDelete(): void;
  onAddAgent?: (() => void) | undefined;
  onAgentsChanged?(): void;
  /** `chrome` = window toolbar strip; `standalone` = legacy internal bar (tests). */
  variant?: "chrome" | "standalone";
}) {
  const [renaming, setRenaming] = useState(false);
  const t = useGroupText();
  const coordinating = isCoordinatorModeActive(group);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const chrome = variant === "chrome";
  const [headerRef, tier] = useWidthTier<HTMLDivElement>(GROUP_HEADER_BREAKPOINTS);
  const [searchExpanded, setSearchExpanded] = useState(false);
  // sm: Escape closes the search and puts focus back on its toggle.
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const refocusToggle = useRef(false);
  useEffect(() => {
    if (!refocusToggle.current) return;
    refocusToggle.current = false;
    searchToggleRef.current?.focus();
  });
  const compact = tier !== "lg";
  // sm: the search field is an icon until opened (or while it holds a query).
  const searchCollapsed = tier === "sm" && !searchExpanded && !searchQuery;
  const searchOverTitle = tier === "sm" && !searchCollapsed && !renaming;
  const project = projectName ?? t("header.noProject");
  const activityButton = (
    <button
      aria-expanded={activity.open}
      aria-label={activity.label}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-fg-faint text-xs transition-colors hover:bg-hover hover:text-fg-muted",
        activity.open && "bg-hover text-fg-muted",
      )}
      data-testid="group-activity-button"
      onClick={activity.onToggle}
      title={activity.title}
      type="button"
    >
      <IconLayoutSidebarRight size={ICON.sm} stroke={ICON_STROKE.sm} />
      {compact ? null : t("activity.title")}
      <span className="tabular-nums" data-testid="group-task-count">
        {activity.count}
      </span>
    </button>
  );
  return (
    <div
      className={
        chrome
          ? "flex min-h-0 min-w-0 flex-1 items-center"
          : "shrink-0 border-hairline border-b px-6 py-2"
      }
      data-single-row="true"
      data-testid="group-room-header"
      data-variant={variant}
      data-width-tier={tier}
      ref={headerRef}
    >
      <div
        className={
          chrome
            ? "group-room-header-row-chrome"
            : "flex min-w-0 flex-1 flex-nowrap items-center gap-2"
        }
        data-search-over-title={searchOverTitle ? "" : undefined}
        data-testid="group-room-header-row"
        data-width-tier={tier}
      >
        {searchOverTitle ? null : (
          <div
            className={
              chrome ? "group-room-header-identity-chrome" : "flex min-w-0 items-center gap-2"
            }
          >
            {renaming ? (
              <GroupRenameInput
                initial={group.name}
                onCancel={() => setRenaming(false)}
                onCommit={(name) => {
                  setRenaming(false);
                  const next = name.trim();
                  if (next && next !== group.name) onRename(next);
                }}
              />
            ) : (
              <h1
                className="min-w-0 truncate font-medium text-fg text-sm"
                data-testid="group-room-title"
                title={compact ? `${group.name} · ${project}` : group.name}
              >
                {group.name}
              </h1>
            )}
            {compact ? null : (
              <span
                className="min-w-0 shrink truncate rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
                data-testid="group-project-badge"
                title={project}
              >
                {project}
              </span>
            )}
          </div>
        )}
        {searchCollapsed ? (
          <button
            aria-expanded={false}
            aria-label={t("header.search")}
            className={cn(
              "app-no-drag flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted",
              chrome && "group-room-header-search-toggle",
            )}
            data-testid="group-conversation-search-toggle"
            onClick={() => setSearchExpanded(true)}
            ref={searchToggleRef}
            title={t("header.search")}
            type="button"
          >
            <IconSearch size={ICON.sm} stroke={ICON_STROKE.sm} />
          </button>
        ) : (
          <label
            className={
              chrome
                ? "group-room-header-search-centered app-no-drag flex min-w-0 items-center gap-1.5 rounded-md bg-chip px-2 py-1 text-fg-muted transition-[background-color,box-shadow] duration-[var(--motion-ui)] focus-within:ring-1 focus-within:ring-focus-ring/50"
                : "app-no-drag flex min-w-0 w-[min(220px,28vw)] shrink-0 items-center gap-1.5 rounded-md bg-chip px-2 py-1 text-fg-muted transition-[background-color,box-shadow] duration-[var(--motion-ui)] focus-within:ring-1 focus-within:ring-focus-ring/50"
            }
            data-testid="group-conversation-search"
          >
            <IconSearch className="shrink-0 text-fg-faint" size={ICON.sm} stroke={ICON_STROKE.sm} />
            <input
              aria-label={t("header.search")}
              // biome-ignore lint/a11y/noAutofocus: only after the user opened the collapsed search.
              autoFocus={searchOverTitle && !searchQuery}
              className="min-w-0 flex-1 bg-transparent text-fg text-xs outline-none placeholder:text-fg-faint"
              onBlur={(event) => {
                if (!event.currentTarget.value) setSearchExpanded(false);
              }}
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                // sm: Escape clears and closes (title back); blur closes only when empty.
                if (event.key !== "Escape" || tier !== "sm") return;
                event.preventDefault();
                refocusToggle.current = true;
                onSearchChange("");
                setSearchExpanded(false);
              }}
              placeholder={t("header.search")}
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button
                aria-label={t("header.clearSearch")}
                className="shrink-0 text-fg-faint hover:text-fg"
                onClick={() => onSearchChange("")}
                type="button"
              >
                <IconX size={ICON.xs} stroke={ICON_STROKE.sm} />
              </button>
            ) : null}
          </label>
        )}
        {!chrome ? <span className="min-w-2 flex-1" /> : null}
        <div
          className={
            chrome ? "group-room-header-controls-chrome" : "flex shrink-0 items-center gap-2"
          }
        >
          <GroupAgentsPopover
            avatars={avatars}
            group={group}
            memberStates={memberStates}
            {...(MAX_AVATARS[tier] !== undefined ? { maxVisible: MAX_AVATARS[tier] } : {})}
            onSelectHidden={() => onManageMembers()}
            {...(defaultModelId !== undefined ? { defaultModelId } : {})}
            {...(models !== undefined ? { models } : {})}
            {...(onAgentsChanged ? { onAgentsChanged } : {})}
          />
          {running ? (
            <button
              aria-label={compact ? t("header.stop") : undefined}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1 rounded-md border border-hairline text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg",
                compact ? "w-6 justify-center" : "px-2",
              )}
              onClick={onStop}
              title={t("header.stopTitle")}
              type="button"
            >
              <IconPlayerStop size={ICON.xs} stroke={ICON_STROKE.xs} />
              {compact ? null : t("header.stop")}
            </button>
          ) : null}
          {tier === "sm" ? null : activityButton}
          <Menu.Root
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (!open) setConfirmDelete(false);
            }}
            open={menuOpen}
          >
            <Menu.Trigger
              aria-label={t("header.groupActions")}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint outline-none transition-colors hover:bg-hover hover:text-fg-muted data-popup-open:bg-hover"
            >
              <IconDots size={ICON.sm} stroke={ICON_STROKE.sm} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner align="end" side="bottom" sideOffset={4}>
                <Menu.Popup className="origin-(--transform-origin) min-w-[184px] popup-chrome popup-motion p-1">
                  {tier === "sm" ? (
                    <>
                      <Menu.CheckboxItem
                        checked={activity.open}
                        className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none select-none data-highlighted:bg-hover"
                        data-testid="group-activity-menu-item"
                        onCheckedChange={() => activity.onToggle()}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {activity.open ? (
                            <IconCheck size={ICON.sm} stroke={ICON_STROKE.sm} />
                          ) : (
                            <IconLayoutSidebarRight size={ICON.sm} stroke={ICON_STROKE.sm} />
                          )}
                        </span>
                        {t("activity.title")}
                        <span className="ml-auto text-2xs text-fg-faint tabular-nums">
                          {activity.count}
                        </span>
                      </Menu.CheckboxItem>
                      <div className="my-1 h-px bg-hairline" />
                    </>
                  ) : null}
                  <GroupMenuItems
                    agentCount={group.members.length}
                    confirmDelete={confirmDelete}
                    coordinator={
                      onSetMode
                        ? {
                            checked: coordinating,
                            disabled: !group.leadSessionId,
                            onToggle: () => onSetMode(coordinating ? "free" : "coordinator"),
                          }
                        : undefined
                    }
                    onConfirmDelete={setConfirmDelete}
                    onDelete={onDelete}
                    onManageMembers={onManageMembers}
                    onStartRename={() => setRenaming(true)}
                    {...(onAddAgent ? { onAddAgent } : {})}
                  />
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </div>
    </div>
  );
}
