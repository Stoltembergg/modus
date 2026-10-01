import { Menu } from "@base-ui/react/menu";
import {
  IconArchive,
  IconArchiveOff,
  IconChevronRight,
  IconDots,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { AnimatePresence, m, useMotionValue, useReducedMotion } from "motion/react";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentGroupWithMembers,
  AgentSessionInfo,
  CreateAgentGroupInput,
  WorkspaceInfo,
} from "../../../shared/contracts";
import type { SessionActivity } from "../features/agent/agentEventHub";
import { SessionStatusDot } from "../features/agent/SessionStatusDot";
import type { GroupDialogModel, GroupMembersChange } from "../features/groups/CreateGroupDialog";
import {
  isListedChat,
  projectGroupNames,
  removeProjectGroupsWarning,
} from "../features/groups/groupSidebarModel";
import type { NewGroupServices } from "../features/groups/NewGroupModal";
import type { GroupMemberStatesById } from "../features/groups/useWorkingGroups";
import { cn } from "../lib/cn";
import { beginResizeGesture, endResizeGesture } from "../lib/resizeGesture";
import { ICON, ICON_STROKE } from "../lib/uiDensity";
import { useScrollFade } from "../lib/useScrollFade";
import { SidebarGroups } from "./SidebarGroups";
import { CollapsibleMotion } from "./ui/CollapsibleMotion";
import { ScrollReveal } from "./ui/ScrollReveal";

export const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const;

/**
 * Sidebar density contract — one icon rail for nav / folder / session dots.
 * Nested blocks indent by exactly one rail (no magic pl-[30px]).
 */
const SB_RAIL = "pointer-events-none flex w-5 shrink-0 items-center justify-center";
/** Nav / project rows — normalized one step quieter (`text-xs`), matching sessions. */
const SB_ROW =
  "flex h-[30px] w-full items-center gap-2 rounded-md pr-1 pl-2 text-xs font-normal transition-colors";
/** Session rows — same size as nav (`text-xs`); meta stays one step quieter. */
const SB_SESSION =
  "flex h-[30px] w-full items-center gap-2 rounded-md pr-1 pl-2 text-xs font-normal transition-colors";
/** Relative timestamps / meta on session rows. */
const SB_SESSION_META = "px-1 text-2xs font-normal text-fg-faint tabular-nums";
const SB_NEST = "pl-5"; // 20px = one rail
const SB_ICON = ICON.lg;
const SB_STROKE = ICON_STROKE.lg;
const SB_ACTION = ICON.sm;
const SB_ACTION_STROKE = ICON_STROKE.sm;
const LIST_MOTION = { duration: 0.16, ease: "easeOut" } as const;

type SidebarProps = {
  /** The primary rail destination whose list belongs in this context panel. */
  section?: "groups" | "direct-messages";
  workspaces: WorkspaceInfo[];
  agentSessions: AgentSessionInfo[];
  activeSessionId?: string | undefined;
  /** Live run/needs-input/unread state per session for the status dots. */
  activityBySession: Record<string, SessionActivity>;
  open: boolean;
  width: number;
  /** Upper bound from App so the panel can't crush the main column's min width. */
  maxWidth: number;
  onOpenWorkspace(): void;
  onSelectSession(session: AgentSessionInfo): void;
  onNewSession(): void;
  onNewWorkspaceSession(workspace: WorkspaceInfo): void;
  onPinSession(session: AgentSessionInfo, pinned: boolean): void;
  onRenameSession?(id: string, title: string): void;
  onArchiveSession(session: AgentSessionInfo): void;
  onRestoreSession(session: AgentSessionInfo): void;
  onDeleteSession(session: AgentSessionInfo): void;
  onListArchivedSessions(workspaceId: string): Promise<AgentSessionInfo[]>;
  onPinProject(id: string, pinned: boolean): void;
  onRenameProject(id: string, displayName: string): void;
  onArchiveProjectChats(id: string): void;
  onDeleteProjectChats(id: string): void;
  onRemoveProject(id: string): void;
  onRevealProject(id: string): void;
  onOpenSettings(): void;
  onWidthChange(width: number): void;
  canCreateSession: boolean;
  /** Agent Groups (with members). Member chats show only under their group. */
  groups?: readonly AgentGroupWithMembers[];
  /** Models for new agents in the group dialogs. */
  groupModels?: readonly GroupDialogModel[];
  defaultGroupModelId?: string | undefined;
  /** Project preselected in the create-group dialog (usually the active one). */
  activeWorkspaceId?: string | null;
  /** Group-row activity dot selector; defaults to an always-false stub until PR 3. */
  isGroupWorking?: (group: AgentGroupWithMembers) => boolean;
  /** Group-row amber "waiting for you" dot (wins over working). */
  isGroupWaiting?: (group: AgentGroupWithMembers) => boolean;
  /** The group whose room is open in the main panel. */
  activeGroupId?: string | undefined;
  /** Open a group's room (clicking the group name). */
  onSelectGroup?(group: AgentGroupWithMembers): void;
  onCreateGroup?(input: CreateAgentGroupInput): Promise<void>;
  /** The create-group modal's app services (A4). */
  newGroupServices?: NewGroupServices | undefined;
  onRenameGroup?(groupId: string, name: string): void;
  /** "Manage members" (atomic); rejects so the dialog can show the error. */
  onUpdateGroupMembers?(groupId: string, change: GroupMembersChange): Promise<void>;
  onDeleteGroup?(groupId: string): void;
  onRemoveGroupMember?(groupId: string, sessionId: string): void;
  onSetGroupLead?(groupId: string, sessionId: string | null): void;
  /** Room member states (the agents' avatars show working / waiting). */
  groupMemberStates?: GroupMemberStatesById | undefined;
  /** Open an agent's 1:1 chat (A3, created on first open). */
  onOpenAgentChat?(agentId: string): void;
  /** Edit an agent (the agent dialog). */
  onEditAgent?(agentId: string): void;
  /** Add a custom agent to a group (the agent dialog). */
  onAddAgent?(groupId: string): void;
};

