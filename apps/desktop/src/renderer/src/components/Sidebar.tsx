import { Menu } from "@base-ui/react/menu";
import {
  IconArchive,
  IconArchiveOff,
  IconArrowDown,
  IconArrowUp,
  IconChevronRight,
  IconDots,
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconTrash,
  IconUserEdit,
  IconUserPlus,
  IconX,
} from "@tabler/icons-react";
import { AnimatePresence, m, useMotionValue, useReducedMotion } from "motion/react";
import {
  type ContextType,
  createContext,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { agentAvatarForId } from "../../../shared/agent-templates";
import type {
  AgentInfo,
  AgentSessionInfo,
  MoveAgentSessionInput,
  WorkspaceInfo,
} from "../../../shared/contracts";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import type { SessionActivity } from "../features/agent/agentEventHub";
import { SessionStatusDot } from "../features/agent/SessionStatusDot";
import { AgentAvatar } from "../features/agents/AgentAvatar";
import { cn } from "../lib/cn";
import { beginResizeGesture, endResizeGesture } from "../lib/resizeGesture";
import { useShellText } from "../lib/shellText";
import { ICON, ICON_STROKE } from "../lib/uiDensity";
import { formatUiCompactAge } from "../lib/uiIntl";
import { useScrollFade } from "../lib/useScrollFade";
import {
  moveSessionBefore,
  orderSessions,
  readSessionOrder,
  writeSessionOrder,
} from "./sidebar-session-order";
import { CollapsibleMotion } from "./ui/CollapsibleMotion";
import { useHoldNavRail } from "./ui/NavRail";

/** Former hidden group room sessions are never listed (all are converted by the PR 4 migration). */
function isListedChat(session: AgentSessionInfo): boolean {
  return session.kind !== "group_member";
}

const NO_NAMES: readonly string[] = [];
const NO_AGENTS: readonly AgentInfo[] = [];

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
const SB_NEST = "pl-5"; // 20px = one rail
const SB_ICON = ICON.lg;
const SB_STROKE = ICON_STROKE.lg;
const SB_ACTION = ICON.sm;
const SB_ACTION_STROKE = ICON_STROKE.sm;
const LIST_MOTION = { duration: 0.16, ease: "easeOut" } as const;

// Scoped to this sidebar; drag payloads never authorize a workspace or executable path.
const SessionMovement = createContext<{
  workspaces: WorkspaceInfo[];
  pending: boolean;
  before?: string | undefined;
  move(input: MoveAgentSessionInput, before?: string): Promise<void>;
  reorder(id: string, direction: -1 | 1): void;
} | null>(null);

type SessionMovementValue = NonNullable<ContextType<typeof SessionMovement>>;

type SidebarProps = {
  /** The primary rail destination whose list belongs in this context panel. */
  section?: "direct-messages";
  workspaces: WorkspaceInfo[];
  agentSessions: AgentSessionInfo[];
  agents?: readonly AgentInfo[];
  chatsExpanded?: boolean;
  onToggleChats?: () => void;
  onExpandChats?: () => void;
  projectsExpanded?: boolean;
  onToggleProjects?: () => void;
  /** Optional target for pinned items above the Projects control. */
  pinnedContainer?: HTMLElement | null;
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
  onMoveSession?(input: MoveAgentSessionInput): Promise<AgentSessionInfo>;
  onRenameSession?(id: string, title: string): void;
  /** An agent's 1:1 chat: open that agent's profile for editing. */
  onEditAgentProfile?(agentId: string): void;
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
  /** "New profile" button next to/near New group. */
  onNewProfile?(): void;
  /** Render only the scrolling list, for the animated app sidebar (no panel, no resize). */
  embedded?: boolean;
};

export function Sidebar({
  section = "direct-messages",
  workspaces,
  agentSessions,
  agents = NO_AGENTS,
  chatsExpanded: controlledChatsExpanded,
  onToggleChats,
  onExpandChats,
  projectsExpanded: controlledProjectsExpanded,
  onToggleProjects,
  pinnedContainer,
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
  onMoveSession,
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
  onEditAgentProfile,
  onNewProfile,
  embedded = false,
}: SidebarProps) {
  const t = useShellText();
  const [localProjectsExpanded, setProjectsExpanded] = useState(false);
  const projectsExpanded = controlledProjectsExpanded ?? localProjectsExpanded;
  const [localChatsExpanded, setChatsExpanded] = useState(true);
  const chatsExpanded = controlledChatsExpanded ?? localChatsExpanded;
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [sessionOrder, setSessionOrder] = useState(readSessionOrder);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const draggedRef = useRef<string | null>(null);
  const movePending = useRef(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<HTMLElement | null>(null);
  // Hidden group room sessions (kind "group_member") are never listed as chats.
  const ungroupedSessions = useMemo(
    () =>
      orderSessions(
        agentSessions.filter(
          (session) => isListedChat(session) && !session.parentSessionId && !session.archivedAt,
        ),
        sessionOrder,
      ),
    [agentSessions, sessionOrder],
  );
  const workspaceIds = useMemo(
    () => new Set(workspaces.map((workspace) => workspace.id)),
    [workspaces],
  );
  const isInboxWorkspace = (workspace: WorkspaceInfo) =>
    workspace.inbox === true || workspace.id === CHATS_WORKSPACE_ID;
  const inboxWorkspace = workspaces.find(isInboxWorkspace);
  const projectWorkspaces = workspaces.filter((workspace) => !isInboxWorkspace(workspace));
  const sessionsByWorkspace = groupSessionsByWorkspace(
    // Agent (profile) chats are listed in their project like any chat.
    ungroupedSessions.filter((session) => !session.pinnedAt),
  );
  // Pinned sessions have one location. Other sessions belong to their project.
  const pinnedSessions = useMemo(
    () =>
      ungroupedSessions.filter(
        (session) => !session.parentSessionId && !session.archivedAt && session.pinnedAt,
      ),
    [ungroupedSessions],
  );
  const unavailableProjectSessions = useMemo(
    () =>
      ungroupedSessions.filter(
        (session) => !session.pinnedAt && !workspaceIds.has(session.workspaceId),
      ),
    [ungroupedSessions, workspaceIds],
  );
  const { ref: scrollFadeRef, fadeTop, fadeBottom } = useScrollFade();

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

  const saveOrder = (ids: string[]): void => {
    setSessionOrder(ids);
    writeSessionOrder(ids);
  };
  const move = async (input: MoveAgentSessionInput, before?: string): Promise<void> => {
    if (!onMoveSession || movePending.current) return;
    if (!ungroupedSessions.some((session) => session.id === input.id)) return;
    movePending.current = true;
    setMoving(true);
    setMoveError(null);
    try {
      await onMoveSession(input);
      saveOrder(
        moveSessionBefore(
          ungroupedSessions.map((session) => session.id),
          input.id,
          before,
        ),
      );
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      movePending.current = false;
      setMoving(false);
    }
  };
  const reorder = (id: string, direction: -1 | 1): void => {
    if (movePending.current) return;
    const source = ungroupedSessions.find((session) => session.id === id);
    if (!source) return;
    const peers = ungroupedSessions.filter((session) =>
      source.pinnedAt
        ? Boolean(session.pinnedAt)
        : !session.pinnedAt && session.workspaceId === source.workspaceId,
    );
    const index = peers.findIndex((session) => session.id === id);
    const neighbor = peers[index + direction];
    if (!neighbor) return;
    saveOrder(
      moveSessionBefore(
        ungroupedSessions.map((session) => session.id),
        direction < 0 ? id : neighbor.id,
        direction < 0 ? neighbor.id : id,
      ),
    );
  };
  const clearDrag = (): void => {
    draggedRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  };
  const dragStart = (event: DragEvent<HTMLElement>): void => {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-session-id]")
        : null;
    const id = row?.dataset.sessionId;
    if (
      !onMoveSession ||
      !id ||
      movePending.current ||
      !ungroupedSessions.some((session) => session.id === id)
    ) {
      event.preventDefault();
      return;
    }
    draggedRef.current = id;
    setDraggedId(id);
    setMoveError(null);
    event.dataTransfer.effectAllowed = "move";
    // Only an in-memory drag started by this sidebar is accepted on drop.
    event.dataTransfer.setData("application/x-modus-session", id);
  };
  const targetFor = (event: DragEvent<HTMLElement>): HTMLElement | null => {
    if (!draggedRef.current || movePending.current || !(event.target instanceof Element))
      return null;
    return event.target.closest<HTMLElement>(
      "[data-session-id], [data-workspace-drop], [data-pin-drop]",
    );
  };
  const dragOver = (event: DragEvent<HTMLElement>): void => {
    const target = targetFor(event);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  };
  const drop = (event: DragEvent<HTMLElement>): void => {
    const target = targetFor(event);
    const id = draggedRef.current;
    if (!target || !id) return;
    event.preventDefault();
    event.stopPropagation();
    const before = target.dataset.sessionId;
    const targetSession = before
      ? ungroupedSessions.find((session) => session.id === before)
      : undefined;
    const pinned = Boolean(targetSession?.pinnedAt || target.hasAttribute("data-pin-drop"));
    const workspaceId = pinned
      ? undefined
      : (targetSession?.workspaceId ?? target.dataset.workspaceDrop);
    clearDrag();
    if (before === id || (!pinned && !workspaces.some((workspace) => workspace.id === workspaceId)))
      return;
    void move({ id, ...(workspaceId ? { workspaceId } : {}), pinned }, before);
  };

  const pinnedList = (
    <div
      data-pin-drop=""
      data-testid="sidebar-pin-drop"
      className={cn(
        "rounded-md",
        draggedId && "min-h-8 border border-dashed border-composer-border",
        dropTarget?.hasAttribute("data-pin-drop") && "bg-hover",
      )}
    >
      {draggedId && pinnedSessions.length === 0 ? (
        <div className="px-2 py-2 text-fg-muted text-xs">Drop here to pin</div>
      ) : null}
      {section === "direct-messages" && pinnedSessions.length > 0 && (
        <>
          <SectionHeader
            expanded={pinnedExpanded}
            onToggle={() => setPinnedExpanded((expanded) => !expanded)}
          >
            <span className="inline-flex items-center gap-1.5">
              <IconPin aria-hidden size={14} stroke={SB_STROKE} />
              Pinned
            </span>
          </SectionHeader>

          <CollapsibleMotion open={pinnedExpanded} preset="default">
            <div data-testid="sidebar-pinned">
              {pinnedSessions.map((session) => (
                <SessionRow
                  sessionId={session.id}
                  agent={session.agentId ? agentsById.get(session.agentId) : undefined}
                  agentId={session.agentId}
                  key={session.id}
                  activity={activityBySession[session.id]}
                  isActive={activeSessionId === session.id}
                  pinned={true}
                  onSelect={() => onSelectSession(session)}
                  onPin={(event) => {
                    event.stopPropagation();
                    onPinSession(session, false);
                  }}
                  onEditProfile={
                    session.agentId && onEditAgentProfile
                      ? () => onEditAgentProfile(session.agentId as string)
                      : undefined
                  }
                  onRename={(title) => onRenameSession?.(session.id, title)}
                  onArchive={() => onArchiveSession(session)}
                  onDelete={() => onDeleteSession(session)}
                  title={session.title}
                  updatedAt={session.updatedAt}
                />
              ))}
            </div>
          </CollapsibleMotion>
          <div className="mt-1" />
        </>
      )}
    </div>
  );

  const renderWorkspaceItem = (workspace: WorkspaceInfo) => (
    <WorkspaceItem
      activityBySession={activityBySession}
      agentsById={agentsById}
      onArchiveSession={onArchiveSession}
      onDeleteSession={onDeleteSession}
      onListArchivedSessions={onListArchivedSessions}
      onNewSession={() => onNewWorkspaceSession(workspace)}
      onPinSession={onPinSession}
      onRenameSession={(id, title) => onRenameSession?.(id, title)}
      onEditAgentProfile={onEditAgentProfile}
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
      groupNames={NO_NAMES}
    />
  );

  const list = (
    <SessionMovement.Provider
      value={
        onMoveSession
          ? { workspaces, pending: moving, before: dropTarget?.dataset.sessionId, move, reorder }
          : null
      }
    >
      <section
        className="contents"
        aria-label="Project sessions"
        onDragStartCapture={dragStart}
        onDragEndCapture={clearDrag}
        onDragOver={dragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(null);
        }}
        onDrop={drop}
        aria-busy={moving}
      >
        <div
          className={cn(
            "scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2",
            (fadeTop || fadeBottom) && "scroll-fade",
          )}
          {...(fadeTop ? { "data-fade-top": "" } : {})}
          {...(fadeBottom ? { "data-fade-bottom": "" } : {})}
          ref={scrollFadeRef}
        >
          {moveError ? (
            <div role="alert" className="px-2 py-2 text-danger text-xs">
              {moveError}
            </div>
          ) : null}
          {pinnedContainer === undefined
            ? pinnedList
            : pinnedContainer
              ? createPortal(pinnedList, pinnedContainer)
              : null}

          {section === "direct-messages" ? (
            <>
              {inboxWorkspace ? (
                <div
                  className={cn(
                    "rounded-md",
                    dropTarget?.dataset.workspaceDrop === CHATS_WORKSPACE_ID && "bg-hover",
                  )}
                  data-testid="sidebar-chats"
                  data-workspace-drop={CHATS_WORKSPACE_ID}
                >
                  <InboxChatsSection
                    activeSessionId={activeSessionId}
                    activityBySession={activityBySession}
                    agentsById={agentsById}
                    expanded={chatsExpanded}
                    onExpand={() => {
                      if (onExpandChats) onExpandChats();
                      else setChatsExpanded(true);
                    }}
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    onEditAgentProfile={onEditAgentProfile}
                    onListArchivedSessions={onListArchivedSessions}
                    onPinSession={onPinSession}
                    onRenameSession={(id, title) => onRenameSession?.(id, title)}
                    onRestoreSession={onRestoreSession}
                    onSelectSession={onSelectSession}
                    onToggle={() => {
                      if (onToggleChats) onToggleChats();
                      else setChatsExpanded((expanded) => !expanded);
                    }}
                    sessions={sessionsByWorkspace.get(inboxWorkspace.id) ?? []}
                    workspaceId={inboxWorkspace.id}
                  />
                </div>
              ) : null}
              <div data-testid="sidebar-projects">
                <SectionHeader
                  expanded={projectsExpanded}
                  onToggle={() => {
                    if (onToggleProjects) onToggleProjects();
                    else setProjectsExpanded((expanded) => !expanded);
                  }}
                  action={
                    <IconButton label="Open workspace" onClick={onOpenWorkspace}>
                      <IconPlus aria-hidden size={SB_ACTION} stroke={SB_ACTION_STROKE} />
                    </IconButton>
                  }
                >
                  {t("shell.projects")}
                </SectionHeader>

                <CollapsibleMotion open={projectsExpanded} preset="default">
                  <AnimatePresence initial={false}>
                    {projectWorkspaces.map((workspace) => (
                      <m.div
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                        initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                        key={workspace.id}
                        data-workspace-drop={workspace.id}
                        className={cn(
                          "rounded-md",
                          dropTarget?.dataset.workspaceDrop === workspace.id && "bg-hover",
                        )}
                        layout
                        transition={{
                          duration: reduceMotion ? 0 : LIST_MOTION.duration,
                          ease: LIST_MOTION.ease,
                        }}
                      >
                        {renderWorkspaceItem(workspace)}
                      </m.div>
                    ))}
                  </AnimatePresence>
                  {unavailableProjectSessions.length > 0
                    ? unavailableProjectSessions.map((session) => (
                        <SessionRow
                          sessionId={session.id}
                          agent={session.agentId ? agentsById.get(session.agentId) : undefined}
                          agentId={session.agentId}
                          key={session.id}
                          activity={activityBySession[session.id]}
                          isActive={activeSessionId === session.id}
                          onArchive={() => onArchiveSession(session)}
                          onDelete={() => onDeleteSession(session)}
                          onPin={(event) => {
                            event.stopPropagation();
                            onPinSession(session, !session.pinnedAt);
                          }}
                          onEditProfile={
                            session.agentId && onEditAgentProfile
                              ? () => onEditAgentProfile(session.agentId as string)
                              : undefined
                          }
                          onRename={(title) => onRenameSession?.(session.id, title)}
                          onSelect={() => onSelectSession(session)}
                          pinned={Boolean(session.pinnedAt)}
                          title={session.title}
                          updatedAt={session.updatedAt}
                        />
                      ))
                    : null}
                </CollapsibleMotion>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </SessionMovement.Provider>
  );

  // Inside the animated app sidebar: just the list (nav rows live in the rail).
  if (embedded) return list;

  return (
    <m.aside
      className="app-context-sidebar relative flex shrink-0 flex-col overflow-hidden bg-panel"
      layout={reduceMotion ? false : "size"}
      layoutDependency={open}
      style={{ transformOrigin: "left", width: open ? panelWidth : 0 }}
      transition={{ layout: SIDEBAR_TRANSITION }}
    >
      <m.div
        className="app-context-sidebar-body flex h-full flex-col bg-panel"
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
            {onNewProfile ? (
              <NavRow
                icon={<IconUserPlus size={SB_ICON} stroke={SB_STROKE} />}
                onClick={onNewProfile}
              >
                {t("shell.newProfile")}
              </NavRow>
            ) : null}
          </div>
        ) : null}

        {list}
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

function InboxChatsSection({
  workspaceId,
  sessions,
  expanded,
  activeSessionId,
  activityBySession,
  agentsById,
  onToggle,
  onExpand,
  onSelectSession,
  onPinSession,
  onRenameSession,
  onEditAgentProfile,
  onArchiveSession,
  onDeleteSession,
  onListArchivedSessions,
  onRestoreSession,
}: {
  workspaceId: string;
  sessions: AgentSessionInfo[];
  expanded: boolean;
  activeSessionId?: string | undefined;
  activityBySession: Record<string, SessionActivity>;
  agentsById: ReadonlyMap<string, AgentInfo>;
  onToggle(): void;
  onExpand(): void;
  onSelectSession(session: AgentSessionInfo): void;
  onPinSession(session: AgentSessionInfo, pinned: boolean): void;
  onRenameSession(id: string, title: string): void;
  onEditAgentProfile?: ((agentId: string) => void) | undefined;
  onArchiveSession(session: AgentSessionInfo): void;
  onDeleteSession(session: AgentSessionInfo): void;
  onListArchivedSessions(workspaceId: string): Promise<AgentSessionInfo[]>;
  onRestoreSession(session: AgentSessionInfo): void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionInfo[] | undefined>();

  const toggleArchived = (): void => {
    const nextOpen = !archivedOpen;
    setArchivedOpen(nextOpen);
    if (nextOpen) onExpand();
    if (nextOpen && !archivedSessions) {
      void onListArchivedSessions(workspaceId).then(setArchivedSessions);
    }
  };

  return (
    <>
      <SectionHeader
        expanded={expanded}
        onToggle={onToggle}
        action={
          <IconButton ariaExpanded={archivedOpen} label="Archived chats" onClick={toggleArchived}>
            <IconArchiveOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          </IconButton>
        }
      >
        Chats
      </SectionHeader>
      <CollapsibleMotion className={SB_NEST} open={expanded} preset="default">
        {sessions.map((session) => (
          <SessionRow
            sessionId={session.id}
            agent={session.agentId ? agentsById.get(session.agentId) : undefined}
            agentId={session.agentId}
            key={session.id}
            activity={activityBySession[session.id]}
            isActive={activeSessionId === session.id}
            onArchive={() => onArchiveSession(session)}
            onDelete={() => onDeleteSession(session)}
            onPin={(event) => {
              event.stopPropagation();
              onPinSession(session, !session.pinnedAt);
            }}
            onEditProfile={
              session.agentId && onEditAgentProfile
                ? () => onEditAgentProfile(session.agentId as string)
                : undefined
            }
            onRename={(title) => onRenameSession(session.id, title)}
            onSelect={() => onSelectSession(session)}
            pinned={Boolean(session.pinnedAt)}
            title={session.title}
            updatedAt={session.updatedAt}
          />
        ))}
        <CollapsibleMotion open={archivedOpen} preset="default">
          <div className={cn("mt-1 space-y-0.5", SB_NEST)}>
            {archivedSessions === undefined ? (
              archivedOpen ? (
                <div className="px-2 py-1 text-2xs text-fg-muted">Loading archived chats…</div>
              ) : null
            ) : archivedSessions.length === 0 ? (
              <div className="px-2 py-1 text-2xs text-fg-muted">No archived chats</div>
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

function WorkspaceItem({
  workspace,
  activeSessionId,
  activityBySession,
  agentsById,
  sessions,
  onSelectSession,
  onNewSession,
  onPinSession,
  onRenameSession,
  onEditAgentProfile,
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
}: {
  workspace: WorkspaceInfo;
  activeSessionId?: string | undefined;
  activityBySession: Record<string, SessionActivity>;
  agentsById: ReadonlyMap<string, AgentInfo>;
  sessions: AgentSessionInfo[];
  onSelectSession(session: AgentSessionInfo): void;
  onNewSession(): void;
  onPinSession(session: AgentSessionInfo, pinned: boolean): void;
  onRenameSession(id: string, title: string): void;
  onEditAgentProfile?: ((agentId: string) => void) | undefined;
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
      <CollapsibleMotion className={SB_NEST} open={expanded} preset="default">
        {visibleSessions.map((session) => (
          <m.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            initial={{ opacity: 0, y: 4 }}
            key={session.id}
            transition={LIST_MOTION}
          >
            <SessionRow
              sessionId={session.id}
              agent={session.agentId ? agentsById.get(session.agentId) : undefined}
              agentId={session.agentId}
              activity={activityBySession[session.id]}
              isActive={activeSessionId === session.id}
              onArchive={() => onArchiveSession(session)}
              onDelete={() => onDeleteSession(session)}
              onPin={(event) => {
                event.stopPropagation();
                onPinSession(session, !session.pinnedAt);
              }}
              onEditProfile={
                session.agentId && onEditAgentProfile
                  ? () => onEditAgentProfile(session.agentId as string)
                  : undefined
              }
              onRename={(title) => onRenameSession(session.id, title)}
              onSelect={() => onSelectSession(session)}
              pinned={Boolean(session.pinnedAt)}
              title={session.title}
              updatedAt={session.updatedAt}
            />
          </m.div>
        ))}
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
              <div className="px-2 py-1 text-2xs text-fg-muted">Loading archived chats…</div>
            ) : archivedSessions.length === 0 ? (
              <div className="px-2 py-1 text-2xs text-fg-muted">No archived chats</div>
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
  sessionId,
  title,
  agent,
  agentId,
  updatedAt,
  isActive,
  pinned,
  activity,
  onSelect,
  onPin,
  onRename,
  onEditProfile,
  onArchive,
  onDelete,
}: {
  sessionId: string;
  title: string;
  agent?: AgentInfo | undefined;
  agentId?: string | undefined;
  updatedAt: string;
  isActive: boolean;
  pinned: boolean;
  activity: SessionActivity | undefined;
  onSelect(): void;
  onPin(event: MouseEvent<HTMLButtonElement>): void;
  onRename(title: string): void;
  onEditProfile?: (() => void) | undefined;
  onArchive(): void;
  onDelete(): void;
}) {
  const movement = useContext(SessionMovement);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [displayTitle, setDisplayTitle] = useState(title);
  const [newTitle, setNewTitle] = useState(title);
  const renameCommittedRef = useRef(false);

  useEffect(() => setDisplayTitle(title), [title]);

  const startRename = (): void => {
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

  const avatar = agentId ? (agent ?? agentAvatarForId(agentId)) : undefined;
  return (
    <m.div
      data-session-id={sessionId}
      draggable={Boolean(movement) && !movement?.pending && !isRenaming}
      className={cn(
        SB_SESSION,
        "group",
        movement?.before === sessionId && "border-t border-accent",
        isActive ? "text-fg-subtle" : "text-fg-subtle hover:bg-hover hover:text-fg-muted",
        menuOpen && !isActive && "bg-hover text-fg-muted",
      )}
      layout
      transition={LIST_MOTION}
    >
      <span className={cn(SB_RAIL, "relative")}>
        {avatar && agentId ? (
          <>
            <AgentAvatar
              face={avatar.avatarFace}
              color={avatar.avatarColor}
              shape={avatar.avatarShape}
              seed={agentId}
              size={20}
              state={
                agent?.archivedAt
                  ? "archived"
                  : activity?.needsInput
                    ? "waiting"
                    : activity?.running
                      ? "working"
                      : "idle"
              }
            />
            {activity?.failed || activity?.unread ? (
              <SessionStatusDot activity={activity} className="absolute -right-0.5 -bottom-0.5" />
            ) : null}
          </>
        ) : (
          <SessionStatusDot activity={activity} />
        )}
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
          aria-current={isActive ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center pr-1 text-left"
          onClick={onSelect}
          title="Open"
          type="button"
        >
          <span className={cn("min-w-0 flex-1 truncate-fade", isActive && "text-accent")}>
            {displayTitle}
          </span>
        </button>
      )}
      <span
        className={cn(
          "sidebar-row-actions ml-0.5 shrink-0 items-center",
          menuOpen ? "flex" : "hidden group-hover:flex group-focus-within:flex",
        )}
      >
        <IconButton
          label={
            agentId ? (pinned ? "Unpin Agent" : "Pin Agent") : pinned ? "Unpin chat" : "Pin chat"
          }
          onClick={onPin}
        >
          {pinned ? (
            <IconPinnedOff size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          ) : (
            <IconPin size={SB_ACTION} stroke={SB_ACTION_STROKE} />
          )}
        </IconButton>
        <SessionActionsMenu
          lastActive={formatRelativeTime(updatedAt)}
          movement={movement}
          onArchive={onArchive}
          onDelete={onDelete}
          onEditProfile={onEditProfile}
          onOpenChange={setMenuOpen}
          onRename={startRename}
          open={menuOpen}
          sessionId={sessionId}
        />
      </span>
    </m.div>
  );
}

/**
 * The "…" menu of a chat row: everything except Pin, which stays on the row as
 * its one direct action. Delete asks for a second click inside the menu.
 */
function SessionActionsMenu({
  sessionId,
  lastActive,
  movement,
  open,
  onOpenChange,
  onRename,
  onEditProfile,
  onArchive,
  onDelete,
}: {
  sessionId: string;
  /** Compact age of the last activity, shown as the menu's caption. */
  lastActive: string;
  movement: SessionMovementValue | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRename(): void;
  onEditProfile?: (() => void) | undefined;
  onArchive(): void;
  onDelete(): void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useHoldNavRail(open);
  return (
    <Menu.Root
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setConfirmDelete(false);
      }}
      open={open}
    >
      <Menu.Trigger
        aria-label="Chat actions"
        className="flex size-6 items-center justify-center rounded-md text-fg-faint outline-none transition-colors hover:bg-active hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus-ring data-popup-open:bg-active data-popup-open:text-fg-muted"
        onClick={(event) => event.stopPropagation()}
      >
        <IconDots aria-hidden size={SB_ACTION} stroke={SB_ACTION_STROKE} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" side="bottom" sideOffset={4}>
          <Menu.Popup className="origin-(--transform-origin) min-w-[184px] popup-chrome popup-motion p-1">
            {lastActive ? (
              <div
                className="px-2.5 pt-1 pb-1.5 text-2xs text-fg-faint tabular-nums"
                data-testid="session-last-active"
              >
                {lastActive}
              </div>
            ) : null}
            <ProjectMenuItem
              icon={<IconPencil size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={onRename}
            >
              Rename
            </ProjectMenuItem>
            {onEditProfile ? (
              <ProjectMenuItem
                icon={<IconUserEdit size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
                onClick={onEditProfile}
              >
                Edit agent profile
              </ProjectMenuItem>
            ) : null}
            {movement ? (
              <>
                <ProjectMenuItem
                  disabled={movement.pending}
                  icon={<IconArrowUp size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
                  onClick={() => movement.reorder(sessionId, -1)}
                >
                  Move up
                </ProjectMenuItem>
                <ProjectMenuItem
                  disabled={movement.pending}
                  icon={<IconArrowDown size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
                  onClick={() => movement.reorder(sessionId, 1)}
                >
                  Move down
                </ProjectMenuItem>
                {movement.workspaces.map((workspace) => (
                  <ProjectMenuItem
                    disabled={movement.pending}
                    icon={<IconFolder size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
                    key={workspace.id}
                    onClick={() =>
                      void movement.move({
                        id: sessionId,
                        workspaceId: workspace.id,
                        pinned: false,
                      })
                    }
                  >
                    Move to {workspace.displayName}
                  </ProjectMenuItem>
                ))}
              </>
            ) : null}
            <ProjectMenuItem
              icon={<IconArchive size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={onArchive}
            >
              Archive
            </ProjectMenuItem>
            <ProjectMenuItem
              // Stay open on the first click so the confirm step is reachable.
              closeOnClick={confirmDelete}
              danger
              icon={<IconTrash size={SB_ACTION} stroke={SB_ACTION_STROKE} />}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                setConfirmDelete(false);
                onDelete();
              }}
            >
              {confirmDelete ? "Confirm delete" : "Delete"}
            </ProjectMenuItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function archivedTitle(session: AgentSessionInfo): string {
  const age = formatRelativeTime(session.archivedAt ?? session.updatedAt);
  return age ? `Open archived chat · ${age}` : "Open archived chat";
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
        title={archivedTitle(session)}
        type="button"
      >
        {session.title}
      </button>
      <span className="sidebar-row-actions hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
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
  useHoldNavRail(open);
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
              {confirmRemove ? `Remove project with ${groupNames.join(", ")}?` : "Remove"}
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
  disabled = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick(): void;
  danger?: boolean;
  closeOnClick?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-hover data-disabled:opacity-50",
        danger ? "text-danger" : "text-fg",
      )}
      closeOnClick={closeOnClick}
      disabled={disabled}
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
  ariaExpanded,
}: {
  children: ReactNode;
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  ariaExpanded?: boolean;
}) {
  return (
    <m.button
      aria-label={label}
      aria-expanded={ariaExpanded}
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
  action,
}: {
  children: ReactNode;
  expanded: boolean;
  onToggle(): void;
  action?: ReactNode;
}) {
  return (
    <div className="group mt-3 mb-0.5 flex h-6 items-center px-2 text-2xs font-normal text-fg-muted">
      <button
        aria-expanded={expanded}
        className="flex items-center gap-1 transition-colors hover:text-fg"
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
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

/** Compact session age in the app language ("5m" / "5 min"). */
function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return formatUiCompactAge(Date.now() - timestamp);
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
