import { Menu } from "@base-ui/react/menu";
import { IconCrown, IconDots, IconPlayerStop } from "@tabler/icons-react";
import { type ReactNode, useMemo, useState } from "react";
import type { AgentGroupMode, AgentGroupWithMembers } from "../../../../shared/contracts";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import { GroupMenuItems, GroupRenameInput } from "../../components/SidebarGroups";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { SessionStatusDot } from "../agent/SessionStatusDot";
import { AgentAvatar } from "../agents/AgentAvatar";
import { agentAvatarState } from "../agents/agentAvatarModel";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { MemberName } from "./MemberName";
import { type MemberLabel, memberLabels, memberLabelText } from "./memberLabels";
import {
  type GroupActivityState,
  type GroupMemberStatesById,
  memberActivityState,
} from "./useWorkingGroups";

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

function MemberChip({
  avatar,
  label,
  isLead,
  state,
  onOpen,
}: {
  avatar: WorkingMemberAvatar | undefined;
  label: MemberLabel;
  isLead: boolean;
  state: GroupActivityState;
  onOpen(): void;
}) {
  return (
    <button
      className="flex h-6 max-w-[220px] items-center gap-1.5 rounded-full border border-hairline px-2 text-fg-muted text-xs transition-colors hover:bg-hover hover:text-fg"
      data-state={state}
      data-testid="group-member-chip"
      onClick={onOpen}
      title={`Open ${memberLabelText(label)}`}
      type="button"
    >
      {avatar ? (
        <AgentAvatar
          className="-ml-1"
          color={avatar.color}
          face={avatar.face}
          seed={avatar.agentId}
          size={20}
          state={agentAvatarState(state, avatar.archived)}
        />
      ) : null}
      <GroupStateDot state={state} />
      <span className="min-w-0 truncate">
        <MemberName label={label} />
      </span>
      {isLead ? (
        <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-accent/12 px-1 text-2xs text-accent">
          <IconCrown aria-hidden size={ICON.xs} stroke={ICON_STROKE.xs} />
          Lead
        </span>
      ) : null}
    </button>
  );
}

export function GroupRoomHeader({
  avatars,
  group,
  members,
  memberStates,
  projectName,
  running,
  tasksButton,
  onOpenMember,
  onStop,
  onRename,
  onSetMode,
  onManageMembers,
  onDelete,
  onAddAgent,
}: {
  avatars: ReadonlyMap<string, WorkingMemberAvatar>;
  group: AgentGroupWithMembers;
  members: readonly MentionMember[];
  memberStates: GroupMemberStatesById;
  projectName: string | undefined;
  running: boolean;
  tasksButton: ReactNode;
  onOpenMember(sessionId: string): void;
  onStop(): void;
  onRename(name: string): void;
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
  onManageMembers(): void;
  onDelete(): void;
  onAddAgent?: (() => void) | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const coordinating = isCoordinatorModeActive(group);
  const labels = useMemo(() => memberLabels(members), [members]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="shrink-0 border-hairline border-b px-6 py-2.5" data-testid="group-room-header">
      <div className="flex min-w-0 items-center gap-2">
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
          className="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
          data-testid="group-project-badge"
        >
          {projectName ?? "No project"}
        </span>
        {coordinating ? (
          <span
            className="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-2xs text-fg-muted"
            data-testid="group-coordinator-badge"
            title="The Lead coordinates: messages with no mention go to the Lead"
          >
            Coordinator
          </span>
        ) : null}
        <span className="flex-1" />
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
      <div className="mt-2 flex flex-wrap gap-1.5">
        {members.map((member) => (
          <MemberChip
            avatar={avatars.get(member.sessionId)}
            isLead={group.leadSessionId === member.sessionId}
            key={member.sessionId}
            label={labels.get(member.sessionId) ?? { title: member.title }}
            onOpen={() => onOpenMember(member.sessionId)}
            state={memberActivityState(memberStates, group.id, member.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}
