import { IconLayoutSidebarRight } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type {
  AgentGroupMode,
  AgentGroupWithMembers,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  type GroupBlockedReason,
  groupBlockedReason,
} from "../../../../shared/group-blocked";
import { deriveGroupCollabStage } from "../../../../shared/group-collab-status";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { memberAvatar } from "../agents/agentAvatarModel";
import {
  CreateGroupDialog,
  type GroupDialogModel,
  type GroupMembersChange,
} from "./CreateGroupDialog";
import { activityButtonMeta, GroupActivityPanel } from "./GroupActivityPanel";
import { GroupComposer, useUpdatePending } from "./GroupComposer";
import {
  GROUP_ROOM_EMPTY_TEXT,
  GroupMessageList,
  GroupMessageRow,
  isWaitingStatus,
  memberColor,
  StatusText,
} from "./GroupMessageList";
import { GroupRoomHeader, GroupStateDot } from "./GroupRoomHeader";
import { useGroupTasks } from "./GroupTaskPanel";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { memberLabels } from "./memberLabels";
import { useGroupMemberWorking } from "./useGroupMemberWorking";
import { useGroupMessages } from "./useGroupMessages";
import { type GroupMemberStatesById, isGroupRunning } from "./useWorkingGroups";

export {
  GROUP_ROOM_EMPTY_TEXT,
  GroupMessageRow,
  GroupStateDot,
  isWaitingStatus,
  memberColor,
  StatusText,
};

export type GroupRoomProps = {
  group: AgentGroupWithMembers;
  workspaces: readonly WorkspaceInfo[];
  /** Models for new agents in the Manage members dialog. */
  models?: readonly GroupDialogModel[];
  defaultModelId?: string | undefined;
  memberStates: GroupMemberStatesById;
  /** Opens a member's hidden room session (to answer "Waiting for you"). */
  onOpenMember(sessionId: string): void;
  /** "Choose folder" on a group without a Project: pick one and move the group. */
  onChooseFolder?: (() => void) | undefined;
  onRename(name: string): void;
  /** The menu's "Coordinator mode" toggle (PR 7). */
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
  onUpdateMembers(change: GroupMembersChange): Promise<void>;
  onDelete(): void;
  onOpenFile?: ((path: string) => void) | undefined;
  /** "Add agent" in the room menu (the agent dialog; A3). */
  onAddAgent?: (() => void) | undefined;
};

/** A member's avatar in the room (chips and message authors; A3). */
export type RoomAvatar = WorkingMemberAvatar;

