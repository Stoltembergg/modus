import { IconLayoutSidebarRight } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AgentGroupMode,
  AgentGroupWithMembers,
  GroupProjectContextSnapshot,
  GroupRuntimeEvent,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import {
  GROUP_BLOCKED_TEXT,
  type GroupBlockedReason,
  groupBlockedReason,
} from "../../../../shared/group-blocked";
import { deriveGroupCollabStage } from "../../../../shared/group-collab-status";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import {
  latestExecutionId,
  messageExecutionId,
  shortExecutionLabel,
} from "../../../../shared/group-execution-link";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { memberAvatar } from "../agents/agentAvatarModel";
import {
  CreateGroupDialog,
  type GroupDialogModel,
  type GroupMembersChange,
} from "./CreateGroupDialog";
import { activityButtonMeta, GroupActivityPanel } from "./GroupActivityPanel";
import { GroupComposer, type GroupComposerReply, useUpdatePending } from "./GroupComposer";
import {
  GROUP_ROOM_EMPTY_TEXT,
  GroupMessageList,
  GroupMessageRow,
  isWaitingStatus,
  memberColor,
  StatusText,
} from "./GroupMessageList";
import { projectSetupEventToSnapshot } from "./GroupProjectContextChip";
import { GroupRoomHeader, GroupStateDot } from "./GroupRoomHeader";
import { useGroupTasks } from "./GroupTaskPanel";
import type { WorkingMemberAvatar } from "./GroupWorkingStatus";
import type { MentionMember } from "./groupMentions";
import { replyPreview } from "./groupThreads";
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
  /** Opens a member's 1:1 chat from the Agents panel (explicit action). */
  onOpenAgentChat?(agentId: string): void;
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
  /** Refresh groups after an agent is edited from the Agents panel. */
  onAgentsChanged?(): void;
  /**
   * Host element in the desktop window chrome toolbar. When set, the room
   * header portals into that strip (no second internal header bar).
   */
  chromeHost?: HTMLElement | null | undefined;
};

/** A member's avatar in the room (chips and message authors; A3). */
export type RoomAvatar = WorkingMemberAvatar;

/** The group room (main panel): chrome header, message list, and composer. */
export function GroupRoom(props: GroupRoomProps) {
  // A room owns its reply, composer, questions and scroll lifetime.
  return <GroupRoomContent key={props.group.id} {...props} />;
}

