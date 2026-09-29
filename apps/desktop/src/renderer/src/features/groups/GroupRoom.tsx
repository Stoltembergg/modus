import { Menu } from "@base-ui/react/menu";
import { IconCrown, IconDots, IconLayoutSidebarRight, IconPlayerStop } from "@tabler/icons-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AgentGroupMode,
  AgentGroupWithMembers,
  AgentSessionInfo,
  GroupMessage,
  WorkspaceInfo,
} from "../../../../shared/contracts";
import { isCoordinatorModeActive } from "../../../../shared/group-coordinator";
import { GroupMenuItems, GroupRenameInput } from "../../components/SidebarGroups";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { MarkdownMessage } from "../agent/MarkdownMessage";
import { SessionStatusDot } from "../agent/SessionStatusDot";
import { CreateGroupDialog, type GroupMembersChange } from "./CreateGroupDialog";
import { GroupComposer, useUpdatePending } from "./GroupComposer";
import { GroupDecisionsSection } from "./GroupDecisions";
import { activeTaskCount, GroupTaskPanel, useGroupTasks } from "./GroupTaskPanel";
import { linkMentionsInMarkdown, type MentionMember, splitMentions } from "./groupMentions";
import { MemberName } from "./MemberName";
import { MentionChip } from "./MentionChip";
import { type MemberLabel, memberLabels, memberLabelText } from "./memberLabels";
import { useGroupMessages } from "./useGroupMessages";
import {
  type GroupActivityState,
  type GroupMemberStatesById,
  isGroupRunning,
  memberActivityState,
} from "./useWorkingGroups";

export const GROUP_ROOM_EMPTY_TEXT = "Write to the group. The lead answers, or @mention a member.";

const MEMBER_COLORS = [
  "#e8784a",
  "#4a9ee8",
  "#57b87a",
  "#b57ae8",
  "#e8b04a",
  "#e85a8c",
  "#4ac2c2",
  "#8f9ae8",
];