const NO_GROUPS: readonly AgentGroupWithMembers[] = [];
const NO_MODELS: readonly GroupDialogModel[] = [];

export function Sidebar({
  section = "groups",
  workspaces,
  agentSessions,
  activeSessionId,
  activityBySession,
  open,
  width,
  maxWidth,
  onOpenWorkspace,
  onSelectSession,
  onNewSession,
  onNewWorkspaceSession,
  onPinSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  onListArchivedSessions,
  onPinProject,
  onRenameProject,
  onArchiveProjectChats,
  onDeleteProjectChats,
  onRemoveProject,
  onRevealProject,
  onWidthChange,
  canCreateSession,
  onRenameSession,
  groups = NO_GROUPS,
  groupModels = NO_MODELS,
  defaultGroupModelId,
  activeWorkspaceId = null,
  isGroupWorking,
  isGroupWaiting,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
  newGroupServices,
  onRenameGroup,
  onUpdateGroupMembers,
  onDeleteGroup,
  onRemoveGroupMember,
  onSetGroupLead,
  groupMemberStates,
  onOpenAgentChat,
  onEditAgent,
  onAddAgent,
}: SidebarProps) {
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [groupsExpanded, setGroupsExpanded] = useState(true);
  // Hidden group room sessions (kind "group_member") are never listed as chats.
  const ungroupedSessions = useMemo(() => agentSessions.filter(isListedChat), [agentSessions]);
  const sessionsByWorkspace = groupSessionsByWorkspace(
    ungroupedSessions.filter((session) => !session.pinnedAt && !session.agentId),
  );
  // Pinned direct messages stay together; the rest of the list stays flat.
  const pinnedSessions = useMemo(
    () =>
      ungroupedSessions.filter(
        (session) =>
          !session.parentSessionId &&
          !session.archivedAt &&
          session.pinnedAt,
      ),
    [ungroupedSessions],
  );
  const directMessageSessions = useMemo(
    () =>
      ungroupedSessions.filter(
        (session) =>
          !session.parentSessionId &&
          !session.archivedAt &&
          !session.pinnedAt,
      ),
    [ungroupedSessions],
  );
  const { ref: scrollFadeRef, fadeTop, fadeBottom } = useScrollFade();
  const scrollContainerRef = scrollFadeRef as RefObject<HTMLElement | null>;

  const dragStartRef = useRef<{ x: number; width: number } | null>(null);
  const latestWidthRef = useRef(width);
  const resizeHandleRef = useRef<HTMLButtonElement | null>(null);
  const reduceMotion = useReducedMotion();
  const panelWidth = useMotionValue(width);
  const isMac = window.modus?.app.platform === "darwin";

  useEffect(() => {
    if (!dragStartRef.current) panelWidth.set(width);
  }, [width, panelWidth]);

  // Never strand the body cursor/selection if the panel unmounts mid-drag.
  useEffect(
    () => () => {
      if (dragStartRef.current) {
        endResizeGesture(document.body, resizeHandleRef.current);
        dragStartRef.current = null;
      }
    },
    [],
  );

  const startResize = (event: PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    dragStartRef.current = { x: event.clientX, width };
    latestWidthRef.current = width;
    resizeHandleRef.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    beginResizeGesture(document.body, event.currentTarget);
  };

  const resize = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!dragStartRef.current) {
      return;
    }
    // Left panel: the handle is on the right edge, so dragging right widens.
    const nextWidth = Math.min(
      SIDEBAR_MAX_WIDTH,
      maxWidth,
      Math.max(
        SIDEBAR_MIN_WIDTH,
        dragStartRef.current.width + event.clientX - dragStartRef.current.x,
      ),
    );
    latestWidthRef.current = nextWidth;
    panelWidth.set(nextWidth);
  };

  const stopResize = (): void => {
    if (!dragStartRef.current) {
      return;
    }
    dragStartRef.current = null;
    endResizeGesture(document.body, resizeHandleRef.current);
    resizeHandleRef.current = null;
    const finalWidth = latestWidthRef.current;
    onWidthChange(finalWidth);
  };

  return (
    <m.aside
      className="relative flex shrink-0 flex-col overflow-hidden bg-panel"
      layout={reduceMotion ? false : "size"}
      layoutDependency={open}
      style={{ transformOrigin: "left", width: open ? panelWidth : 0 }}
      transition={{ layout: SIDEBAR_TRANSITION }}
    >
      <m.div
        className="flex h-full flex-col bg-panel"
        layout={reduceMotion ? false : "position"}
        style={{ width: panelWidth }}
        transition={{ layout: SIDEBAR_TRANSITION }}
      >
        {/* Clears native traffic lights; conversation layout has no separate MenuBar. */}
        {isMac ? <div aria-hidden className="app-drag h-9 shrink-0" /> : null}
        {section === "direct-messages" ? (
          <div className="app-no-drag px-2 pt-3 pb-1">
            <NavRow
              disabled={!canCreateSession}
              icon={<IconEdit size={SB_ICON} stroke={SB_STROKE} />}
              onClick={onNewSession}
            >
              New message
            </NavRow>
          </div>
        ) : null}

        <div
          className={cn(
            "scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2",
            (fadeTop || fadeBottom) && "scroll-fade",
          )}
          {...(fadeTop ? { "data-fade-top": "" } : {})}
          {...(fadeBottom ? { "data-fade-bottom": "" } : {})}
          ref={scrollFadeRef}
        >
          {/* 📌 Pinned section — global, above Projects and Chats */}
          {section === "direct-messages" && pinnedSessions.length > 0 && (
            <>
              <SectionHeader
                expanded={pinnedExpanded}
                onToggle={() => setPinnedExpanded((expanded) => !expanded)}
              >
                📌 Pinned
              </SectionHeader>

              <CollapsibleMotion open={pinnedExpanded} preset="default">
                <div data-testid="sidebar-pinned">
                  <AnimatePresence initial={false}>
                    {pinnedSessions.map((session) => (
                      <ScrollReveal
                        key={session.id}
                        offsetY={8}
                        scrollContainerRef={scrollContainerRef}
                        blurStrength={3}
                      >
                        <SessionRow
                          activity={activityBySession[session.id]}
                          isActive={activeSessionId === session.id}
                          pinned={true}
                          onSelect={() => onSelectSession(session)}
                          onPin={(event) => {
                            event.stopPropagation();
                            onPinSession(session, false);
                          }}
                          onRename={(title) => onRenameSession?.(session.id, title)}
                          onArchive={(event) => {
                            event.stopPropagation();
                            onArchiveSession(session);
                          }}
                          onDelete={(event) => {
                            event.stopPropagation();
                            onDeleteSession(session);
                          }}
                          title={session.title}
                          updatedAt={session.updatedAt}
                        />
                      </ScrollReveal>
                    ))}
                  </AnimatePresence>
                </div>
              </CollapsibleMotion>
              <div className="mt-1" />
            </>
          )}

          {section === "groups" && onCreateGroup ? (
            <>
              <SectionHeader
                expanded={groupsExpanded}
                onToggle={() => setGroupsExpanded((expanded) => !expanded)}
              >
                Groups
              </SectionHeader>
              <CollapsibleMotion open={groupsExpanded} preset="default">
                <SidebarGroups
                  activeSessionId={activeSessionId}
                  activityBySession={activityBySession}
                  defaultWorkspaceId={activeWorkspaceId}
                  groups={groups}
                  onCreateGroup={onCreateGroup}
                  newGroupServices={newGroupServices}
                  onDeleteGroup={(id) => onDeleteGroup?.(id)}
                  onRemoveMember={(groupId, sessionId) => onRemoveGroupMember?.(groupId, sessionId)}
                  onRenameGroup={(id, name) => onRenameGroup?.(id, name)}
                  onSelectSession={onSelectSession}
                  onSetLead={(groupId, sessionId) => onSetGroupLead?.(groupId, sessionId)}
                  onUpdateMembers={async (groupId, change) => {
                    await onUpdateGroupMembers?.(groupId, change);
                  }}
                  sessions={agentSessions}
                  workspaces={workspaces}
                  models={groupModels}
                  defaultModelId={defaultGroupModelId}
                  {...(isGroupWorking ? { isGroupWorking } : {})}
                  {...(isGroupWaiting ? { isGroupWaiting } : {})}
                  {...(onSelectGroup ? { onSelectGroup, activeGroupId } : {})}
                  memberStates={groupMemberStates}
                  onAddAgent={onAddAgent}
                  onEditAgent={onEditAgent}
                  onOpenAgentChat={onOpenAgentChat}
                />
              </CollapsibleMotion>
            </>
          ) : null}

          {section === "direct-messages" ? (
            <>
              <SectionLabel>Direct Messages</SectionLabel>
              <AnimatePresence initial={false}>
                {directMessageSessions.length === 0 ? (
                  <p className="px-2 py-1 text-2xs text-fg-faint">
                    Your direct messages will appear here.
                  </p>
                ) : (
                  directMessageSessions.map((session) => (
                <ScrollReveal
                  key={session.id}
                  offsetY={8}
                  scrollContainerRef={scrollContainerRef}
                  blurStrength={3}
                >
                  <SessionRow
                    activity={activityBySession[session.id]}
                    isActive={activeSessionId === session.id}
                    onArchive={(event) => {
                      event.stopPropagation();
                      onArchiveSession(session);
                    }}
                    onDelete={(event) => {
                      event.stopPropagation();
                      onDeleteSession(session);
                    }}
                    onPin={(event) => {
                      event.stopPropagation();
                      onPinSession(session, !session.pinnedAt);
                    }}
                    onRename={(title) => onRenameSession?.(session.id, title)}
                    onSelect={() => onSelectSession(session)}
                    pinned={Boolean(session.pinnedAt)}
                    title={session.title}
                    updatedAt={session.updatedAt}
                  />
                </ScrollReveal>
                  ))
                )}
              </AnimatePresence>
            </>
          ) : null}

          {section === "direct-messages" ? (
            <div
              className="mt-3 border-t border-hairline pt-2"
              data-testid="sidebar-project-context"
            >
              <SectionHeader
                expanded={projectsExpanded}
                onToggle={() => setProjectsExpanded((expanded) => !expanded)}
              >
                Project context
              </SectionHeader>

              <CollapsibleMotion open={projectsExpanded} preset="default">
                <AnimatePresence initial={false}>
                  {workspaces.map((workspace) => (
                    <m.div
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                      key={workspace.id}
                      layout
                      transition={{
                        duration: reduceMotion ? 0 : LIST_MOTION.duration,
                        ease: LIST_MOTION.ease,
                      }}
                    >
                      <WorkspaceItem
                        activityBySession={activityBySession}
                        onArchiveSession={onArchiveSession}
                        onDeleteSession={onDeleteSession}
                        onListArchivedSessions={onListArchivedSessions}
                        onNewSession={() => onNewWorkspaceSession(workspace)}
                        onPinSession={onPinSession}
                        onRenameSession={(id, title) => onRenameSession?.(id, title)}
                        onRestoreSession={onRestoreSession}
                        onSelectSession={onSelectSession}
                        activeSessionId={activeSessionId}
                        sessions={sessionsByWorkspace.get(workspace.id) ?? []}
                        workspace={workspace}
                        renaming={renamingId === workspace.id}
                        onStartRename={() => setRenamingId(workspace.id)}
                        onCommitRename={(name) => {
                          setRenamingId(null);
                          const next = name.trim();
                          if (next && next !== workspace.displayName) {
                            onRenameProject(workspace.id, next);
                          }
                        }}
                        onCancelRename={() => setRenamingId(null)}
                        onPin={() => onPinProject(workspace.id, !workspace.pinned)}
                        onReveal={() => onRevealProject(workspace.id)}
                        onArchiveChats={() => onArchiveProjectChats(workspace.id)}
                        onDeleteChats={() => onDeleteProjectChats(workspace.id)}
                        onRemove={() => onRemoveProject(workspace.id)}
                        groupNames={projectGroupNames(groups, workspace.id)}
                        scrollContainerRef={scrollContainerRef}
                      />
                    </m.div>
                  ))}
                </AnimatePresence>
                <div className="mt-1">
                  <NavRow
                    icon={<IconFolderPlus size={SB_ICON} stroke={SB_STROKE} />}
                    muted
                    onClick={onOpenWorkspace}
                  >
                    Open workspace
                  </NavRow>
                </div>
              </CollapsibleMotion>
            </div>
          ) : null}
        </div>
      </m.div>
      {open ? (
        <button
          aria-label="Resize left panel"
          className="app-no-drag absolute top-0 right-0 bottom-0 z-20 w-3 cursor-col-resize before:absolute before:inset-y-0 before:right-0 before:w-px before:bg-transparent before:transition-colors hover:before:bg-chip-strong data-[resizing]:before:bg-fg-subtle"
          onBlur={stopResize}
          onLostPointerCapture={stopResize}
          onPointerCancel={stopResize}
          onPointerDown={startResize}
          onPointerMove={resize}
          onPointerUp={stopResize}
          type="button"
        />
      ) : null}
    </m.aside>
  );
}

