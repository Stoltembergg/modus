import { Menu } from "@base-ui/react/menu";
import { IconDots, IconPlayerStop } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import type {
  AgentGroupMode,
  AgentGroupWithMembers,
  GroupProjectContextStatus,
} from "../../../../shared/contracts";
import type { GroupCollabStageSnapshot } from "../../../../shared/group-collab-status";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import { GroupMenuItems, GroupRenameInput } from "../../components/SidebarGroups";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { SessionStatusDot } from "../agent/SessionStatusDot";
import type { GroupDialogModel } from "./CreateGroupDialog";
import { GroupAgentsPopover } from "./GroupAgentsPopover";
import { GroupProjectContextChip } from "./GroupProjectContextChip";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { MemberName } from "./MemberName";
import type { MemberLabel } from "./memberLabels";
import type { GroupActivityState, GroupMemberStatesById } from "./useWorkingGroups";

/** Member state dot: working orb, amber for waiting for you, nothing when idle. */
export function GroupStateDot({ state }: { state: GroupActivityState }) {
  if (state === "working") {
    return (
      <SessionStatusDot
        activity={{ running: true, needsInput: false, unread: false, failed: false }}
        className="-my-1"
      />
    );
  }
  if (state === "waiting") {
    return (
      <span
        className="size-1.5 shrink-0 rounded-full bg-amber-400"
        data-testid="waiting-dot"
        title="Waiting for you"
      >
        <span className="sr-only">Waiting for you</span>
      </span>
    );
  }
  return null;
}

export function GroupStageChip({
  stage,
  labels,
}: {
  stage: GroupCollabStageSnapshot;
  labels: ReadonlyMap<string, MemberLabel>;
}) {
  const ownerLabel = stage.ownerSessionId
    ? (labels.get(stage.ownerSessionId) ??
      (stage.ownerName ? { title: stage.ownerName } : undefined))
    : stage.ownerName
      ? { title: stage.ownerName }
      : undefined;
  return (
    <span
      className="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
      data-stage={stage.stage}
      data-testid="group-stage-chip"
      title="Collaboration stage (from the room transcript)"
    >
      {ownerLabel ? (
        <>
          Owner: <MemberName label={ownerLabel} /> · {stage.stage}
        </>
      ) : (
        <>Stage · {stage.stage}</>
      )}
    </span>
  );
}

export function GroupRoomHeader({
  avatars,
  group,
  members,
  memberStates,
  projectName,
  projectContextStatus,
  running,
  tasksButton,
  models,
  defaultModelId,
  onOpenAgentChat,
  onStop,
  onRename,
  onSetMode,
  onManageMembers,
  onDelete,
  onAddAgent,
  onSetLead,
  onAgentsChanged,
  variant = "standalone",
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  group: AgentGroupWithMembers;
  members: readonly MentionMember[];
  memberStates: GroupMemberStatesById;
  projectName: string | undefined;
  /** Compact Project Setup chip (Mapping… / Ready / Updating / Needs refresh). */
  projectContextStatus?: GroupProjectContextStatus | undefined;
  running: boolean;
  tasksButton: ReactNode;
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  onOpenAgentChat(agentId: string): void;
  onStop(): void;
  onRename(name: string): void;
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
  onManageMembers(): void;
  onDelete(): void;
  onAddAgent?: (() => void) | undefined;
  onSetLead?(sessionId: string | null): void;
  onAgentsChanged?(): void;
  /** `chrome` = window toolbar strip; `standalone` = legacy internal bar (tests). */
  variant?: "chrome" | "standalone";
}) {
  const [renaming, setRenaming] = useState(false);
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
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-2"
        data-testid="group-room-header-row"
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
          {projectName ?? "No project"}
        </span>
        <GroupProjectContextChip status={projectContextStatus} />
        <span className="min-w-2 flex-1" />
        <GroupAgentsPopover
          avatars={avatars}
          group={group}
          memberStates={memberStates}
          members={members}
          onManageMembers={onManageMembers}
          onOpenAgentChat={onOpenAgentChat}
          {...(defaultModelId !== undefined ? { defaultModelId } : {})}
          {...(models !== undefined ? { models } : {})}
          {...(onAgentsChanged ? { onAgentsChanged } : {})}
          {...(onSetLead ? { onSetLead } : {})}
        />
        {running ? (
          <button
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-hairline px-2 text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg"
            onClick={onStop}
            title="End the chain and stop running member turns"
            type="button"
          >
            <IconPlayerStop size={ICON.xs} stroke={ICON_STROKE.xs} />
            Stop
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
            aria-label="Group actions"
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
  );
}