/** Stable per-member color for the initial badge. */
export function memberColor(sessionId: string): string {
  let hash = 0;
  for (const char of sessionId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return MEMBER_COLORS[hash % MEMBER_COLORS.length] ?? "#8f9ae8";
}

export type GroupRoomProps = {
  group: AgentGroupWithMembers;
  /** Root sessions (member titles and the Manage members dialog). */
  sessions: readonly AgentSessionInfo[];
  workspaces: readonly WorkspaceInfo[];
  /** Every session already in some group (the Manage members dialog). */
  memberSessionIds: ReadonlySet<string>;
  memberStates: GroupMemberStatesById;
  onOpenMember(session: AgentSessionInfo): void;
  onRename(name: string): void;
  /** The menu's "Coordinator mode" toggle (PR 7). */
  onSetMode?: ((mode: AgentGroupMode) => void) | undefined;
  onUpdateMembers(change: GroupMembersChange): Promise<void>;
  onDelete(): void;
  onOpenFile?: ((path: string) => void) | undefined;
};

/** The group room (main panel): header with members, the message list and the composer. */
export function GroupRoom({
  group,
  sessions,
  workspaces,
  memberSessionIds,
  memberStates,
  onOpenMember,
  onRename,
  onSetMode,
  onUpdateMembers,
  onDelete,
  onOpenFile,
}: GroupRoomProps) {
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const members: MentionMember[] = useMemo(
    () =>
      group.members.map((member) => ({
        sessionId: member.sessionId,
        title: sessionsById.get(member.sessionId)?.title ?? member.sessionId,
      })),
    [group.members, sessionsById],
  );
  const workspace = group.workspaceId
    ? workspaces.find((item) => item.id === group.workspaceId)
    : undefined;
  const updatePending = useUpdatePending(window.modus.update);
  const [managing, setManaging] = useState(false);
  const running = isGroupRunning(memberStates, group.id);
  const [tasksOpen, setTasksOpen] = useState(false);
  const { tasks, replace } = useGroupTasks(group.id);
  const labels = useMemo(() => memberLabels(members), [members]);
  const openTasks = activeTaskCount(tasks);

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="group-room">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RoomHeader
          group={group}
          members={members}
          memberStates={memberStates}
          onDelete={onDelete}
          onManageMembers={() => setManaging(true)}
          onOpenMember={(sessionId) => {
            const session = sessionsById.get(sessionId);
            if (session) onOpenMember(session);
          }}
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
              aria-expanded={tasksOpen}
              aria-label={`Tasks (${openTasks} active)`}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-fg-faint text-xs transition-colors hover:bg-hover hover:text-fg-muted",
                tasksOpen && "bg-hover text-fg-muted",
              )}
              onClick={() => setTasksOpen((open) => !open)}
              title={tasksOpen ? "Hide tasks" : "Show tasks"}
              type="button"
            >
              <IconLayoutSidebarRight size={ICON.sm} stroke={ICON_STROKE.sm} />
              Tasks
              <span className="tabular-nums" data-testid="group-task-count">
                {openTasks}
              </span>
            </button>
          }
        />
        <MessageList
          cwd={workspace?.rootPath}
          groupId={group.id}
          members={members}
          onOpenFile={onOpenFile}
        />
        <GroupComposer
          members={members}
          onSend={async (body) => {
            await window.modus.group.postMessage({ groupId: group.id, body });
          }}
          updatePending={updatePending}
        />
      </div>
      {tasksOpen ? (
        <GroupTaskPanel
          labels={labels}
          onCancelled={replace}
          tasks={tasks}
          top={<GroupDecisionsSection groupId={group.id} labels={labels} />}
        />
      ) : null}
      {managing ? (
        <CreateGroupDialog
          group={group}
          memberSessionIds={memberSessionIds}
          mode="edit"
          onOpenChange={(open) => {
            if (!open) setManaging(false);
          }}
          onSave={onUpdateMembers}
          open
          sessions={sessions}
          workspaces={workspaces}
        />
      ) : null}
    </div>
  );
}

function RoomHeader({
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
}: {
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
}) {
  const [renaming, setRenaming] = useState(false);
  // Without a Lead the stored mode is ignored: no badge, toggle off and disabled.
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
                />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {members.map((member) => (
          <MemberChip
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

/** Member state dot: the chat's working orb, amber for waiting for you, nothing when idle. */
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
  label,
  isLead,
  state,
  onOpen,
}: {
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

function MessageList({
  groupId,
  members,
  cwd,
  onOpenFile,
}: {
  groupId: string;
  members: readonly MentionMember[];
  cwd: string | undefined;
  onOpenFile: ((path: string) => void) | undefined;
}) {
  const { messages, loaded, hasOlder, loadingOlder, error, loadOlder } = useGroupMessages(groupId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ first: string | undefined; height: number; nearBottom: boolean }>({
    first: undefined,
    height: 0,
    nearBottom: true,
  });
  const labels = useMemo(() => memberLabels(members), [members]);

  // Older page prepended: keep the view where it was. New message at the bottom:
  // follow it when the user was already at the bottom.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const previous = anchorRef.current;
    const first = messages[0]?.id;
    if (previous.first && first !== previous.first && node.scrollHeight > previous.height) {
      node.scrollTop += node.scrollHeight - previous.height;
    } else if (previous.nearBottom) {
      node.scrollTop = node.scrollHeight;
    }
    anchorRef.current = { first, height: node.scrollHeight, nearBottom: previous.nearBottom };
  }, [messages]);

  // A first page shorter than the viewport cannot be scrolled: load on.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || node.clientHeight === 0 || !hasOlder || loadingOlder) return;
    if (node.scrollHeight <= node.clientHeight) void loadOlder();
  }, [hasOlder, loadingOlder, loadOlder]);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="group-message-list"
      onScroll={(event) => {
        const node = event.currentTarget;
        anchorRef.current.nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        anchorRef.current.height = node.scrollHeight;
        if (node.scrollTop < 40 && hasOlder && !loadingOlder) void loadOlder();
      }}
      ref={scrollRef}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-5">
        {loadingOlder ? (
          <div className="text-center text-2xs text-fg-faint">Loading older messages…</div>
        ) : null}
        {error ? <div className="text-center text-danger text-xs">{error}</div> : null}
        {loaded && messages.length === 0 && !error ? (
          <div className="py-16 text-center text-fg-faint text-sm" data-testid="group-room-empty">
            {GROUP_ROOM_EMPTY_TEXT}
          </div>
        ) : null}
        {messages.map((message) => (
          <GroupMessageRow
            cwd={cwd}
            key={message.id}
            members={members}
            message={message}
            onOpenFile={onOpenFile}
            labels={labels}
          />
        ))}
      </div>
    </div>
  );
}

