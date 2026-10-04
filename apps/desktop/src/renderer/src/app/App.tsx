import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import {
  IconBrandVisualStudio,
  IconCheck,
  IconChevronDown,
  IconCircles,
  IconDeviceLaptop,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconListDetails,
  IconSettings,
  IconSourceCode,
  IconVersions,
} from "@tabler/icons-react";
import { AnimatePresence, domMax, LazyMotion, m, useReducedMotion } from "motion/react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SecurityState } from "../../../preload/types";
import type {
  AgentEvent,
  AgentGroupWithMembers,
  AgentInfo,
  AgentMode,
  AgentSessionInfo,
  BrowserEvent,
  ContextItem,
  ContextUsageInfo,
  CreateAgentGroupInput,
  FileDiff,
  ModelInfo,
  ModelSettingsState,
  PlanRef,
  PromptDelivery,
  PromptImageAttachment,
  SkillSelection,
  UpdateRestoreUiState,
  WorkspaceInfo,
} from "../../../shared/contracts";
import { SIDEBAR_MIN_WIDTH, SIDEBAR_TRANSITION, Sidebar } from "../components/Sidebar";
import { APP_RAIL_WIDTH, AppRail, type PrimaryDestination } from "../components/shell/AppRail";
import { AppShell } from "../components/shell/AppShell";
import { ContextSidebar } from "../components/shell/ContextSidebar";
import { MainSurface } from "../components/shell/MainSurface";
import {
  closeSettingsNavigation,
  INITIAL_PRIMARY_NAVIGATION,
  navigatePrimary,
  restorePrimaryNavigation,
} from "../components/shell/navigation-state";
import { TopBar } from "../components/shell/TopBar";
import { ImageViewerProvider } from "../components/ui/ImageViewer";
import { ModusLoadingFallback } from "../components/ui/ModusLoadingMark";
import { NativeSurfaceProvider } from "../components/ui/nativeSurface";
import { TOOLBAR_ICON, ToolbarButton } from "../components/ui/ToolbarButton";
import { TooltipProvider } from "../components/ui/Tooltip";
import {
  AgentEventHub,
  type AgentEventItem,
  affectsActivity,
  optimisticUserPromptEvents,
  reduceActivity,
  type SessionActivity,
} from "../features/agent/agentEventHub";
import type { ChatComposerDraft, ChatComposerDraftUpdate } from "../features/agent/ChatPane";
import { addContextItemToDraft } from "../features/agent/ChatPane";
import { SessionTitlePopover } from "../features/agent/SessionTitlePopover";
import { AgentDialog } from "../features/agents/AgentDialog";
import {
  Composer,
  type ComposerDraft,
  createEmptyComposerDraft,
} from "../features/composer/Composer";
import { contextItemKey } from "../features/composer/composerTokens";
import { BranchSwitcher } from "../features/git/BranchSwitcher";
import type { GroupMembersChange } from "../features/groups/CreateGroupDialog";
import { BlockedBanner, GroupRoom } from "../features/groups/GroupRoom";
import { describeGroupError } from "../features/groups/groupErrors";
import { agentChatBlocked } from "../features/groups/groupSidebarModel";
import type { NewGroupServices } from "../features/groups/NewGroupModal";
import {
  groupActivityState,
  isGroupRunning,
  useGroupMemberStates,
} from "../features/groups/useWorkingGroups";
import { INSPECTOR_MIN_WIDTH } from "../features/inspector/inspector-layout";
import { normalizePlan } from "../features/plan/planState";
import type { SettingsSectionId } from "../features/settings/settings-types";
import {
  createUiStatePusher,
  isComposerDraftEmpty,
  isNavigationUntouched,
  mergeRestoredDrafts,
  planUiRestore,
  snapshotUiState,
  type UiStatePusher,
} from "../features/update/restoreUiState";
import { UpdateToast } from "../features/update/UpdateToast";
import { cn } from "../lib/cn";
import { useGitBranch } from "../lib/useGitBranch";
import { beginInitialAppHydration, type InitialAppHydration } from "./initial-hydration";
import { reportRendererStartup } from "./startup-report";

/**
 * Floor the main column keeps no matter how wide the side panels get. The
 * sidebar/inspector resize (and any programmatic width change) is clamped so
 * this is always reserved — the chat can't be crushed to an unreadable sliver.
 */
const MAIN_MIN_WIDTH = 480;
const WORKSPACE_GUTTER = 8;
const loadChatPane = () => import("../features/agent/ChatPane");
const loadInspector = () => import("../features/inspector/Inspector");
const loadSettingsPanel = () => import("../features/settings/SettingsPanel");
const ChatPane = lazy(() =>
  loadChatPane().then(({ ChatPane: Component }) => ({ default: Component })),
);
const Inspector = lazy(() =>
  loadInspector().then(({ Inspector: Component }) => ({
    default: Component,
  })),
);
const SettingsPanel = lazy(() =>
  loadSettingsPanel().then(({ SettingsPanel: Component }) => ({
    default: Component,
  })),
);
function logInitialHydrationError(resource: string, error: unknown): void {
  console.error(`Unable to load initial ${resource}.`, error);
}