function WorkspaceItem({
  workspace,
  activeSessionId,
  activityBySession,
  sessions,
  onSelectSession,
  onNewSession,
  onPinSession,
  onRenameSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  onListArchivedSessions,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onPin,
  onReveal,
  onArchiveChats,
  onDeleteChats,
  onRemove,
  groupNames,
  scrollContainerRef,
}: {
  workspace: WorkspaceInfo;
  activeSessionId?: string | undefined;
  activityBySession: Record<string, SessionActivity>;
  sessions: AgentSessionInfo[];
  onSelectSession(session: AgentSessionInfo): void;
  onNewSession(): void;
  onPinSession(session: AgentSessionInfo, pinned: boolean): void;
  onRenameSession(id: string, title: string): void;
  onArchiveSession(session: AgentSessionInfo): void;
  onRestoreSession(session: AgentSessionInfo): void;
  onDeleteSession(session: AgentSessionInfo): void;
  onListArchivedSessions(workspaceId: string): Promise<AgentSessionInfo[]>;
  renaming: boolean;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
  onPin(): void;
  onReveal(): void;
  onArchiveChats(): void;
  onDeleteChats(): void;
  onRemove(): void;
  /** Groups this Project owns; "Remove" confirms first when there are any. */
  /** Groups the Project owns (deleted with it): for the remove confirmation. */
  groupNames: readonly string[];
  scrollContainerRef: RefObject<HTMLElement | null>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionInfo[] | undefined>();
  const [showAllSessions, setShowAllSessions] = useState(false);

  const previewLimit = 2;
  const visibleSessions = (() => {
    if (showAllSessions || sessions.length <= previewLimit) {
      return sessions;
    }
    const preview = sessions.slice(0, previewLimit);
    if (!activeSessionId || preview.some((session) => session.id === activeSessionId)) {
      return preview;
    }
    const active = sessions.find((session) => session.id === activeSessionId);
    return active ? [...preview.slice(0, previewLimit - 1), active] : preview;
  })();
  const canToggleSessions = sessions.length > previewLimit;

  const toggleArchived = (): void => {
    const nextOpen = !archivedOpen;
    setArchivedOpen(nextOpen);
    setExpanded(true);
    if (nextOpen && !archivedSessions) {
      void onListArchivedSessions(workspace.id).then(setArchivedSessions);
    }
  };

  return (
    <>
      <ProjectRow
        expanded={expanded}
        pinned={workspace.pinned}
        renaming={renaming}
        onClick={() => {
          setExpanded((value) => !value);
        }}
        onCreate={(event) => {
          event.stopPropagation();
          onNewSession();
        }}
        onStartRename={onStartRename}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
        onPin={onPin}
        onReveal={onReveal}
        onShowArchived={toggleArchived}
        onArchiveChats={onArchiveChats}
        onDeleteChats={onDeleteChats}
        onRemove={onRemove}
        groupNames={groupNames}
        title={workspace.rootPath}
      >
        {workspace.displayName}
      </ProjectRow>
      <CollapsibleMotion open={expanded} preset="default">
        <AnimatePresence initial={false}>
          {visibleSessions.map((session) => (
            <ScrollReveal
              key={session.id}
              offsetY={8}
              scrollContainerRef={scrollContainerRef}
              blurStrength={3}
            >
              <SessionRow
                activity={activityBySession[session.id]}
                isActive={activeSessionId === session.id}
                onArchive={(event) => {
                  event.stopPropagation();
                  onArchiveSession(session);
                }}
                onDelete={(event) => {
                  event.stopPropagation();
                  onDeleteSession(session);
                }}
                onPin={(event) => {
                  event.stopPropagation();
                  onPinSession(session, !session.pinnedAt);
                }}
                onRename={(title) => onRenameSession(session.id, title)}
                onSelect={() => onSelectSession(session)}
                pinned={Boolean(session.pinnedAt)}
                title={session.title}
                updatedAt={session.updatedAt}
              />
            </ScrollReveal>
          ))}
        </AnimatePresence>
        {canToggleSessions ? (
          <button
            className={cn(SB_SESSION, "text-fg-faint hover:text-fg-subtle")}
            onClick={() => setShowAllSessions((value) => !value)}
            type="button"
          >
            <span aria-hidden className={SB_RAIL} />
            {showAllSessions ? "See less" : "See more"}
          </button>
        ) : null}
        <CollapsibleMotion open={archivedOpen} preset="default">
          <div className={cn("mt-1 space-y-0.5", SB_NEST)}>
            {archivedSessions === undefined ? (
              <div className="px-2 py-1 text-2xs text-fg-faint">Loading archived chats…</div>
            ) : archivedSessions.length === 0 ? (
              <div className="px-2 py-1 text-2xs text-fg-faint">No archived chats</div>
            ) : (
              <AnimatePresence initial={false}>
                {archivedSessions.map((session) => (
                  <ArchivedSessionRow
                    key={session.id}
                    onOpen={() => onSelectSession(session)}
                    onRestore={() => {
                      setArchivedSessions((current) =>
                        current?.filter((item) => item.id !== session.id),
                      );
                      onRestoreSession(session);
                    }}
                    session={session}
                  />
                ))}
              </AnimatePresence>
            )}
          </div>
        </CollapsibleMotion>
      </CollapsibleMotion>
    </>
  );
}

function SessionRow({
  title,
  updatedAt,
  isActive,
  pinned,
  activity,
  onSelect,
  onPin,
  onRename,
  onArchive,
  onDelete,
}: {
  title: string;
  updatedAt: string;
  isActive: boolean;
  pinned: boolean;
  activity: SessionActivity | undefined;
  onSelect(): void;
  onPin(event: MouseEvent<HTMLButtonElement>): void;
  onRename(title: string): void;
  onArchive(event: MouseEvent<HTMLButtonElement>): void;
  onDelete(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [displayTitle, setDisplayTitle] = useState(title);
  const [newTitle, setNewTitle] = useState(title);
  const renameCommittedRef = useRef(false);

  useEffect(() => setDisplayTitle(title), [title]);
  useEffect(() => {
    if (!confirmDelete) return;
    const timeout = window.setTimeout(() => setConfirmDelete(false), 2500);
    return () => window.clearTimeout(timeout);
  }, [confirmDelete]);

  const startRename = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    renameCommittedRef.current = false;
    setIsRenaming(true);
    setNewTitle(displayTitle);
  };

  const commitRename = (): void => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const nextTitle = newTitle.trim();
    if (nextTitle && nextTitle !== displayTitle) {
      setDisplayTitle(nextTitle);
      onRename(nextTitle);
    }
    setIsRenaming(false);
  };

  const cancelRename = (): void => {
    renameCommittedRef.current = true;
    setIsRenaming(false);
    setNewTitle(displayTitle);
  };

  return (
    <m.div
      className={cn(
        SB_SESSION,
        "group",
        isActive ? "row-selected" : "text-fg-subtle hover:bg-hover hover:text-fg-muted",
      )}
      layout
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setConfirmDelete(false);
        }
      }}
      onMouseLeave={() => setConfirmDelete(false)}
      transition={LIST_MOTION}
    >
      <span className={SB_RAIL}>
        <SessionStatusDot activity={activity} />
      </span>
      {isRenaming ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: renaming starts a focused edit by design
          autoFocus
          className="min-w-0 flex-1 rounded-md border border-composer-border bg-elevated px-1.5 py-1 text-fg text-xs outline-none focus:border-accent"
          onBlur={commitRename}
          onChange={(event) => setNewTitle(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onFocusCapture={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelRename();
            }
          }}
          type="text"
          value={newTitle}
        />
      ) : (
        <button
          className="flex min-w-0 flex-1 items-center pr-1 text-left"
          onClick={onSelect}
          title="Open"
          type="button"
        >
          <span className="min-w-0 flex-1 truncate-fade">{displayTitle}</span>
        </button>
      )}
      <span className="ml-0.5 hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        <span className={SB_SESSION_META}>{formatRelativeTime(updatedAt)}</span>
        <IconButton label={pinned ? "Unpin chat" : "Pin chat"} onClick={onPin}>
          {pinned ? (
            <IconPinnedOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          ) : (
            <IconPin size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          )}
        </IconButton>
        <IconButton label="Rename session" onClick={startRename}>
          <IconPencil size={SB_ACTION} stroke={SB_ACTION_STROKE} />
        </IconButton>
        <IconButton label="Archive" onClick={onArchive}>
          <IconArchive size={SB_ACTION} stroke={SB_ACTION_STROKE} />
        </IconButton>
        {confirmDelete ? (
          <button
            className="ml-0.5 h-5 rounded-md px-1.5 text-2xs text-danger transition-colors hover:bg-active"
            onClick={onDelete}
            type="button"
          >
            Confirm
          </button>
        ) : (
          <IconButton
            label="Delete"
            onClick={(event) => {
              event.stopPropagation();
              setConfirmDelete(true);
            }}
          >
            <IconTrash size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          </IconButton>
        )}
      </span>
    </m.div>
  );
}