function MentionText({ text, members }: { text: string; members: readonly MentionMember[] }) {
  return (
    <>
      {splitMentions(text, members).map((segment, index) =>
        segment.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <span key={index}>{segment.text}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <MentionChip key={index}>@{segment.label}</MentionChip>
        ),
      )}
    </>
  );
}

/** Status bodies: only `inline code` spans are formatted (no full markdown). */
export function StatusText({ text, members }: { text: string; members: readonly MentionMember[] }) {
  return (
    <>
      {text.split(/`([^`\n]+)`/).map((part, index) =>
        index % 2 === 1 ? (
          <code
            className="rounded-sm bg-elevated px-1 py-px font-mono text-[0.95em]"
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
            key={index}
          >
            {part}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
          <MentionText key={index} members={members} text={part} />
        ),
      )}
    </>
  );
}

/** "Waiting for you" and its limit / budget variants (amber, like the waiting dot). */
export function isWaitingStatus(body: string): boolean {
  return body.startsWith("Waiting for you");
}

export function GroupMessageRow({
  message,
  members,
  labels,
  cwd,
  onOpenFile,
}: {
  message: GroupMessage;
  members: readonly MentionMember[];
  labels: ReadonlyMap<string, MemberLabel>;
  cwd?: string | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const author: MemberLabel | undefined = message.authorSessionId
    ? (labels.get(message.authorSessionId) ?? { title: message.authorSessionId })
    : undefined;
  if (message.kind === "status") {
    const waiting = isWaitingStatus(message.body);
    return (
      <div
        className="text-center text-2xs text-fg-faint"
        data-kind="status"
        data-testid="group-message"
      >
        {author && message.authorKind === "agent" ? (
          <span className="text-fg-subtle">
            <MemberName label={author} /> ·{" "}
          </span>
        ) : null}
        <span
          className={waiting ? "text-amber-400" : undefined}
          data-waiting={waiting || undefined}
        >
          <StatusText members={members} text={message.body} />
        </span>
      </div>
    );
  }
  if (message.authorKind === "user") {
    return (
      <div className="flex justify-end" data-kind="user" data-testid="group-message">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-elevated px-3.5 py-2 text-fg text-sm">
          <MentionText members={members} text={message.body} />
        </div>
      </div>
    );
  }
  const sessionId = message.authorSessionId ?? "";
  const label = author ?? { title: "Member" };
  const title = label.title;
  return (
    <div className="flex gap-2.5" data-kind="member" data-testid="group-message">
      <span
        aria-hidden
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-medium text-white text-xs"
        style={{ backgroundColor: memberColor(sessionId) }}
      >
        {title.trim().charAt(0).toLocaleUpperCase() || "?"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 font-medium text-fg-muted text-xs">
          <MemberName label={label} />
        </div>
        <div className="text-fg text-sm">
          <MarkdownMessage
            content={linkMentionsInMarkdown(message.body, members)}
            cwd={cwd}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
}
