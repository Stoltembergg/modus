import { Menu } from "@base-ui/react/menu";
import { IconDots, IconPlayerStop, IconSearch, IconX } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import type { AgentGroupMode, AgentGroupWithMembers } from "../../../../shared/contracts";
import type { GroupCollabStageSnapshot } from "../../../../shared/group-collab-status";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import { GroupMenuItems, GroupRenameInput } from "../../components/SidebarGroups";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
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

export function GroupRoomHeader({
  avatars,
  group,
  memberStates,
  projectName,
  searchQuery,
  onSearchChange,
  running,
  tasksButton,
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
  tasksButton: ReactNode;
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
    >
      <div
        className={
          chrome
            ? "group-room-header-row-chrome"
            : "flex min-w-0 flex-1 flex-nowrap items-center gap-2"
        }
        data-testid="group-room-header-row"
      >
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
            <h1 className="min-w-0 truncate font-medium text-fg text-sm">{group.name}</h1>
          )}
          <span
            className="min-w-0 shrink truncate rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
            data-testid="group-project-badge"
          >
            {projectName ?? t("header.noProject")}
          </span>
        </div>
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
            className="min-w-0 flex-1 bg-transparent text-fg text-xs outline-none placeholder:text-fg-faint"
            onChange={(event) => onSearchChange(event.currentTarget.value)}
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
            {...(defaultModelId !== undefined ? { defaultModelId } : {})}
            {...(models !== undefined ? { models } : {})}
            {...(onAgentsChanged ? { onAgentsChanged } : {})}
          />
          {running ? (
            <button
              className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-hairline px-2 text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg"
              onClick={onStop}
              title={t("header.stopTitle")}
              type="button"
            >
              <IconPlayerStop size={ICON.xs} stroke={ICON_STROKE.xs} />
              {t("header.stop")}
            </button>
          ) : null}
          {tasksButton}
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