/** The group room (main panel): header with members, the message list and the composer. */
export function GroupRoom({
  group,
  workspaces,
  models = [],
  defaultModelId,
  memberStates,
  onOpenMember,
  onChooseFolder,
  onRename,
  onSetMode,
  onUpdateMembers,
  onDelete,
  onOpenFile,
  onAddAgent,
}: GroupRoomProps) {
  const [composerSeed, setComposerSeed] = useState<string | undefined>();
  // Titles come from the members' agents (current name): their room sessions are hidden.
  const members: MentionMember[] = useMemo(
    () => group.members.map((member) => ({ sessionId: member.sessionId, title: member.name })),
    [group.members],
  );
  const avatars = useMemo(
    () =>
      new Map<string, RoomAvatar>(
        group.members.map((member) => [
          member.sessionId,
          { agentId: member.agentId, ...memberAvatar(member), archived: member.archived === true },
        ]),
      ),
    [group.members],
  );
  const blocked = groupBlockedReason(group, group.members);
  const workspace = group.workspaceId
    ? workspaces.find((item) => item.id === group.workspaceId)
    : undefined;
  const updatePending = useUpdatePending(window.modus.update);
  const [managing, setManaging] = useState(false);
  const running = isGroupRunning(memberStates, group.id);
  const [activityOpen, setActivityOpen] = useState(false);
  const { tasks, replace } = useGroupTasks(group.id);
  const { messages, loaded, hasOlder, loadingOlder, error, loadOlder } = useGroupMessages(group.id);
  const workingRows = useGroupMemberWorking(group.id, memberStates);
  const labels = useMemo(() => memberLabels(members), [members]);
  const { openCount, label: activityLabel } = activityButtonMeta(tasks);
  const titleToSessionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) map.set(member.title.toLocaleLowerCase(), member.sessionId);
    return map;
  }, [members]);
  const stage = useMemo(() => {
    const entry = memberStates.get(group.id);
    return deriveGroupCollabStage(messages, {
      runningSessionIds: entry?.runningSessionIds ?? [],
      titleToSessionId,
    });
  }, [messages, memberStates, group.id, titleToSessionId]);
  const coordinating = isCoordinatorModeActive(group);

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="group-room">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <GroupRoomHeader
          avatars={avatars}
          group={group}
          members={members}
          memberStates={memberStates}
          onDelete={onDelete}
          onAddAgent={onAddAgent}
          onManageMembers={() => setManaging(true)}
          onOpenMember={onOpenMember}
          onRename={onRename}
          onSetMode={onSetMode}
          onStop={() => {
            window.modus.group
              .stop(group.id)
              .catch((error: unknown) => console.warn("[groups] stop failed", error));
          }}
          projectName={workspace?.displayName}
          running={running}
          tasksButton={
            <button
              aria-expanded={activityOpen}
              aria-label={activityLabel}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-fg-faint text-xs transition-colors hover:bg-hover hover:text-fg-muted",
                activityOpen && "bg-hover text-fg-muted",
              )}
              onClick={() => setActivityOpen((open) => !open)}
              title={activityOpen ? "Hide activity" : "Show activity"}
              type="button"
            >
              <IconLayoutSidebarRight size={ICON.sm} stroke={ICON_STROKE.sm} />
              Activity
              <span className="tabular-nums" data-testid="group-task-count">
                {openCount}
              </span>
            </button>
          }
        />
        <GroupMessageList
          avatars={avatars}
          cwd={workspace?.rootPath}
          error={error}
          groupId={group.id}
          hasOlder={hasOlder}
          loadOlder={loadOlder}
          loaded={loaded}
          loadingOlder={loadingOlder}
          memberStates={memberStates}
          members={members}
          messages={messages}
          onHandoffClick={(targetName) => setComposerSeed(`@${targetName} `)}
          onOpenFile={onOpenFile}
          workingRows={workingRows}
        />
        {blocked ? (
          <BlockedBanner
            onAction={blocked === "project-required" ? onChooseFolder : () => setManaging(true)}
            reason={blocked}
          />
        ) : (
          <GroupComposer
            members={members}
            onSeedConsumed={() => setComposerSeed(undefined)}
            onSend={async (body) => {
              await window.modus.group.postMessage({ groupId: group.id, body });
            }}
            seed={composerSeed}
            showKickoff={loaded && messages.length === 0}
            updatePending={updatePending}
          />
        )}
      </div>
      {activityOpen ? (
        <GroupActivityPanel
          coordinating={coordinating}
          groupId={group.id}
          hasLead={Boolean(group.leadSessionId)}
          labels={labels}
          onCancelled={replace}
          onSetMode={onSetMode}
          stage={stage}
          tasks={tasks}
          workingRows={workingRows}
        />
      ) : null}
      {managing ? (
        <CreateGroupDialog
          defaultModelId={defaultModelId}
          group={group}
          mode="edit"
          models={models}
          onOpenChange={(open) => {
            if (!open) setManaging(false);
          }}
          onSave={onUpdateMembers}
          open
          workspaces={workspaces}
        />
      ) : null}
    </div>
  );
}

/**
 * A blocked group is read-only (no composer): "Choose a folder to continue
 * this group" / "Add a member to continue", with the way out as a button.
 */
export function BlockedBanner({
  reason,
  onAction,
}: {
  reason: GroupBlockedReason;
  onAction?: (() => void) | undefined;
}) {
  return (
    <div
      className="mx-4 mb-3 flex items-center gap-3 rounded-lg border border-hairline bg-chip px-3 py-2 text-xs text-fg-muted"
      data-testid="group-blocked-banner"
      role="status"
    >
      <span className="min-w-0 flex-1">{GROUP_BLOCKED_TEXT[reason]}</span>
      {onAction ? (
        <button
          className="h-7 shrink-0 rounded-md bg-accent px-3 text-white text-xs hover:opacity-90"
          onClick={onAction}
          type="button"
        >
          {reason === "project-required" ? "Choose folder" : "Add agent"}
        </button>
      ) : null}
    </div>
  );
}