function GroupRoomContent({
  group,
  workspaces,
  models = [],
  defaultModelId,
  memberStates,
  onOpenMember,
  onOpenAgentChat,
  onChooseFolder,
  onRename,
  onSetMode,
  onUpdateMembers,
  onDelete,
  onOpenFile,
  onAddAgent,
  onAgentsChanged,
  chromeHost = null,
}: GroupRoomProps) {
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
  const [composerSeed, setComposerSeed] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<GroupComposerReply | undefined>();
  const [executionFilter, setExecutionFilter] = useState<string | undefined>();
  const [filterGroupId, setFilterGroupId] = useState(group.id);
  if (filterGroupId !== group.id) {
    setFilterGroupId(group.id);
    setExecutionFilter(undefined);
  }
  const { tasks, replace } = useGroupTasks(group.id);
  const { messages, loaded, hasOlder, loadingOlder, error, loadOlder } = useGroupMessages(group.id);
  const workingRows = useGroupMemberWorking(group.id, memberStates);
  const labels = useMemo(() => memberLabels(members), [members]);
  const activeExecutionId = useMemo(() => latestExecutionId(messages), [messages]);
  const activeExecutionTitle = useMemo(() => {
    if (!activeExecutionId) return undefined;
    const root = messages.find((message) => message.id === activeExecutionId);
    return shortExecutionLabel(activeExecutionId, root?.body);
  }, [activeExecutionId, messages]);
  useEffect(() => {
    if (executionFilter && !messages.some((m) => messageExecutionId(m) === executionFilter)) {
      setExecutionFilter(undefined);
    }
  }, [executionFilter, messages]);
  const roles = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of group.members) {
      const role = (member.role ?? member.agentRole).trim();
      if (role) map.set(member.sessionId, role);
    }
    return map;
  }, [group.members]);
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
      queuedSessionIds: entry?.queuedSessionIds ?? [],
      waitingSessionIds: entry?.waitingSessionIds ?? [],
      titleToSessionId,
    });
  }, [messages, memberStates, group.id, titleToSessionId]);
  const coordinating = isCoordinatorModeActive(group);
  const [projectContext, setProjectContext] = useState<GroupProjectContextSnapshot | undefined>();

  useEffect(() => {
    const workspaceId = group.workspaceId;
    if (!workspaceId) {
      setProjectContext(undefined);
      return;
    }
    let cancelled = false;
    const load = window.modus.group.projectContext?.(workspaceId);
    if (load) {
      load
        .then((snapshot: GroupProjectContextSnapshot | null) => {
          if (!cancelled && snapshot) setProjectContext(snapshot);
        })
        .catch((error: unknown) => console.warn("[groups] project context failed", error));
    }
    const unsubscribe = window.modus.group.onEvent((event: GroupRuntimeEvent) => {
      if (event.type !== "group.project-setup") return;
      if (event.workspaceId !== workspaceId) return;
      if (event.groupId && event.groupId !== group.id) return;
      setProjectContext(projectSetupEventToSnapshot(event));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [group.id, group.workspaceId]);

  const header = (
    <GroupRoomHeader
      avatars={avatars}
      defaultModelId={defaultModelId}
      group={group}
      members={members}
      memberStates={memberStates}
      models={models}
      onDelete={onDelete}
      onAddAgent={onAddAgent}
      {...(onAgentsChanged ? { onAgentsChanged } : {})}
      onManageMembers={() => setManaging(true)}
      onOpenAgentChat={(agentId) => {
        if (onOpenAgentChat) onOpenAgentChat(agentId);
        else {
          const member = group.members.find((row) => row.agentId === agentId);
          if (member) onOpenMember(member.sessionId);
        }
      }}
      onRename={onRename}
      onSetMode={onSetMode}
      onStop={() => {
        window.modus.group
          .stop(group.id)
          .catch((error: unknown) => console.warn("[groups] stop failed", error));
      }}
      projectContextStatus={projectContext?.status}
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
      variant={chromeHost ? "chrome" : "standalone"}
    />
  );

  return (
    <div
      className="surface-main flex min-h-0 min-w-0 flex-1"
      data-testid="group-room"
      data-ui-surface="main"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {chromeHost ? createPortal(header, chromeHost) : header}
        <GroupMessageList
          avatars={avatars}
          cwd={workspace?.rootPath}
          error={error}
          executionFilter={executionFilter}
          groupId={group.id}
          hasOlder={hasOlder}
          loadOlder={loadOlder}
          loaded={loaded}
          loadingOlder={loadingOlder}
          memberStates={memberStates}
          members={members}
          messages={messages}
          onExecutionFilterChange={setExecutionFilter}
          onHandoffClick={(targetName) => setComposerSeed(`@${targetName} `)}
          onOpenFile={onOpenFile}
          onReply={(message) =>
            setReplyTo({ messageId: message.id, preview: replyPreview(message.body) })
          }
          onRetry={async (message) => {
            if (!message.turnId) return;
            await window.modus.group.resumeExecution({
              groupId: group.id,
              executionId: message.turnId,
            });
          }}
          roles={roles}
          workingRows={workingRows}
        />
        {blocked ? (
          <BlockedBanner
            onAction={blocked === "project-required" ? onChooseFolder : () => setManaging(true)}
            reason={blocked}
          />
        ) : (
          <GroupComposer
            activeExecutionId={activeExecutionId}
            activeExecutionTitle={activeExecutionTitle}
            groupId={group.id}
            members={members}
            onClearReply={() => setReplyTo(undefined)}
            onSeedConsumed={() => setComposerSeed(undefined)}
            onSend={async (payload) => {
              await window.modus.group.postMessage({
                groupId: group.id,
                body: payload.body,
                ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {}),
                ...(payload.attachments ? { attachments: payload.attachments } : {}),
                ...(payload.contextItems ? { contextItems: payload.contextItems } : {}),
                ...(payload.executionMode ? { executionMode: payload.executionMode } : {}),
                ...(payload.executionId ? { executionId: payload.executionId } : {}),
              });
            }}
            replyTo={replyTo}
            seed={composerSeed}
            showKickoff={loaded && messages.length === 0 && !replyTo}
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
          messages={messages}
          onCancelled={replace}
          onSetMode={onSetMode}
          projectContext={projectContext}
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