function ArchivedSessionRow({
  session,
  onOpen,
  onRestore,
}: {
  session: AgentSessionInfo;
  onOpen(): void;
  onRestore(): void;
}) {
  return (
    <m.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(SB_SESSION, "group text-fg-faint hover:bg-hover hover:text-fg-subtle")}
      exit={{ opacity: 0, y: -4 }}
      initial={{ opacity: 0, y: 4 }}
      layout
      transition={LIST_MOTION}
    >
      <span aria-hidden className={SB_RAIL} />
      <button
        className="min-w-0 flex-1 truncate-fade pr-1 text-left"
        onClick={onOpen}
        title="Open archived chat"
        type="button"
      >
        {session.title}
      </button>
      <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        <span className={SB_SESSION_META}>
          {formatRelativeTime(session.archivedAt ?? session.updatedAt)}
        </span>
        <IconButton label="Restore" onClick={onRestore}>
          <IconArchiveOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
        </IconButton>
      </span>
    </m.div>
  );
}

function ProjectRow({
  children,
  expanded,
  pinned,
  renaming,
  onClick,
  onCreate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onPin,
  onReveal,
  onShowArchived,
  onArchiveChats,
  onDeleteChats,
  onRemove,
  groupNames,
  title,
}: {
  children: ReactNode;
  expanded: boolean;
  pinned: boolean;
  renaming: boolean;
  onClick(): void;
  onCreate(event: MouseEvent<HTMLButtonElement>): void;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
  onPin(): void;
  onReveal(): void;
  onShowArchived(): void;
  onArchiveChats(): void;
  onDeleteChats(): void;
  onRemove(): void;
  /** Groups the Project owns (deleted with it): for the remove confirmation. */
  groupNames: readonly string[];
  title?: string;
}) {
  const FolderIcon = expanded ? IconFolderOpen : IconFolder;
  const label = typeof children === "string" ? children : "";

  if (renaming) {
    return (
      <div className={cn(SB_ROW, "text-fg")}>
        <span className={cn(SB_RAIL, "text-fg-subtle")}>
          <FolderIcon size={SB_ICON} stroke={SB_STROKE} />
        </span>
        <RenameInput initialValue={label} onCancel={onCancelRename} onCommit={onCommitRename} />
      </div>
    );
  }

  return (
    <ProjectActions
      groupNames={groupNames}
      onArchiveChats={onArchiveChats}
      onDeleteChats={onDeleteChats}
      onPin={onPin}
      onRemove={onRemove}
      onRename={onStartRename}
      onReveal={onReveal}
      onShowArchived={onShowArchived}
      pinned={pinned}
    >
      {(menuOpen, trigger) => (
        <m.div
          className={cn(
            SB_ROW,
            "group text-fg-muted hover:bg-hover hover:text-fg",
            menuOpen && "bg-hover text-fg",
          )}
          layout
          transition={{ duration: 0.16, ease: "easeOut" }}
        >
          <button
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={onClick}
            title={title}
            type="button"
          >
            <span className={cn(SB_RAIL, "text-fg-muted group-hover:text-fg")}>
              <FolderIcon size={SB_ICON} stroke={SB_STROKE} />
            </span>
            <span className="min-w-0 truncate">{children}</span>
            <m.span
              animate={{ rotate: expanded ? 90 : 0 }}
              className="flex size-3 shrink-0 items-center justify-center text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              transition={{ duration: 0.16, ease: [0.25, 0.1, 0.25, 1] }}
            >
              <IconChevronRight size={ICON.xs} stroke={ICON_STROKE.xs} />
            </m.span>
          </button>
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
              menuOpen ? "opacity-100" : "opacity-0",
            )}
          >
            {trigger}
            <IconButton label="New session" onClick={onCreate}>
              <IconEdit size={SB_ACTION} stroke={SB_ACTION_STROKE} />
            </IconButton>
          </span>
        </m.div>
      )}
    </ProjectActions>
  );
}