export function App() {
  const reduceMotion = useReducedMotion();
  const windowChrome = window.modus?.app.windowChrome ?? "system";
  const [nativeGlass, setNativeGlass] = useState(
    () => window.modus?.app.isNativeGlassAvailable?.() ?? window.modus?.app.nativeGlass === true,
  );
  const [securityState, setSecurityState] = useState<SecurityState | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionInfo[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroupWithMembers[]>([]);
  const groupMemberStates = useGroupMemberStates();
  useEffect(() => {
    const applyNativeGlass = (available: boolean): void => {
      setNativeGlass(available);
      document.documentElement.dataset.nativeGlass = String(available);
    };
    applyNativeGlass(
      window.modus?.app.isNativeGlassAvailable?.() ?? window.modus?.app.nativeGlass === true,
    );
    return window.modus?.app.onNativeGlassChange(applyNativeGlass);
  }, []);
  const isGroupWorking = useCallback(
    (group: AgentGroupWithMembers) => isGroupRunning(groupMemberStates, group.id),
    [groupMemberStates],
  );
  const isGroupWaiting = useCallback(
    (group: AgentGroupWithMembers) => groupActivityState(groupMemberStates, group.id) === "waiting",
    [groupMemberStates],
  );
  /** The group whose room fills the main panel (instead of a chat). */
  const [activeGroupId, setActiveGroupId] = useState<string | undefined>();
  const [groupChromeHost, setGroupChromeHost] = useState<HTMLElement | null>(null);
  const activeGroup = activeGroupId
    ? agentGroups.find((group) => group.id === activeGroupId)
    : undefined;
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  /** The agent dialog (A3): create in a group, or edit an agent. */
  const [agentDialog, setAgentDialog] = useState<{ groupId: string; agent?: AgentInfo } | null>(
    null,
  );
  const [initialEventsBySession, setInitialEventsBySession] = useState<
    Record<string, AgentEventItem[]>
  >({});
  const [activityBySession, setActivityBySession] = useState<Record<string, SessionActivity>>({});
  const [contextUsageBySession, setContextUsageBySession] = useState<
    Record<string, ContextUsageInfo>
  >({});
  const [composerDraftBySession, setComposerDraftBySession] = useState<
    Record<string, ChatComposerDraft>
  >({});
  const [heroContextItems, setHeroContextItems] = useState<ContextItem[]>([]);
  // Composer mode for the hero (new-chat) screen — controlled so the "Plan New
  // Idea" pill can start a session straight in plan mode.
  const [heroMode, setHeroMode] = useState<AgentMode>("build");
  // Lifted only so the text survives an update restart (see restoreUiState).
  const [heroDraft, setHeroDraft] = useState<ComposerDraft>(createEmptyComposerDraft);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [modelSettings, setModelSettings] = useState<ModelSettingsState | null>(null);
  const [primaryNavigation, setPrimaryNavigation] = useState(INITIAL_PRIMARY_NAVIGATION);
  const primaryNavigationTouchedRef = useRef(false);
  const settingsOpen = primaryNavigation.active === "settings";
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSectionId>("model-provider");
  const navigateToPrimary = useCallback((destination: PrimaryDestination) => {
    primaryNavigationTouchedRef.current = true;
    setPrimaryNavigation((current) => navigatePrimary(current, destination));
  }, []);
  const openSettings = useCallback(
    (section: SettingsSectionId = "model-provider") => {
      setSettingsInitialSection(section);
      navigateToPrimary("settings");
    },
    [navigateToPrimary],
  );
  const closeSettings = useCallback(() => {
    primaryNavigationTouchedRef.current = true;
    setPrimaryNavigation((current) => closeSettingsNavigation(current));
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(384);
  const [inspectorTab, setInspectorTab] = useState("changes");
  const [filesRevealPath, setFilesRevealPath] = useState<string | undefined>();
  const [filesRevealLine, setFilesRevealLine] = useState<
    { line: number; key: number } | undefined
  >();
  const filesRevealKeyRef = useRef(0);
  const [terminalRevealId, setTerminalRevealId] = useState<string | undefined>();
  const [reviewCwd, setReviewCwd] = useState<string | undefined>();
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>();
  // Plans are scoped per session (the authoritative key), so switching sessions
  // shows that session's own plan — never the last one any session emitted.
  const [activePlanBySession, setActivePlanBySession] = useState<Record<string, PlanRef>>({});
  const [environmentStats, setEnvironmentStats] = useState({ added: 0, removed: 0 });
  const [sessionCreateError, setSessionCreateError] = useState<string | undefined>();
  const [layoutWidth, setLayoutWidth] = useState(0);

  const hubRef = useRef(new AgentEventHub());
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeWorkspaceRef = useRef<WorkspaceInfo | null>(null);
  const workspaceSelectionRevisionRef = useRef(0);
  const reviewScopeRef = useRef<{
    sessionId: string | undefined;
    workspaceId: string | undefined;
  }>({ sessionId: undefined, workspaceId: undefined });
  const layoutRowRef = useRef<HTMLDivElement>(null);
  const initialHydrationRef = useRef<InitialAppHydration | null>(null);
  const restoredUiStateRef = useRef<Promise<UpdateRestoreUiState | null> | null>(null);
  const uiStatePusherRef = useRef<UiStatePusher | null>(null);
  const heroComposerRef = useRef({ draft: heroDraft, contextItems: heroContextItems });

  // Track the panel row's live width so side-panel widths can be clamped to keep
  // the main column at least MAIN_MIN_WIDTH (responsive to window + panel state).
  useEffect(() => {
    const row = layoutRowRef.current;
    if (!row) {
      return;
    }
    setLayoutWidth(row.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) {
        setLayoutWidth(width);
      }
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Opening any chat (sidebar, member chip, new session) closes the group room.
  useEffect(() => {
    if (activeSessionId) setActiveGroupId(undefined);
  }, [activeSessionId]);

  // The open group was deleted (here or elsewhere): back to the hero.
  useEffect(() => {
    if (activeGroupId && !agentGroups.some((group) => group.id === activeGroupId)) {
      setActiveGroupId(undefined);
    }
  }, [activeGroupId, agentGroups]);

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace;
  }, [activeWorkspace]);

  useEffect(() => {
    heroComposerRef.current = { draft: heroDraft, contextItems: heroContextItems };
  }, [heroDraft, heroContextItems]);

  const requestedWorkspaceId =
    activeWorkspace && !activeWorkspace.inbox ? activeWorkspace.id : undefined;

  useEffect(() => {
    if (!window.modus) return;
    const revision = ++workspaceSelectionRevisionRef.current;
    const workspaceId = requestedWorkspaceId;
    void window.modus.workspace
      .select(workspaceId ? { workspaceId } : {})
      .catch((error: unknown) => {
        if (revision === workspaceSelectionRevisionRef.current) {
          console.error("Unable to synchronize the current workspace selection.", error);
        }
      });
  }, [requestedWorkspaceId]);

  // When the agent starts driving the browser (an agent-initiated navigation),
  // auto-reveal the browser panel for the active workspace if it isn't already
  // showing. Idempotent — no-op when the panel is open on the browser tab; only
  // user/agent address-bar navigations without the agent flag are ignored.
  useEffect(() => {
    if (!window.modus) {
      return;
    }
    return window.modus.browser.onEvent((event: BrowserEvent) => {
      if (
        event.type === "browser.agent-activity" &&
        event.workspaceId === activeWorkspaceRef.current?.id
      ) {
        setInspectorTab("browser");
        setInspectorOpen(true);
      }
    });
  }, []);

  const refreshGroups = useCallback(async (): Promise<void> => {
    try {
      setAgentGroups(await window.modus.group.list());
    } catch (error) {
      console.warn("[groups] failed to load agent groups", error);
    }
  }, []);

  const refreshSessions = useCallback(async (): Promise<void> => {
    // Groups ride along: deleting chats/projects cascades to memberships.
    const groupsRefresh = refreshGroups();
    setAgentSessions(
      await window.modus.agent.list({ includeSessionId: activeSessionIdRef.current }),
    );
    await groupsRefresh;
  }, [refreshGroups]);

  useEffect(() => {
    if (window.modus) void refreshGroups();
  }, [refreshGroups]);

  function publishLocalAgentEvent(event: AgentEvent): void {
    hubRef.current.publish({
      id: `local:${Date.now()}:${crypto.randomUUID()}`,
      event,
      createdAt: new Date().toISOString(),
    });
  }

  const applyModelSettings = useCallback((settings: ModelSettingsState): void => {
    setModelSettings(settings);
    setModels(settings.models);
    setModel((current) => {
      if (current && settings.models.some((item: ModelInfo) => item.id === current)) {
        return current;
      }
      return settings.defaultModel ?? settings.models[0]?.id ?? "";
    });
  }, []);

  const refreshModelSettings = useCallback(async (): Promise<void> => {
    const settings = await window.modus.model.settings();
    applyModelSettings(settings);
  }, [applyModelSettings]);

  const refreshModelCatalog = useCallback(async (): Promise<void> => {
    applyModelSettings(await window.modus.model.refreshCatalog());
  }, [applyModelSettings]);

  useEffect(() => {
    const idleCallback = window.requestIdleCallback(() => {
      void Promise.allSettled([loadChatPane(), loadInspector(), loadSettingsPanel()]);
    });
    return () => window.cancelIdleCallback(idleCallback);
  }, []);

  useEffect(() => {
    if (!window.modus) {
      return;
    }

    let active = true;
    let hydration = initialHydrationRef.current;
    if (!hydration) {
      hydration = beginInitialAppHydration(window.modus);
      initialHydrationRef.current = hydration;
    }

    void hydration.securityState
      .then((state) => {
        if (active) {
          setSecurityState(state);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          logInitialHydrationError("security state", error);
        }
      });
    void hydration.workspaces
      .then((items) => {
        if (active) {
          setWorkspaces(items);
          setActiveWorkspace(items[0] ?? null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          logInitialHydrationError("workspaces", error);
        }
      });
    void hydration.sessions
      .then((sessions) => {
        if (active) {
          setAgentSessions(sessions);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          logInitialHydrationError("agent sessions", error);
        }
      });
    void hydration.modelSettings
      .then((settings) => {
        if (active) {
          applyModelSettings(settings);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          logInitialHydrationError("model settings", error);
        }
      });
    // UI state saved by the previous version across an update restart (taken once by
    // main). Applied after the lists load so every id can be checked against them; each
    // part (navigation, drafts, hero, layout) stands on its own.
    let restored = restoredUiStateRef.current;
    if (!restored) {
      restored = window.modus.update.takeRestoredUiState().catch(() => null);
      restoredUiStateRef.current = restored;
    }
    void Promise.all([restored, hydration.workspaces, hydration.sessions])
      .then(([snapshot, items, sessions]) => {
        if (!active || !snapshot) return;
        const plan = planUiRestore(snapshot, {
          workspaceIds: new Set(items.map((item) => item.id)),
          sessionIds: new Set(sessions.map((session) => session.id)),
        });
        const { navigation, hero, layout } = plan;
        // Never undo what the user already did since startup.
        const navigationUntouched = isNavigationUntouched(
          {
            workspaceId: activeWorkspaceRef.current?.id,
            sessionId: activeSessionIdRef.current,
          },
          items[0]?.id,
        );
        if (navigation && navigationUntouched) {
          setActiveWorkspace(
            items.find((item) => item.id === navigation.activeWorkspaceId) ?? null,
          );
          setActiveSessionId(navigation.activeSessionId ?? undefined);
        }
        const heroComposer = heroComposerRef.current;
        if (
          hero &&
          isComposerDraftEmpty({ ...heroComposer.draft, contextItems: heroComposer.contextItems })
        ) {
          setHeroDraft({ ...createEmptyComposerDraft(), value: hero.text });
          setHeroMode(hero.mode);
        }
        setComposerDraftBySession((current) =>
          mergeRestoredDrafts(current, plan.drafts, (draft) => ({
            ...createEmptyComposerDraft(),
            value: draft.text,
            contextItems: [],
            mode: draft.mode,
          })),
        );
        setSidebarOpen(layout.sidebar.open);
        setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, layout.sidebar.width));
        setInspectorOpen(layout.inspector.open);
        setInspectorWidth(Math.max(INSPECTOR_MIN_WIDTH, layout.inspector.width));
        setInspectorTab(layout.inspector.tab);
        if (!primaryNavigationTouchedRef.current) {
          setPrimaryNavigation((current) =>
            restorePrimaryNavigation(current, {
              settingsOpen: layout.settingsOpen,
              activeSessionId: navigation?.activeSessionId,
            }),
          );
        }
      })
      .catch(() => undefined);
    void hydration.settled.then(() => {
      if (active) {
        reportRendererStartup("renderer.initial-hydration-settled");
      }
    });

    return () => {
      active = false;
    };
  }, [applyModelSettings]);

  useEffect(
    () => window.modus?.model.onCatalogChanged(() => void refreshModelSettings()),
    [refreshModelSettings],
  );

  // While a downloaded update is pending, main keeps the latest UI state and writes it
  // on quit; the pusher sends nothing otherwise.
  useEffect(() => {
    if (!window.modus) return;
    const pusher = createUiStatePusher(window.modus.update);
    uiStatePusherRef.current = pusher;
    return () => {
      pusher.dispose();
      uiStatePusherRef.current = null;
    };
  }, []);

  useEffect(() => {
    uiStatePusherRef.current?.update(
      snapshotUiState({
        activeWorkspaceId: activeWorkspace?.id,
        activeSessionId,
        composerDraftBySession,
        heroDraft,
        heroMode,
        sessionIds: new Set(agentSessions.map((session) => session.id)),
        sidebar: { open: sidebarOpen, width: sidebarWidth },
        inspector: { open: inspectorOpen, width: inspectorWidth, tab: inspectorTab },
        settingsOpen,
      }),
    );
  }, [
    activeWorkspace?.id,
    activeSessionId,
    composerDraftBySession,
    heroDraft,
    heroMode,
    agentSessions,
    sidebarOpen,
    sidebarWidth,
    inspectorOpen,
    inspectorWidth,
    inspectorTab,
    settingsOpen,
  ]);

  /* ── Global event intake: one IPC listener feeds the active chat + sidebar ── */
  useEffect(() => {
    if (!window.modus) {
      return;
    }

    const unsubscribe = window.modus.agent.onEvent((event: AgentEvent) => {
      if (event.type === "context.updated") {
        setContextUsageBySession((current) => ({
          ...current,
          [event.sessionId]: event.usage,
        }));
        return;
      }

      hubRef.current.publish({
        id: `${Date.now()}:${crypto.randomUUID()}`,
        event,
        createdAt: new Date().toISOString(),
      });

      if (affectsActivity(event)) {
        const watched = activeSessionIdRef.current === event.sessionId;
        setActivityBySession((current) => {
          const next = reduceActivity(current[event.sessionId], event, watched);
          if (next === current[event.sessionId]) {
            return current;
          }
          return { ...current, [event.sessionId]: next };
        });
      }

      if (
        event.type === "agent.started" ||
        event.type === "agent.ended" ||
        event.type === "message.completed" ||
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled" ||
        event.type === "run.blocked" ||
        event.type === "session.updated" ||
        event.type === "subagent.started" ||
        // Activity-only subagent.updated (writing/thinking/tool) must NOT list
        // sessions — that re-rendered the whole app on every child token.
        (event.type === "subagent.updated" &&
          (event.status === "completed" ||
            event.status === "failed" ||
            event.status === "cancelled" ||
            event.status === "blocked"))
      ) {
        void refreshSessions();
      }
    });

    // System notification click → surface that session in the chat view.
    const unsubscribeFocus = window.modus.agent.onFocusSession((sessionId: string) => {
      setActiveSessionId(sessionId);
      navigateToPrimary("direct-messages");
    });

    return () => {
      unsubscribe();
      unsubscribeFocus();
    };
  }, [navigateToPrimary, refreshSessions]);

  // Opening a session unmounts the hero composer: its text is dropped, as it was
  // before the draft was lifted into App.
  useEffect(() => {
    if (activeSessionId) {
      setHeroDraft((current) =>
        isComposerDraftEmpty(current) ? current : createEmptyComposerDraft(),
      );
    }
  }, [activeSessionId]);

  // The open session is "watched": its unread flag clears.
  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    setActivityBySession((current) => {
      const activity = current[activeSessionId];
      if (!activity?.unread) {
        return current;
      }
      return { ...current, [activeSessionId]: { ...activity, unread: false } };
    });
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    if (!agentSessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(undefined);
    }
  }, [activeSessionId, agentSessions]);

  const activeSession = useMemo(
    () => agentSessions.find((session) => session.id === activeSessionId),
    [activeSessionId, agentSessions],
  );
  const rootSessions = useMemo(
    () => agentSessions.filter((session) => !session.parentSessionId && !session.archivedAt),
    [agentSessions],
  );

  /* ── Session lifecycle ───────────────────────────────────────────────── */

  async function openWorkspace(): Promise<void> {
    const workspace = await window.modus.workspace.open();
    if (!workspace) {
      return;
    }
    setActiveWorkspace(workspace);
    setWorkspaces(await window.modus.workspace.list());
    await refreshSessions();
  }

  async function createSession(workspace: WorkspaceInfo | null): Promise<AgentSessionInfo | null> {
    if (!model) {
      openSettings();
      setSessionCreateError("No model is configured. Connect a provider in Settings first.");
      return null;
    }
    try {
      const target =
        workspace && !workspace.inbox ? workspace : await window.modus.workspace.ensureChats();
      const session = await window.modus.agent.create({
        workspaceId: target.id,
        cwd: target.rootPath,
        ...(model ? { model } : {}),
        title: "New chat",
      });
      hubRef.current.prepare(session.id);
      setSessionCreateError(undefined);
      // Keep project selection cleared for inbox chats so they stay under Chats.
      setActiveWorkspace(target.inbox ? null : target);
      setAgentSessions((current) => {
        const exists = current.some((item) => item.id === session.id);
        return exists
          ? current.map((item) => (item.id === session.id ? session : item))
          : [session, ...current];
      });
      setActiveSessionId(session.id);
      navigateToPrimary("direct-messages");
      void refreshSessions();
      return session;
    } catch (error) {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  function selectSession(session: AgentSessionInfo): void {
    setSessionCreateError(undefined);
    navigateToPrimary("direct-messages");
    // Direct messages without a project keep the project context clear.
    const project = workspaces.find((workspace) => workspace.id === session.workspaceId);
    setActiveWorkspace(project && !project.inbox ? project : null);
    setAgentSessions((current) => {
      const exists = current.some((item) => item.id === session.id);
      return exists
        ? current.map((item) => (item.id === session.id ? session : item))
        : [session, ...current];
    });
    setActiveSessionId(session.id);
  }

  function openSubagent(childSessionId: string): void {
    setSelectedSubagentId(childSessionId);
    setInspectorTab("subagents");
    setInspectorOpen(true);
  }

  function openReview(cwd?: string): void {
    setReviewCwd(cwd);
    setInspectorTab("changes");
    setInspectorOpen(true);
  }

  const openActivity = useCallback(() => {
    setInspectorTab("activity");
    setInspectorOpen(true);
  }, []);

  const openConnections = useCallback(() => {
    openSettings("mcp");
  }, [openSettings]);

  const rememberActivePlan = useCallback(
    (plan: PlanRef) => {
      const normalized = normalizePlan(plan);
      const key = normalized.sessionId ?? activeSessionId ?? normalized.id;
      setActivePlanBySession((current) =>
        current[key] === normalized ? current : { ...current, [key]: normalized },
      );
    },
    [activeSessionId],
  );

  const openPlan = useCallback(
    (plan: PlanRef) => {
      rememberActivePlan(plan);
      setInspectorTab("plan");
      setInspectorOpen(true);
    },
    [rememberActivePlan],
  );

  /**
   * Open the new-chat hero (Figure 1). The session row is created lazily by the
   * first prompt (`submitHeroPrompt`), so "New chat" never spawns an empty
   * session — it just returns to the hero, optionally switching workspace first.
   */
  function selectGroup(group: AgentGroupWithMembers): void {
    setSessionCreateError(undefined);
    navigateToPrimary("groups");
    setActiveSessionId(undefined);
    setActiveGroupId(group.id);
  }

  function openNewChat(workspace?: WorkspaceInfo | null): void {
    setActiveGroupId(undefined);
    if (workspace !== undefined) {
      setActiveWorkspace(workspace);
    }
    setSessionCreateError(undefined);
    navigateToPrimary("direct-messages");
    setActiveSessionId(undefined);
  }

  async function pinSession(session: AgentSessionInfo, pinned: boolean): Promise<void> {
    try {
      const updated = await window.modus.agent.pin({ id: session.id, pinned });
      if (updated) {
        setAgentSessions((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      }
    } catch (error) {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
      return;
    }
    await refreshSessions();
  }

  async function renameSession(sessionId: string, title: string): Promise<void> {
    try {
      const updated = await window.modus.agent.rename({ id: sessionId, title });
      if (updated) {
        setAgentSessions((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      }
    } catch (error) {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
    }
  }

  async function archiveSession(session: AgentSessionInfo): Promise<void> {
    try {
      await window.modus.agent.archive(session.id);
    } catch (error) {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
      return;
    }
    await refreshSessions();
  }

  async function restoreSession(session: AgentSessionInfo): Promise<void> {
    try {
      await window.modus.agent.restore(session.id);
    } catch (error) {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
      return;
    }
    await refreshSessions();
  }

  async function deleteSession(session: AgentSessionInfo): Promise<void> {
    try {
      await window.modus.agent.delete(session.id);
    } catch (error) {
      setSessionCreateError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (activeSessionIdRef.current === session.id) {
      setActiveSessionId(undefined);
    }
    await refreshSessions();
  }

  /* ── Project (workspace) actions — sidebar "..." menu ──────────────────── */

  async function pinProject(id: string, pinned: boolean): Promise<void> {
    setWorkspaces(await window.modus.workspace.pin({ id, pinned }));
  }

  async function renameProject(id: string, displayName: string): Promise<void> {
    setWorkspaces(await window.modus.workspace.rename({ id, displayName }));
    setActiveWorkspace((current) =>
      current && current.id === id ? { ...current, displayName } : current,
    );
  }

  async function archiveProjectChats(id: string): Promise<void> {
    await window.modus.workspace.archiveChats(id);
    await refreshSessions();
  }

  async function deleteProjectChats(id: string): Promise<void> {
    await window.modus.workspace.deleteChats(id);
    if (activeWorkspaceRef.current?.id === id) {
      setActiveSessionId(undefined);
    }
    await refreshSessions();
  }

  async function removeProject(id: string): Promise<void> {
    const next = await window.modus.workspace.remove(id);
    setWorkspaces(next);
    if (activeWorkspaceRef.current?.id === id) {
      setActiveWorkspace(next[0] ?? null);
      setActiveSessionId(undefined);
    }
    await refreshSessions();
  }

  /* ── Agent Groups — sidebar Groups section ─────────────────────────────── */

  async function createGroup(input: CreateAgentGroupInput): Promise<void> {
    // Errors propagate so the dialog can show them and stay open.
    await window.modus.group.create(input);
    await refreshGroups();
  }

  /** The create-group modal (A4): existing IPC only (no new channel). */
  const newGroupServices: NewGroupServices = {
    listAgents: () => window.modus.agents.list(),
    addFolder: async () => {
      // The same "Add folder…" flow as the sidebar: pick a folder, it becomes a Project.
      const workspace = await window.modus.workspace.open();
      if (workspace) setWorkspaces(await window.modus.workspace.list());
      return workspace;
    },
    generateProfile: (input) => window.modus.agents.generateProfile(input),
  };

  async function updateGroupMembers(groupId: string, change: GroupMembersChange): Promise<void> {
    // ONE all-or-nothing call (adds, removes and lead in one transaction); errors
    // propagate so the "Manage members" dialog can show them and stay open.
    setAgentGroups(await window.modus.group.updateMembers({ groupId, ...change }));
  }

  /** An agent in the sidebar: open its 1:1 chat (created on first open, in the group's Project). */
  async function openAgentChat(agentId: string): Promise<void> {
    try {
      const session = await window.modus.agents.openChat(agentId);
      selectSession(session);
    } catch (error) {
      setSessionCreateError(describeGroupError(error));
    }
  }

  async function editAgent(agentId: string): Promise<void> {
    try {
      const agent = (await window.modus.agents.list()).find(
        (item: AgentInfo) => item.id === agentId,
      );
      if (agent?.groupId) setAgentDialog({ groupId: agent.groupId, agent });
    } catch (error) {
      setSessionCreateError(describeGroupError(error));
    }
  }

  /** "Choose folder" on a group without a Project: pick a folder, then move the group there. */
  async function chooseGroupFolder(groupId: string): Promise<void> {
    const workspace = await window.modus.workspace.open();
    if (!workspace) return;
    setWorkspaces(await window.modus.workspace.list());
    await runGroupAction(() =>
      window.modus.group.setWorkspace({ groupId, workspaceId: workspace.id }),
    );
  }

  /** A 1:1 chat of a blocked group opens read-only, with the room's banner (A3). */
  const activeChatBlocked = agentChatBlocked(activeSession, agentGroups);

  const agentDialogGroup = agentDialog
    ? agentGroups.find((group) => group.id === agentDialog.groupId)
    : undefined;

  const groupModels = useMemo(
    () =>
      models
        .filter((item) => item.available && item.enabled)
        .map((item) => ({ id: item.id, name: item.name })),
    [models],
  );

  async function runGroupAction(action: () => Promise<AgentGroupWithMembers[]>): Promise<void> {
    try {
      setAgentGroups(await action());
    } catch (error) {
      setSessionCreateError(describeGroupError(error));
      await refreshGroups();
    }
  }

  async function revealProject(id: string): Promise<void> {
    await window.modus.workspace.reveal(id).catch(() => {});
  }

  /** Hero composer: create the session, open its pane, fire the first prompt. */
  async function submitHeroPrompt(
    message: string,
    context: ContextItem[],
    _delivery?: PromptDelivery,
    attachments?: PromptImageAttachment[],
    skills?: SkillSelection[],
    mode?: AgentMode,
  ): Promise<void> {
    if (!message.trim()) {
      return;
    }
    const session = await createSession(activeWorkspace);
    if (!session) {
      return;
    }
    const userMessageId = `local-user:${crypto.randomUUID()}`;
    setInitialEventsBySession((current) => ({
      ...current,
      [session.id]: optimisticUserPromptEvents({
        sessionId: session.id,
        userMessageId,
        message,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(skills && skills.length > 0 ? { skills } : {}),
      }),
    }));
    setHeroContextItems([]);
    void window.modus.agent
      .prompt({
        context,
        delivery: "normal",
        sessionId: session.id,
        message,
        userMessageId,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(skills && skills.length > 0 ? { skills } : {}),
        ...(mode ? { mode } : {}),
      })
      .then(() => refreshSessions())
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setSessionCreateError(errorMessage);
        publishLocalAgentEvent({
          type: "runtime.error",
          sessionId: session.id,
          message: errorMessage,
        });
        publishLocalAgentEvent({
          type: "session.status",
          sessionId: session.id,
          status: { type: "idle" },
        });
      })
      .finally(() => hubRef.current.cancelPrepare(session.id));
  }

  async function updateModelThinking(modelId: string, thinkingVariant: string): Promise<void> {
    await window.modus.model.updateConfig({ model: modelId, thinkingVariant });
    await window.modus.model.setDefault(modelId);
    await refreshModelSettings();
    setModel(modelId);
  }

  const cycleModel = useCallback(
    async (direction: "forward" | "backward"): Promise<void> => {
      const next = await window.modus.agent.cycleModel({
        direction,
        sessionId: activeSession?.id,
      });
      setModel(next.id);
      void refreshSessions();
    },
    [activeSession?.id, refreshSessions],
  );

  useEffect(() => {
    function handleModelCycle(event: globalThis.KeyboardEvent): void {
      if (event.ctrlKey && event.key === "/") {
        event.preventDefault();
        void cycleModel(event.shiftKey ? "backward" : "forward");
      }
    }

    window.addEventListener("keydown", handleModelCycle);
    return () => window.removeEventListener("keydown", handleModelCycle);
  }, [cycleModel]);

  const hasSession = Boolean(activeSession);
  const visibleSession = primaryNavigation.active === "direct-messages" ? activeSession : undefined;
  const visibleGroup = primaryNavigation.active === "groups" ? activeGroup : undefined;
  const visibleGroupWorkspace = visibleGroup
    ? workspaces.find((workspace) => workspace.id === visibleGroup.workspaceId)
    : undefined;
  const activeCwd =
    visibleSession?.cwd ??
    visibleGroupWorkspace?.rootPath ??
    (primaryNavigation.active === "direct-messages" ? activeWorkspace?.rootPath : undefined);
  const branch = useGitBranch(activeCwd);
  const isMac = window.modus?.app.platform === "darwin";
  const activeRunning = activeSession
    ? (activityBySession[activeSession.id]?.running ?? false)
    : false;

  useEffect(() => {
    const next = { sessionId: activeSessionId, workspaceId: activeWorkspace?.id };
    if (
      reviewScopeRef.current.sessionId !== next.sessionId ||
      reviewScopeRef.current.workspaceId !== next.workspaceId
    ) {
      reviewScopeRef.current = next;
      setReviewCwd(undefined);
    }
  }, [activeSessionId, activeWorkspace?.id]);

  // Each panel may grow only until the OTHER panel + main's reserved floor are
  // accounted for. Until the row is measured, allow the panels' own caps.
  const sidebarSpace = sidebarOpen ? sidebarWidth : 0;
  const showInspectorForRoute = primaryNavigation.active === "direct-messages" && hasSession;
  const inspectorSpace = showInspectorForRoute && inspectorOpen ? inspectorWidth : 0;
  const workspaceChrome = WORKSPACE_GUTTER * (inspectorSpace > 0 ? 4 : 3);
  const mainSpace = MAIN_MIN_WIDTH + workspaceChrome;
  const inspectorFits =
    layoutWidth === 0 || layoutWidth >= APP_RAIL_WIDTH + sidebarSpace + inspectorWidth + mainSpace;
  const sidebarFits =
    layoutWidth === 0 ||
    layoutWidth >= APP_RAIL_WIDTH + sidebarWidth + MAIN_MIN_WIDTH + WORKSPACE_GUTTER * 3;
  const responsiveInspectorOpen = showInspectorForRoute && inspectorOpen && inspectorFits;
  const responsiveSidebarOpen = sidebarOpen && sidebarFits;
  const sidebarMaxWidth =
    layoutWidth > 0
      ? Math.max(SIDEBAR_MIN_WIDTH, layoutWidth - APP_RAIL_WIDTH - inspectorSpace - mainSpace)
      : Number.POSITIVE_INFINITY;
  const inspectorMaxWidth =
    layoutWidth > 0
      ? Math.max(INSPECTOR_MIN_WIDTH, layoutWidth - APP_RAIL_WIDTH - sidebarSpace - mainSpace)
      : Number.POSITIVE_INFINITY;

  // When the window (or the other panel) shrinks, pull an over-wide panel back
  // in so the main column never drops below its floor.
  useEffect(() => {
    if (sidebarWidth > sidebarMaxWidth) {
      setSidebarWidth(sidebarMaxWidth);
    }
  }, [sidebarWidth, sidebarMaxWidth]);
  useEffect(() => {
    if (inspectorWidth > inspectorMaxWidth) {
      setInspectorWidth(inspectorMaxWidth);
    }
  }, [inspectorWidth, inspectorMaxWidth]);

  useEffect(() => {
    // activeRunning gates nothing but re-runs the poll whenever the active
    // agent starts/stops — its edits have just landed when it stops.
    void activeRunning;
    if (!activeCwd) {
      setEnvironmentStats({ added: 0, removed: 0 });
      return;
    }
    void window.modus.diff.read({ cwd: activeCwd }).then((fileDiff: FileDiff) => {
      setEnvironmentStats(getDiffTotals(fileDiff.diff));
    });
  }, [activeCwd, activeRunning]);

  const workspaceRoot = activeWorkspace?.rootPath;
  useEffect(() => {
    if (!workspaceRoot) {
      return;
    }
    void window.modus.mcp.sync(workspaceRoot).catch(() => {});
  }, [workspaceRoot]);

  const canCreateSession = Boolean(model);
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const updateSessionComposerDraft = useCallback(
    (sessionId: string, update: ChatComposerDraftUpdate): void => {
      setComposerDraftBySession((current) => {
        const draft = current[sessionId] ?? {
          ...createEmptyComposerDraft(),
          contextItems: [],
          mode: "build" as const,
        };
        const next = typeof update === "function" ? update(draft) : update;
        return { ...current, [sessionId]: next };
      });
    },
    [],
  );

  const addContextToChat = useCallback(
    (item: ContextItem) => {
      if (activeSession) {
        updateSessionComposerDraft(activeSession.id, (draft) => addContextItemToDraft(draft, item));
        return;
      }
      setHeroContextItems((current) => {
        const key = contextItemKey(item);
        if (current.some((existing) => contextItemKey(existing) === key)) {
          return current;
        }
        return [...current, item];
      });
    },
    [activeSession, updateSessionComposerDraft],
  );

  // `line` is optional (C2.1): every `onOpenFile(path)` caller is unchanged.
  const openWorkspaceFile = useCallback((path: string, line?: number) => {
    setInspectorOpen(true);
    setInspectorTab("files");
    filesRevealKeyRef.current += 1;
    setFilesRevealLine(line ? { line, key: filesRevealKeyRef.current } : undefined);
    setFilesRevealPath(path);
  }, []);

  const openTerminal = useCallback((terminalId: string) => {
    setInspectorOpen(true);
    setInspectorTab("terminal");
    setTerminalRevealId(terminalId);
  }, []);

  return (
    <LazyMotion features={domMax} strict>
      <TooltipProvider>
        <NativeSurfaceProvider>
          <ImageViewerProvider>
            <AppShell className="app-root" glassMode={nativeGlass ? "native" : "solid"}>
              {/* Settings keeps a dedicated titlebar. Conversation chrome uses the
                  main toolbar as the drag/traffic-light row so there is no empty
                  band above the chat header. */}
              {settingsOpen ? <MenuBar /> : null}

              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div
                  className="app-layout-row surface-app flex min-h-0 min-w-0 flex-1"
                  ref={layoutRowRef}
                  style={
                    primaryNavigation.active === "settings"
                      ? undefined
                      : {
                          gap: WORKSPACE_GUTTER,
                          paddingTop: 0,
                          paddingRight: WORKSPACE_GUTTER,
                          paddingBottom: WORKSPACE_GUTTER,
                        }
                  }
                >
                  <AppRail
                    active={primaryNavigation.active}
                    topChromeClearance={!settingsOpen}
                    onNavigate={(destination) =>
                      destination === "settings" ? openSettings() : navigateToPrimary(destination)
                    }
                  />
                  {settingsOpen ? (
                    <Suspense fallback={<ModusLoadingFallback />}>
                      <SettingsPanel
                        initialSection={settingsInitialSection}
                        onClose={closeSettings}
                        onRefresh={refreshModelSettings}
                        onRefreshCatalog={refreshModelCatalog}
                        state={modelSettings}
                        workspaces={workspaces}
                        workspaceCwd={activeWorkspace?.rootPath}
                      />
                    </Suspense>
                  ) : (
                    <>
                      <ContextSidebar>
                        <Sidebar
                          section={
                            primaryNavigation.active === "groups" ? "groups" : "direct-messages"
                          }
                          activityBySession={activityBySession}
                          agentSessions={rootSessions}
                          canCreateSession={canCreateSession}
                          onArchiveSession={(session) => void archiveSession(session)}
                          onDeleteSession={(session) => void deleteSession(session)}
                          onListArchivedSessions={(workspaceId) =>
                            window.modus.agent.listArchived(workspaceId)
                          }
                          onPinProject={(id, pinned) => void pinProject(id, pinned)}
                          onPinSession={(session, pinned) => void pinSession(session, pinned)}
                          onRenameSession={(id, title) => void renameSession(id, title)}
                          onRenameProject={(id, displayName) => void renameProject(id, displayName)}
                          onArchiveProjectChats={(id) => void archiveProjectChats(id)}
                          onDeleteProjectChats={(id) => void deleteProjectChats(id)}
                          onRemoveProject={(id) => void removeProject(id)}
                          onRestoreSession={(session) => void restoreSession(session)}
                          onRevealProject={(id) => void revealProject(id)}
                          onNewSession={() => openNewChat()}
                          onNewWorkspaceSession={(workspace) => openNewChat(workspace)}
                          onOpenWorkspace={() => void openWorkspace()}
                          onOpenSettings={() => openSettings()}
                          onSelectSession={selectSession}
                          onWidthChange={setSidebarWidth}
                          activeSessionId={activeSessionId}
                          maxWidth={sidebarMaxWidth}
                          open={responsiveSidebarOpen}
                          width={sidebarWidth}
                          workspaces={workspaces}
                          groups={agentGroups}
                          groupModels={groupModels}
                          defaultGroupModelId={model || undefined}
                          isGroupWorking={isGroupWorking}
                          isGroupWaiting={isGroupWaiting}
                          activeGroupId={activeGroup?.id}
                          onSelectGroup={selectGroup}
                          activeWorkspaceId={
                            activeWorkspace?.inbox ? null : (activeWorkspace?.id ?? null)
                          }
                          onCreateGroup={createGroup}
                          newGroupServices={newGroupServices}
                          onUpdateGroupMembers={updateGroupMembers}
                          onRenameGroup={(id, name) =>
                            void runGroupAction(() => window.modus.group.rename({ id, name }))
                          }
                          onDeleteGroup={(id) =>
                            void runGroupAction(() => window.modus.group.remove(id))
                          }
                          onRemoveGroupMember={(groupId, sessionId) =>
                            void runGroupAction(() =>
                              window.modus.group.removeMember({ groupId, sessionId }),
                            )
                          }
                          onSetGroupLead={(groupId, sessionId) =>
                            void runGroupAction(() =>
                              window.modus.group.setLead({ groupId, sessionId }),
                            )
                          }
                          groupMemberStates={groupMemberStates}
                          onOpenAgentChat={(agentId) => void openAgentChat(agentId)}
                          onEditAgent={(agentId) => void editAgent(agentId)}
                          onAddAgent={(groupId) => setAgentDialog({ groupId })}
                        />
                      </ContextSidebar>
                      {agentDialogGroup && agentDialog ? (
                        <AgentDialog
                          agent={agentDialog.agent}
                          defaultModelId={model || undefined}
                          group={agentDialogGroup}
                          models={groupModels}
                          onCreate={async (input) => {
                            await window.modus.agents.create(input);
                            await refreshGroups();
                          }}
                          onGenerate={(input) => window.modus.agents.generateProfile(input)}
                          onOpenChange={(open) => {
                            if (!open) setAgentDialog(null);
                          }}
                          onUpdate={async (input) => {
                            await window.modus.agents.update(input);
                            // The 1:1 chat is titled after the agent.
                            await refreshSessions();
                          }}
                          open
                        />
                      ) : null}

                      <MainSurface
                        data-shell-layer="main-surface"
                        className="surface-main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-lg border border-hairline-strong border-t-0"
                        layout={!reduceMotion}
                        layoutDependency={responsiveSidebarOpen}
                        transition={{ layout: SIDEBAR_TRANSITION }}
                      >
                        <TopBar
                          className={cn(
                            "toolbar-row relative z-10 flex shrink-0 items-center pr-3 pl-1",
                            (isMac || windowChrome === "windows-overlay") && "app-drag",
                            windowChrome === "windows-overlay" && "pr-[138px]",
                            // Traffic lights sit in this row when the left sidebar is closed.
                            isMac && !responsiveSidebarOpen && "pl-[76px]",
                          )}
                        >
                          <div className="app-no-drag flex min-w-0 flex-1 items-center gap-1.5">
                            {/* Toggle always lives here so collapse/expand never jumps
                              between the sidebar footer and the main header. */}
                            <ToolbarButton
                              label={
                                responsiveSidebarOpen ? "Collapse sidebar" : "Show left sidebar"
                              }
                              onClick={() => setSidebarOpen((open) => !open)}
                            >
                              <IconLayoutSidebar
                                size={TOOLBAR_ICON.size}
                                stroke={TOOLBAR_ICON.stroke}
                              />
                            </ToolbarButton>
                            {primaryNavigation.active === "direct-messages" && !visibleSession ? (
                              <WorkspaceMenu
                                activeWorkspace={activeWorkspace}
                                workspaces={workspaces}
                                onSelect={openNewChat}
                                onOpenFolder={() => void openWorkspace()}
                                triggerClassName="app-no-drag flex h-7 min-w-0 max-w-[190px] items-center gap-1.5 rounded-md px-2 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                              />
                            ) : null}
                            {visibleGroup ? (
                              <div
                                className="app-no-drag flex min-w-0 flex-1 items-center"
                                data-testid="group-chrome-host"
                                ref={setGroupChromeHost}
                              />
                            ) : visibleSession ? (
                              <SessionTitlePopover
                                branch={branch}
                                contextUsage={contextUsageBySession[visibleSession.id]}
                                modelId={visibleSession.model ?? model}
                                models={models}
                                session={visibleSession}
                                workspace={
                                  workspaceById.get(visibleSession.workspaceId) ?? activeWorkspace
                                }
                              />
                            ) : null}
                          </div>
                          <div
                            className={cn(
                              "flex h-full items-center justify-end",
                              !visibleGroup && "flex-1",
                            )}
                          >
                            {visibleGroup ? null : (
                              <div className="pr-2">
                                <HeaderActions
                                  activeWorkspace={activeWorkspace}
                                  branch={branch}
                                  environmentStats={environmentStats}
                                  inspectorOpen={responsiveInspectorOpen}
                                  onOpenSettings={() => openSettings()}
                                  onToggleInspector={() => setInspectorOpen((open) => !open)}
                                />
                              </div>
                            )}
                          </div>
                        </TopBar>

                        {/* Top right, below the toolbar: clear of the composer (bottom of the
                            chat, center of the hero). */}
                        <UpdateToast
                          api={window.modus.update}
                          className="absolute top-11 right-3 z-30"
                        />

                        {sessionCreateError ? (
                          <div className="mx-6 mb-2 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger">
                            {sessionCreateError}
                          </div>
                        ) : null}

                        <AnimatePresence mode="wait">
                          {primaryNavigation.active === "groups" && !visibleGroup ? (
                            <m.div
                              animate={{ opacity: 1, y: 0 }}
                              className="group-empty-state relative isolate flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden px-8"
                              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -3 }}
                              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                              key="groups-empty"
                              transition={{ duration: reduceMotion ? 0 : 0.12, ease: "easeOut" }}
                            >
                              <div aria-hidden className="group-empty-beams">
                                <span className="group-empty-beam" />
                                <span className="group-empty-beam" />
                                <span className="group-empty-beam" />
                              </div>
                              <div className="relative z-10 max-w-md text-center">
                                <p className="mb-2 text-2xs font-medium uppercase tracking-[0.14em] text-fg-faint">
                                  AGENTIC TEAMS
                                </p>
                                <h1 className="text-xl font-medium tracking-tight text-fg">
                                  Keep shared work moving
                                </h1>
                              </div>
                            </m.div>
                          ) : visibleGroup ? (
                            <m.div
                              animate={{ opacity: 1, y: 0 }}
                              className="flex min-h-0 min-w-0 flex-1"
                              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -3 }}
                              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                              key={`group:${visibleGroup.id}`}
                              transition={{ duration: reduceMotion ? 0 : 0.12, ease: "easeOut" }}
                            >
                              <GroupRoom
                                chromeHost={groupChromeHost}
                                defaultModelId={model || undefined}
                                group={visibleGroup}
                                key={visibleGroup.id}
                                memberStates={groupMemberStates}
                                models={groupModels}
                                onChooseFolder={() => void chooseGroupFolder(visibleGroup.id)}
                                onDelete={() => {
                                  const id = visibleGroup.id;
                                  setActiveGroupId(undefined);
                                  void runGroupAction(() => window.modus.group.remove(id));
                                }}
                                onOpenFile={openWorkspaceFile}
                                onAgentsChanged={() => void refreshGroups()}
                                onAddAgent={() => setAgentDialog({ groupId: visibleGroup.id })}
                                onRename={(name) =>
                                  void runGroupAction(() =>
                                    window.modus.group.rename({ id: visibleGroup.id, name }),
                                  )
                                }
                                onSetMode={(mode) =>
                                  void runGroupAction(() =>
                                    window.modus.group.setMode({ groupId: visibleGroup.id, mode }),
                                  )
                                }
                                onUpdateMembers={(change) =>
                                  updateGroupMembers(visibleGroup.id, change)
                                }
                                workspaces={workspaces}
                              />
                            </m.div>
                          ) : visibleSession ? (
                            <m.div
                              animate={{ opacity: 1, y: 0 }}
                              className="flex min-h-0 min-w-0 flex-1"
                              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -3 }}
                              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                              key={`conversation:${visibleSession.id}`}
                              layout={reduceMotion ? false : "position"}
                              layoutDependency={responsiveSidebarOpen}
                              transition={{
                                ...SIDEBAR_TRANSITION,
                                duration: reduceMotion ? 0 : SIDEBAR_TRANSITION.duration,
                                layout: SIDEBAR_TRANSITION,
                              }}
                            >
                              <Suspense fallback={<ModusLoadingFallback />}>
                                <ChatPane
                                  composerDraft={composerDraftBySession[visibleSession.id]}
                                  composerReplacement={
                                    activeChatBlocked ? (
                                      <BlockedBanner
                                        onAction={() => {
                                          const blocked = activeChatBlocked;
                                          if (blocked.reason === "project-required") {
                                            void chooseGroupFolder(blocked.group.id);
                                          } else {
                                            selectGroup(blocked.group);
                                          }
                                        }}
                                        reason={activeChatBlocked.reason}
                                      />
                                    ) : undefined
                                  }
                                  contextUsage={contextUsageBySession[visibleSession.id]}
                                  defaultModel={model}
                                  hub={hubRef.current}
                                  initialEvents={initialEventsBySession[visibleSession.id]}
                                  key={visibleSession.id}
                                  models={models}
                                  onModelChange={setModel}
                                  onModelConfigChange={(next, thinkingVariant) =>
                                    void updateModelThinking(next, thinkingVariant)
                                  }
                                  onOpenReview={openReview}
                                  onOpenActivity={openActivity}
                                  onOpenConnections={openConnections}
                                  onComposerDraftChange={(update) =>
                                    updateSessionComposerDraft(visibleSession.id, update)
                                  }
                                  onInitialEventsConsumed={(sessionId) => {
                                    setInitialEventsBySession((current) => {
                                      if (!current[sessionId]) {
                                        return current;
                                      }
                                      const next = { ...current };
                                      delete next[sessionId];
                                      return next;
                                    });
                                  }}
                                  onOpenPlan={openPlan}
                                  onOpenFile={openWorkspaceFile}
                                  onOpenTerminal={openTerminal}
                                  onOpenSubagent={openSubagent}
                                  subagentSessions={agentSessions.filter(
                                    (session) => session.parentSessionId === visibleSession.id,
                                  )}
                                  {...(responsiveInspectorOpen &&
                                  inspectorTab === "subagents" &&
                                  selectedSubagentId
                                    ? { inspectorLiveSessionId: selectedSubagentId }
                                    : {})}
                                  onPlanUpdated={rememberActivePlan}
                                  onSessionsChanged={() => void refreshSessions()}
                                  session={visibleSession}
                                  workspace={
                                    workspaceById.get(visibleSession.workspaceId) ?? activeWorkspace
                                  }
                                />
                              </Suspense>
                            </m.div>
                          ) : (
                            <m.div
                              animate={{ opacity: 1, y: 0 }}
                              className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6"
                              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -3 }}
                              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                              key="hero"
                              transition={{
                                duration: reduceMotion ? 0 : 0.12,
                                ease: "easeOut",
                              }}
                            >
                              <div className="relative z-10 w-full max-w-[680px] -translate-y-4">
                                <Composer
                                  onOpenConnections={openConnections}
                                  canSubmit={canCreateSession}
                                  contextItems={heroContextItems}
                                  cwd={activeWorkspace?.rootPath}
                                  draft={heroDraft}
                                  onDraftChange={setHeroDraft}
                                  footer={
                                    <HeroEnvironmentTray
                                      branch={branch}
                                      cwd={activeCwd}
                                      onError={setSessionCreateError}
                                    />
                                  }
                                  mode={heroMode}
                                  model={model}
                                  models={models}
                                  onContextChange={setHeroContextItems}
                                  onModeChange={setHeroMode}
                                  onSubmit={(
                                    message,
                                    context,
                                    delivery,
                                    attachments,
                                    skills,
                                    mode,
                                  ) =>
                                    void submitHeroPrompt(
                                      message,
                                      context,
                                      delivery,
                                      attachments,
                                      skills,
                                      mode,
                                    )
                                  }
                                  workspaceId={activeWorkspace?.id}
                                />
                              </div>
                            </m.div>
                          )}
                        </AnimatePresence>
                      </MainSurface>

                      {responsiveInspectorOpen ? (
                        <Suspense
                          fallback={
                            <div
                              className="surface-main flex min-h-0 min-w-0 shrink-0 overflow-hidden rounded-b-lg border border-hairline-strong border-t-0"
                              style={{ width: inspectorWidth }}
                            >
                              <ModusLoadingFallback />
                            </div>
                          }
                        >
                          <Inspector
                            activeWorkspace={activeWorkspace}
                            contextUsageBySession={contextUsageBySession}
                            cwd={reviewCwd ?? activeCwd}
                            defaultModel={model}
                            hub={hubRef.current}
                            sessionId={activeSession?.id}
                            maxWidth={inspectorMaxWidth}
                            models={models}
                            onModelChange={setModel}
                            onModelConfigChange={(next, thinkingVariant) =>
                              void updateModelThinking(next, thinkingVariant)
                            }
                            onOpenChange={setInspectorOpen}
                            onOpenFile={openWorkspaceFile}
                            onOpenPlan={openPlan}
                            onOpenReview={openReview}
                            onOpenSubagent={openSubagent}
                            onPlanUpdated={rememberActivePlan}
                            onSelectSubagent={setSelectedSubagentId}
                            onSessionsChanged={() => void refreshSessions()}
                            onTabChange={setInspectorTab}
                            onWidthChange={setInspectorWidth}
                            onAddToChat={addContextToChat}
                            onRevealConsumed={() => setFilesRevealPath(undefined)}
                            onRevealTerminalConsumed={() => setTerminalRevealId(undefined)}
                            revealLine={filesRevealLine}
                            revealPath={filesRevealPath}
                            revealTerminalId={terminalRevealId}
                            open={inspectorOpen}
                            {...(activeSession && activePlanBySession[activeSession.id]
                              ? { plan: activePlanBySession[activeSession.id] }
                              : {})}
                            securityState={securityState}
                            selectedSubagentId={selectedSubagentId}
                            sessions={agentSessions}
                            tab={inspectorTab}
                            width={inspectorWidth}
                          />
                        </Suspense>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </AppShell>
          </ImageViewerProvider>
        </NativeSurfaceProvider>
      </TooltipProvider>
    </LazyMotion>
  );
}

/**
 * Top chrome strip (36px) — settings only:
 *   - macOS: native traffic lights only; File/Edit/View/Help live in the system menu bar
 *   - Windows/Linux: native controls; the renderer contributes menu labels only
 *
 * Conversation layout folds drag / traffic-light clearance into the sidebar +
 * main toolbar so the chat header sits flush with the window top.
 */
function MenuBar() {
  const isMac = window.modus?.app.platform === "darwin";
  const windowChrome = window.modus?.app.windowChrome ?? "system";

  return (
    <div
      className={cn(
        "menu-bar flex shrink-0 items-center bg-panel",
        (isMac || windowChrome === "windows-overlay") && "app-drag",
        windowChrome === "windows-overlay" && "pr-[138px]",
        // Clear native traffic lights (positioned at ~14,14 in main-window).
        isMac && "pl-[76px]",
      )}
    >
      <div className={cn("flex flex-1 items-center gap-0.5", !isMac && "pl-2.5")}>
        {isMac ? null : (
          <>
            <MenuItem>File</MenuItem>
            <MenuItem>Edit</MenuItem>
            <MenuItem>View</MenuItem>
            <MenuItem>Help</MenuItem>
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({ children }: { children: string }) {
  return (
    <button
      className={cn(
        "app-no-drag flex h-7 items-center rounded-md px-2 text-xs font-normal text-fg-subtle",
        "transition-colors hover:bg-hover hover:text-fg",
      )}
      type="button"
    >
      {children}
    </button>
  );
}

const HERO_ENVIRONMENT_TRIGGER_CLASS =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm font-normal text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg disabled:opacity-60 disabled:hover:bg-transparent";

function HeroEnvironmentTray({
  branch,
  cwd,
  onError,
}: {
  branch: string | undefined;
  cwd: string | undefined;
  onError(message: string): void;
}) {
  return (
    <div className="app-no-drag flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <BranchSwitcher cwd={cwd} onError={onError} triggerClassName={HERO_ENVIRONMENT_TRIGGER_CLASS}>
        <span className="toolbar-icon">
          <IconGitBranch size={18} stroke={1.7} />
        </span>
        <span className="max-w-40 truncate">{branch ?? "No branch"}</span>
        <IconChevronDown className="toolbar-icon" size={13} stroke={2} />
      </BranchSwitcher>
    </div>
  );
}

/**
 * Folder switcher: lists every known workspace (the authoritative recents from
 * `workspace.list()`), marks the active one, and offers "Open folder…" to add a
 * new root. Selecting a different workspace hands it to the host, which switches
 * and opens a fresh chat — no empty session row is created until the first prompt.
 */
function WorkspaceMenu({
  activeWorkspace,
  workspaces,
  onSelect,
  onOpenFolder,
  triggerClassName = HERO_ENVIRONMENT_TRIGGER_CLASS,
}: {
  activeWorkspace: WorkspaceInfo | null;
  workspaces: WorkspaceInfo[];
  onSelect(workspace: WorkspaceInfo | null): void;
  onOpenFolder(): void;
  triggerClassName?: string;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className={triggerClassName}>
        <span className="toolbar-icon">
          <IconFolder size={18} stroke={1.7} />
        </span>
        <span className="max-w-40 truncate">{activeWorkspace?.displayName ?? "No folder"}</span>
        <IconChevronDown className="toolbar-icon" size={13} stroke={2} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" side="bottom" sideOffset={6}>
          <Menu.Popup className="scroll-thin origin-(--transform-origin) max-h-[360px] min-w-[260px] overflow-y-auto popup-chrome popup-motion p-1">
            <Menu.Item
              className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none transition-colors select-none data-highlighted:bg-hover"
              closeOnClick
              onClick={() => onSelect(null)}
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-accent">
                {!activeWorkspace ? <IconCheck size={14} stroke={2} /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">No folder</span>
                <span className="truncate text-2xs text-fg-faint">Starts a Direct Message</span>
              </span>
            </Menu.Item>
            {workspaces.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-2xs text-fg-faint">
                No recent workspaces
              </div>
            ) : (
              workspaces.map((workspace) => {
                const active = workspace.id === activeWorkspace?.id;
                return (
                  <Menu.Item
                    className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none transition-colors select-none data-highlighted:bg-hover"
                    closeOnClick
                    key={workspace.id}
                    onClick={() => {
                      if (!active) {
                        onSelect(workspace);
                      }
                    }}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-accent">
                      {active ? <IconCheck size={14} stroke={2} /> : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{workspace.displayName}</span>
                      <span className="truncate text-2xs text-fg-faint">{workspace.rootPath}</span>
                    </span>
                  </Menu.Item>
                );
              })
            )}
            <div className="my-1 h-px bg-hairline" />
            <Menu.Item
              className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none transition-colors select-none data-highlighted:bg-hover"
              closeOnClick
              onClick={onOpenFolder}
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-fg-subtle">
                <IconFolderPlus size={15} stroke={1.7} />
              </span>
              <span className="flex-1">Open folder…</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function HeaderActions({
  activeWorkspace,
  branch,
  environmentStats,
  inspectorOpen,
  onOpenSettings,
  onToggleInspector,
}: {
  activeWorkspace: WorkspaceInfo | null;
  branch: string | undefined;
  environmentStats: { added: number; removed: number };
  inspectorOpen: boolean;
  onOpenSettings(): void;
  onToggleInspector(): void;
}) {
  return (
    <div className="app-no-drag flex h-8 items-center gap-1">
      <EnvironmentPopover
        activeWorkspace={activeWorkspace}
        branch={branch}
        environmentStats={environmentStats}
        onOpenSettings={onOpenSettings}
      />
      <ToolbarButton
        active={inspectorOpen}
        label={inspectorOpen ? "Hide right sidebar" : "Show right sidebar"}
        onClick={onToggleInspector}
      >
        <IconLayoutSidebarRight size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
      </ToolbarButton>
    </div>
  );
}

function EnvironmentPopover({
  activeWorkspace,
  branch,
  environmentStats,
  onOpenSettings,
}: {
  activeWorkspace: WorkspaceInfo | null;
  branch: string | undefined;
  environmentStats: { added: number; removed: number };
  onOpenSettings(): void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label="Environment"
        className={cn(
          "toolbar-icon-button flex items-center justify-center rounded-md transition-colors hover:bg-hover",
          open && "bg-active",
        )}
        data-active={open}
      >
        <IconListDetails size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal keepMounted>
            <Popover.Positioner align="end" side="bottom" sideOffset={10}>
              <Popover.Popup render={<m.div />}>
                <m.div
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  className="popup-chrome w-[375px] p-5 outline-none"
                  exit={{ opacity: 0, scale: 0.98, y: -6 }}
                  initial={{ opacity: 0, scale: 0.98, y: -6 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-normal text-fg-subtle">Environment</h2>
                    <button
                      aria-label="Environment settings"
                      className="toolbar-icon-button flex items-center justify-center rounded-md transition-colors hover:bg-hover"
                      onClick={() => {
                        setOpen(false);
                        onOpenSettings();
                      }}
                      type="button"
                    >
                      <IconSettings size={TOOLBAR_ICON.size} stroke={TOOLBAR_ICON.stroke} />
                    </button>
                  </div>
                  <div className="space-y-3 text-sm text-fg">
                    <EnvironmentRow icon={<IconSourceCode size={16} stroke={1.7} />}>
                      <span>Changes</span>
                      <span className="ml-auto font-mono text-success">
                        +{environmentStats.added}
                      </span>
                      <span className="font-mono text-danger">-{environmentStats.removed}</span>
                    </EnvironmentRow>
                    <EnvironmentRow icon={<IconDeviceLaptop size={16} stroke={1.7} />}>
                      <span>{activeWorkspace ? "Local" : "No workspace"}</span>
                      <IconChevronDown className="text-fg-faint" size={12} stroke={2} />
                    </EnvironmentRow>
                    <EnvironmentRow icon={<IconGitBranch size={16} stroke={1.7} />}>
                      <span>{branch ?? "No branch"}</span>
                    </EnvironmentRow>
                    <EnvironmentRow icon={<IconVersions size={16} stroke={1.7} />}>
                      <span>Commit or push</span>
                    </EnvironmentRow>
                  </div>

                  <div className="my-5 h-px bg-hairline-soft" />

                  <section>
                    <h2 className="mb-3 text-sm font-normal text-fg-subtle">Sources</h2>
                    <div className="flex items-center gap-3 text-fg-subtle">
                      <IconCircles size={18} stroke={1.6} />
                      <span className="flex size-5 items-center justify-center rounded bg-[#2f5dff] text-white">
                        <IconBrandVisualStudio size={15} stroke={1.7} />
                      </span>
                      <IconCircles size={18} stroke={1.6} />
                    </div>
                  </section>
                </m.div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

function EnvironmentRow({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <button
      className="flex h-8 w-full items-center gap-3 rounded-md px-1 text-left transition-colors hover:bg-hover"
      type="button"
    >
      <span className="flex size-5 items-center justify-center text-fg">{icon}</span>
      {children}
    </button>
  );
}

function getDiffTotals(diff: string): { added: number; removed: number } {
  return diff.split("\n").reduce(
    (total, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) total.added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) total.removed += 1;
      return total;
    },
    { added: 0, removed: 0 },
  );
}