/**
 * Inline rename editor. The `committedRef` guard makes commit idempotent so the
 * Enter/Escape keydown and the subsequent blur can't both fire `onCommit`/
 * `onCancel` and double-apply (or fight each other).
 */
function RenameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const commit = (): void => {
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    onCommit(inputRef.current?.value ?? initialValue);
  };

  const cancel = (): void => {
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: rename starts a focused edit by design
      autoFocus
      className="min-w-0 flex-1 rounded-md border border-composer-border bg-elevated px-1.5 py-1 text-fg text-xs outline-none focus:border-accent"
      defaultValue={initialValue}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onFocusCapture={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      ref={inputRef}
      type="text"
    />
  );
}

function NavRow({
  icon,
  children,
  onClick,
  active = false,
  muted = false,
  disabled = false,
  trailing,
  layoutHighlight = false,
  highlight = false,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  muted?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  layoutHighlight?: boolean;
  highlight?: boolean;
  title?: string;
}) {
  return (
    <button
      className={cn(
        SB_ROW,
        "group relative text-left",
        "text-fg-muted hover:bg-hover hover:text-fg",
        highlight && "bg-active text-fg hover:bg-hover",
        muted && "text-fg-faint hover:text-fg-muted",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-fg-faint",
      )}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {active && layoutHighlight ? (
        <m.span
          className="absolute inset-0 rounded-md bg-active"
          layoutId="sidebar-active"
          transition={{ duration: 0.2, ease: "easeOut" }}
        />
      ) : null}
      <span className={cn(SB_RAIL, "relative text-current")}>{icon}</span>
      <span className="relative flex min-w-0 flex-1 items-center truncate">{children}</span>
      {trailing ? <span className="relative shrink-0">{trailing}</span> : null}
    </button>
  );
}

/**
 * The "…" project menu (Figure-2). Render-prop so the trigger lives inline with
 * the hover actions while the row still knows whether the menu is open (to keep
 * the actions pinned visible). Items are data-driven below — adding an action is
 * one row, not a new branch.
 */
function ProjectActions({
  pinned,
  onPin,
  onReveal,
  onRename,
  onShowArchived,
  onArchiveChats,
  onDeleteChats,
  onRemove,
  groupNames,
  children,
}: {
  pinned: boolean;
  onPin(): void;
  onReveal(): void;
  onRename(): void;
  onShowArchived(): void;
  onArchiveChats(): void;
  onDeleteChats(): void;
  onRemove(): void;
  /** Groups the Project owns: with any, "Remove" asks for a second click first. */
  /** Groups the Project owns (deleted with it): for the remove confirmation. */
  groupNames: readonly string[];
  children(open: boolean, trigger: ReactNode): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDeleteChats, setConfirmDeleteChats] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const trigger = (
    <Menu.Trigger
      aria-label="Project actions"
      className="flex size-6 items-center justify-center rounded-md text-fg-faint outline-none transition-colors hover:bg-active hover:text-fg-muted data-popup-open:bg-active data-popup-open:text-fg-muted"
      onClick={(event) => event.stopPropagation()}
    >
      <IconDots size={SB_ACTION} stroke={SB_ACTION_STROKE} />
    </Menu.Trigger>
  );
  return (
    <Menu.Root
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setConfirmDeleteChats(false);
          setConfirmRemove(false);
        }
      }}
      open={open}
    >
      {children(open, trigger)}
      <Menu.Portal>
        <Menu.Positioner align="start" side="bottom" sideOffset={4}>
          <Menu.Popup className="origin-(--transform-origin) min-w-[184px] popup-chrome popup-motion p-1">
            <ProjectMenuItem
              icon={
                pinned ? (
                  <IconPinnedOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
                ) : (
                  <IconPin size={SB_ACTION} stroke={SB_ACTION_STROKE} />
                )
              }
              onClick={onPin}
            >
              {pinned ? "Unpin project" : "Pin project"}
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<IconFolderOpen size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={onReveal}
            >
              Open in Explorer
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<IconPencil size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={onRename}
            >
              Rename project
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<IconArchiveOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={onShowArchived}
            >
              Archived chats
            </ProjectMenuItem>
            <ProjectMenuItem
              icon={<IconArchive size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={onArchiveChats}
            >
              Archive chats
            </ProjectMenuItem>
            <div className="my-1 h-px bg-hairline" />
            <ProjectMenuItem
              // Stay open on the first click so the confirm step is reachable.
              closeOnClick={confirmDeleteChats}
              danger
              icon={<IconTrash size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={() => {
                if (!confirmDeleteChats) {
                  setConfirmDeleteChats(true);
                  return;
                }
                setConfirmDeleteChats(false);
                onDeleteChats();
              }}
            >
              {confirmDeleteChats ? "Confirm delete chats" : "Delete chats"}
            </ProjectMenuItem>
            <ProjectMenuItem
              closeOnClick={groupNames.length === 0 || confirmRemove}
              danger
              icon={<IconX size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={() => {
                // No groups: unchanged, removes right away. With groups: warn first.
                if (groupNames.length > 0 && !confirmRemove) {
                  setConfirmRemove(true);
                  return;
                }
                setConfirmRemove(false);
                onRemove();
              }}
            >
              {confirmRemove ? removeProjectGroupsWarning(groupNames) : "Remove"}
            </ProjectMenuItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ProjectMenuItem({
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

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <m.button
      aria-label={label}
      className="flex size-6 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-active hover:text-fg-muted"
      onClick={onClick}
      type="button"
      whileTap={{ scale: 0.96 }}
    >
      {children}
    </m.button>
  );
}

function SectionHeader({
  children,
  expanded,
  onToggle,
}: {
  children: string;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <div className="group mt-3 mb-0.5 flex h-6 items-center px-2 text-2xs font-normal text-fg-faint">
      <button
        aria-expanded={expanded}
        className="flex items-center gap-1 transition-colors hover:text-fg-subtle"
        onClick={onToggle}
        type="button"
      >
        <span>{children}</span>
        <m.span
          animate={{ rotate: expanded ? 90 : 0 }}
          className="flex size-3 items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          transition={{ duration: 0.24, ease: "easeOut" }}
        >
          <IconChevronRight size={ICON.xs} stroke={ICON_STROKE.xs} />
        </m.span>
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <div className="px-2 pt-3 pb-0.5 text-2xs font-normal text-fg-faint">{children}</div>;
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  const diffMs = Date.now() - timestamp;
  const minutes = Math.max(1, Math.floor(diffMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }

  return `${Math.floor(days / 7)}w`;
}

function groupSessionsByWorkspace(sessions: AgentSessionInfo[]): Map<string, AgentSessionInfo[]> {
  const grouped = new Map<string, AgentSessionInfo[]>();

  for (const session of sessions) {
    const workspaceSessions = grouped.get(session.workspaceId) ?? [];
    workspaceSessions.push(session);
    grouped.set(session.workspaceId, workspaceSessions);
  }

  return grouped;
}
