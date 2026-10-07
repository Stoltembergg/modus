import type { AppearanceSetInput, AppearanceState } from "../shared/appearance";
import type { AuthCredentialsInput, AuthOAuthInput, AuthState } from "../shared/auth";
import type { BillingBuyCreditsInput, BillingCheckoutInput, BillingState } from "../shared/billing";
import type {
  AddDocInput,
  AgentEvent,
  AgentGroupMode,
  AgentGroupWithMembers,
  AgentInfo,
  AgentMode,
  AgentReviewDepth,
  AgentReviewResult,
  AgentRollbackResult,
  AgentRunInfo,
  AgentSessionInfo,
  ApprovalMode,
  ApprovalModeState,
  BrowserBounds,
  BrowserEvent,
  BrowserRecentInfo,
  BrowserTabInfo,
  CheckpointInfo,
  ComposioConnectionOperation,
  ComposioConnectivityResult,
  ComposioSettingsState,
  ComposioStartConnectionInput,
  ComposioToolkitPolicyInput,
  ComposioToolSummary,
  ConfigureProviderInput,
  ContextItem,
  ContextKind,
  ContextSuggestion,
  CreateAgentGroupInput,
  CreateGroupAgentInput,
  CustomProviderConfig,
  DiffFilePatch,
  DiffReview,
  DiffTarget,
  DocHit,
  DocSource,
  FailureBlacklistEntry,
  FileDiff,
  FileEntry,
  FileReadResult,
  FilesChangeEvent,
  FileWriteResult,
  GenerateAgentProfileInput,
  GeneratedAgentProfile,
  GitActionResult,
  GitBranchSummary,
  GitChangeEvent,
  GitCommit,
  GitCommitResult,
  GitStatusSummary,
  GroupDecision,
  GroupIntegrationPreview,
  GroupIntegrationRecord,
  GroupIntegrationState,
  GroupMemberStates,
  GroupMessage,
  GroupMessageCursor,
  GroupProactivityMode,
  GroupProjectContextSnapshot,
  GroupRuntimeEvent,
  GroupSuggestion,
  GroupSuggestionResolution,
  GroupTask,
  GroupTaskDetails,
  GroupTaskQueueItem,
  GroupTaskTransitionEvent,
  GroupTaskUserDraft,
  GroupWorkState,
  HarnessInsight,
  HarnessInsightsQuery,
  HarnessInsightsResult,
  HyperPlanRevision,
  HyperPlanSourceSnapshot,
  HyperPlanSummary,
  ManagedProcessInfo,
  ManagedProcessOrigin,
  McpServerInfo,
  McpServerUpsertInput,
  ModelInfo,
  ModelProviderDetail,
  ModelSettingsState,
  PermissionAction,
  PermissionDecision,
  PersonalizationState,
  PlanRef,
  PostGroupMessageInput,
  PreviewReadResult,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  PromptDelivery,
  PromptImageAttachment,
  ProviderAuthOperationState,
  ProviderConnectionMethod,
  ProviderLimitsState,
  QuestionAnswer,
  QuestionResponse,
  RawMcpEntry,
  ResolvedContext,
  ResumeGroupExecutionInput,
  RuleFileInfo,
  SessionBranchState,
  SkillDetail,
  SkillInfo,
  SkillSelection,
  SubagentDetail,
  SubagentInfo,
  TerminalEvent,
  TerminalInfo,
  TestCustomProviderInput,
  TestCustomProviderResult,
  ThinkingLevel,
  UpdateAgentGroupMembersInput,
  UpdateAgentInput,
  UpdateModelConfigInput,
  UpdateRestoreUiState,
  UpdateState,
  UpsertCustomProviderInput,
  WorkingChangeStats,
  WorkspaceAgentsState,
  WorkspaceInfo,
} from "../shared/contracts";
import type { StartupMetricInput } from "../shared/startup";
import type { WindowChromeMode } from "../shared/window-appearance";

export type HyperPlanBuildStart = {
  sessionId: string;
  planId: string;
  planFingerprint: string;
  runId: string;
};

export type SecurityState = {
  contextIsolation: boolean;
  nodeIntegration: boolean;
  sandbox: boolean;
  senderValidation: boolean;
};

/** Resolved Modus theme tokens forwarded to the in-page Design Mode overlay. */
export type DesignModeTheme = {
  accent: string;
  accentContrast: string;
  surface: string;
  elevated: string;
  fg: string;
  fgSubtle: string;
  fontFamily: string;
  border: string;
  shadow: string;
};

export type ModusApi = {
  app: {
    /** Host OS platform (`darwin` | `win32` | `linux` …). Sync — set at preload time. */
    platform: string;
    /** Native frame or OS controls overlay selected for this platform. */
    windowChrome: WindowChromeMode;
    /** Whether this host supports the native glass effect used by the shell. */
    nativeGlass: boolean;
    /**
     * Whether glass is on right now: host support, the Transparency preference
     * and OS accessibility settings all agree (same glass in every theme).
     */
    isNativeGlassAvailable(): boolean;
    /** Fires whenever the effective glass state flips (preference, theme, OS or a native failure). */
    onNativeGlassChange(handler: (available: boolean) => void): () => void;
    /** Theme / Transparency preferences mirrored in the main process (nativeTheme + window material). */
    appearance: {
      /** State at window creation, read synchronously for a flash-free first paint. */
      initial: AppearanceState | null;
      get(): Promise<AppearanceState>;
      set(input: AppearanceSetInput): Promise<AppearanceState>;
      onChange(handler: (state: AppearanceState) => void): () => void;
    };
    version(): Promise<string>;
    securityState(): Promise<SecurityState>;
    startupMetric(input: StartupMetricInput): Promise<void>;
  };
  workspace: {
    open(): Promise<WorkspaceInfo | undefined>;
    list(): Promise<WorkspaceInfo[]>;
    /** Inbox workspace for chats started without a project folder. */
    ensureChats(): Promise<WorkspaceInfo>;
    /** Set this renderer's main-process current project; omitted for Inbox/no-project. */
    select(input: { workspaceId?: string }): Promise<void>;
    /** Pin / unpin a project; returns the re-sorted recents. */
    pin(input: { id: string; pinned: boolean }): Promise<WorkspaceInfo[]>;
    /** Rename a project's sidebar label; returns the updated recents. */
    rename(input: { id: string; displayName: string }): Promise<WorkspaceInfo[]>;
    /** Soft-archive all of a project's visible chats; returns the number archived. */
    archiveChats(id: string): Promise<number>;
    /** Permanently delete all of a project's chats; returns the number deleted. */
    deleteChats(id: string): Promise<number>;
    /** Remove a project from Modus (files kept); returns the updated recents. */
    remove(id: string): Promise<WorkspaceInfo[]>;
    /** Reveal a project's root folder in the OS file manager. */
    reveal(id: string): Promise<void>;
  };
  group: {
    /** Every Agent Group with its members (sidebar Groups section). */
    list(): Promise<AgentGroupWithMembers[]>;
    /**
     * Create a group in a Project with 2..10 NEW agents (one group per agent)
     * and its lead, in one all-or-nothing step.
     */
    create(input: CreateAgentGroupInput): Promise<AgentGroupWithMembers>;
    /** Rename a group; returns the refreshed group list. */
    rename(input: { id: string; name: string }): Promise<AgentGroupWithMembers[]>;
    /** Delete a group with its agents, their chats and all group messages; returns the list. */
    remove(id: string): Promise<AgentGroupWithMembers[]>;
    /** Add an ungrouped (legacy) agent; new agents join with `agents.create({ groupId })`. */
    addMember(input: {
      groupId: string;
      agentId: string;
      role?: string;
    }): Promise<AgentGroupWithMembers[]>;
    /** Move the group (and its room sessions) to another Project; never to none. */
    setWorkspace(input: {
      groupId: string;
      workspaceId: string | null;
    }): Promise<AgentGroupWithMembers[]>;
    /** Remove a member = delete its agent (refused at 2: `group-min-members`); returns the list. */
    removeMember(input: { groupId: string; sessionId: string }): Promise<AgentGroupWithMembers[]>;
    /** Set or clear (null) the lead; the lead must be a member. */
    setLead(input: { groupId: string; sessionId: string | null }): Promise<AgentGroupWithMembers[]>;
    /** Coordinator mode on/off (kept but ignored while the group has no Lead). */
    setMode(input: { groupId: string; mode: AgentGroupMode }): Promise<AgentGroupWithMembers[]>;
    /**
     * "Manage members" in ONE all-or-nothing step: create the `add` agents,
     * remove `removeAgentIds` (deleting their agents) and set the final lead.
     * The 2..10 rule and the lead are checked on the final state; returns the
     * refreshed list.
     */
    updateMembers(input: UpdateAgentGroupMembersInput): Promise<AgentGroupWithMembers[]>;
    /**
     * Post a user message to the room; it opens a new chain and wakes the
     * mentioned members (or the lead when nobody is mentioned).
     */
    postMessage(input: PostGroupMessageInput): Promise<GroupMessage>;
    /**
     * Resume an interrupted/failed turn by durable execution id (job/turn id).
     * Requeues the existing job — does not post a new user message.
     */
    resumeExecution(input: ResumeGroupExecutionInput): Promise<void>;
    /** A page of room messages in (created_at, id) order. */
    listMessages(input: {
      groupId: string;
      before?: GroupMessageCursor;
      after?: GroupMessageCursor;
      limit?: number;
    }): Promise<GroupMessage[]>;
    /** Groups with a member turn running or queued right now. */
    workingGroupIds(): Promise<string[]>;
    /** Running / queued / waiting-for-you members of every active group. */
    memberStates(): Promise<GroupMemberStates[]>;
    /** Stop the room: end its chains and abort running member turns ("Turn stopped"). */
    stop(groupId: string): Promise<void>;
    /** The group's tasks (created order) for the room's task panel. */
    listTasks(groupId: string): Promise<GroupTask[]>;
    /** Bounded task state for agent context; renderer details use getTaskDetails. */
    getWorkState(groupId: string, executionId?: string): Promise<GroupWorkState>;
    /** Read-only FIFO of dispatched tasks and ready backlog, without prompt text. */
    getTaskQueueSnapshot(groupId: string): Promise<GroupTaskQueueItem[]>;
    /** Bounded user-facing criteria, current evidence outcomes and dependency details. */
    getTaskDetails(groupId: string, taskId: string): Promise<GroupTaskDetails>;
    /** Chronological task history (the main process caps the result). */
    listTaskTransitions(taskId: string): Promise<GroupTaskTransitionEvent[]>;
    /** User edits only the task draft; state and evidence remain main-owned. */
    updateTask(
      taskId: string,
      draft: GroupTaskUserDraft,
      expectedVersion: number,
    ): Promise<GroupTask>;
    /** Persisted, per-group proactivity preference (`suggest` by default). */
    getProactivityMode(groupId: string): Promise<GroupProactivityMode>;
    setProactivityMode(groupId: string, mode: GroupProactivityMode): Promise<GroupProactivityMode>;
    /** Current safe user-facing suggestions; no conversation or QA output is included. */
    listSuggestions(groupId: string): Promise<GroupSuggestion[]>;
    /** Accept or discard exactly one suggestion using its displayed version. */
    resolveSuggestion(
      actionId: string,
      decision: "accept" | "discard",
      expectedVersion: number,
      targetSessionId?: string,
    ): Promise<GroupSuggestionResolution>;
    /** "Cancel task": the only path to `cancelled` (a done task is refused). */
    cancelTask(taskId: string): Promise<GroupTask>;
    /** Create a read-only, main-process integration preview for one task. */
    previewTaskIntegration(taskId: string): Promise<GroupIntegrationPreview>;
    /** Apply exactly the persisted preview after the user explicitly confirms it. */
    applyTaskIntegration(input: {
      taskId: string;
      previewId: string;
      confirmedByUser: true;
    }): Promise<GroupIntegrationRecord>;
    /** Abort a stored applied/conflicted no-commit merge after a fresh git.write decision. */
    abortTaskIntegration(taskId: string): Promise<GroupIntegrationRecord>;
    /** Read the latest persisted integration DTOs; no Git state is recomputed. */
    getIntegrationState(taskId: string): Promise<GroupIntegrationState>;
    /** Reconcile an interrupted apply record, or return the latest persisted DTOs. */
    refreshTaskIntegrationState(taskId: string): Promise<GroupIntegrationState>;
    /** The group's decisions (newest first) for the side panel's "Decisions". */
    listDecisions(groupId: string): Promise<GroupDecision[]>;
    /** "Delete" a decision (physical; posts nothing in the room). */
    deleteDecision(decisionId: string): Promise<GroupDecision>;
    /**
     * Workspace-scoped Project Setup status (shared Project Model map).
     * Also schedules reopen Setup (no-op when fingerprint still matches).
     */
    projectContext(workspaceId: string): Promise<GroupProjectContextSnapshot | null>;
    onEvent(callback: (event: GroupRuntimeEvent) => void): () => void;
  };
  /** Agents (agents model): each belongs to one group, names unique in it. */
  agents: {
    /** Every agent, archived included, by name. */
    list(): Promise<AgentInfo[]>;
    /**
     * Create an agent in its (only) group; rejects `agent-name-taken` (per group),
     * `group-max-members`, and without a template `agent-model-required` /
     * `agent-model-unavailable`.
     */
    create(input: CreateGroupAgentInput): Promise<AgentInfo>;
    /** Change the given fields (null clears model / default Project); returns the refreshed list. */
    update(input: UpdateAgentInput & { id: string }): Promise<AgentInfo[]>;
    /** Archive / restore (group membership is kept); returns the refreshed list. */
    setArchived(input: { id: string; archived: boolean }): Promise<AgentInfo[]>;
    /** Delete the agent = remove the member (refused at 2: `group-min-members`); returns the list. */
    remove(id: string): Promise<AgentInfo[]>;
    /**
     * The agent's 1:1 chat (A3): a normal `kind='chat'` session in the group's
     * Project, created on first open; rejects `group-project-required`.
     */
    openChat(id: string): Promise<AgentSessionInfo>;
    /**
     * One LLM call for a custom agent's `{ role, instructions }` (A3). Never
     * rejects on a model failure: `generated: false` is the Generalist fallback.
     */
    generateProfile(input: GenerateAgentProfileInput): Promise<GeneratedAgentProfile>;
  };
  file: {
    /** Open a workspace file in the OS default app. Path may be relative to cwd or absolute. */
    open(input: { cwd: string; path: string }): Promise<void>;
  };
  agent: {
    create(input: {
      workspaceId: string;
      cwd: string;
      title: string;
      model?: string;
    }): Promise<AgentSessionInfo>;
    list(input?: { includeSessionId?: string }): Promise<AgentSessionInfo[]>;
    listArchived(workspaceId: string): Promise<AgentSessionInfo[]>;
    listEvents(
      sessionId: string,
    ): Promise<Array<{ id: string; event: AgentEvent; createdAt?: string }>>;
    listRuns(sessionId: string): Promise<AgentRunInfo[]>;
    ensure(sessionId: string): Promise<AgentSessionInfo>;
    /**
     * Drop in-memory SDK runtime for this session only (no descendant abort /
     * no DB status rewrite). Used when a ChatPane unmounts while idle.
     */
    releaseRuntime(sessionId: string): Promise<void>;
    prompt(input: {
      sessionId: string;
      message: string;
      context?: ContextItem[];
      delivery?: PromptDelivery;
      userMessageId?: string;
      attachments?: PromptImageAttachment[];
      skills?: SkillSelection[];
      mode?: AgentMode;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      thinkingVariant?: string;
      /** Set when this prompt is a "Build this plan" action; binds the turn to the plan. */
      planId?: string;
    }): Promise<void>;
    /** L2: the session's branch (resolved in the main process). */
    branchState(sessionId: string): Promise<SessionBranchState>;
    /**
     * L2: switch the session to a local branch by NAME (never a path). Refused while a run
     * is active or the worktree has uncommitted changes.
     */
    setBranch(input: { sessionId: string; branch: string }): Promise<SessionBranchState>;
    reviewPlanWithHyperPlan(input: {
      sessionId: string;
      planId: string;
      model?: string;
    }): Promise<HyperPlanSummary>;
    applyHyperPlanRevision(input: {
      sessionId: string;
      planId: string;
      planHash: string;
      revisedContent: string;
    }): Promise<PlanRef>;
    createHyperPlanDraft(input: {
      sessionId: string;
      planId: string;
      /** Spec/composer model; HyperPlan prefers this over the global default. */
      model?: string;
    }): Promise<{ draftId: string; revision: HyperPlanRevision }>;
    resolveHyperPlanDraft(input: {
      draftId: string;
      choice: "revision" | "original";
      requestId: string;
    }): Promise<{ selectionId: string; plan: PlanRef; planFingerprint: string }>;
    startPlanBuild(input: { selectionId: string; requestId: string }): Promise<HyperPlanBuildStart>;
    startOriginalPlanBuild(input: {
      sessionId: string;
      planId: string;
      requestId: string;
      sourceSnapshot: HyperPlanSourceSnapshot;
    }): Promise<HyperPlanBuildStart>;
    compact(sessionId: string): Promise<void>;
    abort(sessionId: string): Promise<void>;
    /**
     * Rewind the session to just before one of its user messages: restores
     * workspace files from the pre-run snapshot and removes the conversation
     * from that message onward. Used by the timeline's "edit & resend".
     */
    rollback(input: { sessionId: string; userMessageId: string }): Promise<AgentRollbackResult>;
    pin(input: { id: string; pinned: boolean }): Promise<AgentSessionInfo | undefined>;
    /** Rename a chat session; returns the updated session. */
    rename(input: { id: string; title: string }): Promise<AgentSessionInfo | undefined>;
    archive(sessionId: string): Promise<void>;
    restore(sessionId: string): Promise<void>;
    delete(sessionId: string): Promise<void>;
    applySubagentWorktree(sessionId: string): Promise<AgentSessionInfo>;
    abortSubagentWorktreeApply(sessionId: string): Promise<AgentSessionInfo>;
    cleanupSubagentWorktree(sessionId: string): Promise<AgentSessionInfo>;
    setModel(input: {
      sessionId: string;
      model: string;
      thinkingLevel?: ThinkingLevel;
      thinkingVariant?: string;
    }): Promise<AgentSessionInfo>;
    cycleModel(input: {
      sessionId?: string;
      direction?: "forward" | "backward";
    }): Promise<ModelInfo>;
    onEvent(callback: (event: AgentEvent) => void): () => void;
    /** Notification click → bring this session into the focused pane. */
    onFocusSession(callback: (sessionId: string) => void): () => void;
  };
  terminal: {
    create(input: {
      workspaceId: string;
      cwd?: string;
      cols?: number;
      rows?: number;
    }): Promise<TerminalInfo>;
    write(input: { terminalId: string; data: string }): Promise<void>;
    resize(input: { terminalId: string; cols: number; rows: number }): Promise<void>;
    kill(terminalId: string): Promise<void>;
    remove(terminalId: string): Promise<void>;
    list(): Promise<TerminalInfo[]>;
    onEvent(callback: (event: TerminalEvent) => void): () => void;
  };
  process: {
    list(input: {
      workspaceId?: string;
      sessionId?: string;
      origin?: ManagedProcessOrigin;
    }): Promise<ManagedProcessInfo[]>;
    kill(id: string): Promise<boolean>;
    onChanged(callback: () => void): () => void;
  };
  browser: {
    listTabs(input: { workspaceId: string }): Promise<BrowserTabInfo[]>;
    createTab(input: { workspaceId: string; url?: string }): Promise<BrowserTabInfo>;
    selectTab(input: { tabId: string }): Promise<BrowserTabInfo>;
    closeTab(input: { tabId: string }): Promise<void>;
    navigate(input: {
      tabId?: string;
      workspaceId?: string;
      url: string;
      newTab?: boolean;
    }): Promise<BrowserTabInfo>;
    back(input: { tabId: string }): Promise<BrowserTabInfo>;
    forward(input: { tabId: string }): Promise<BrowserTabInfo>;
    reload(input: { tabId: string }): Promise<BrowserTabInfo>;
    setBounds(input: { tabId: string; bounds: BrowserBounds }): Promise<void>;
    show(input: { tabId: string; bounds: BrowserBounds }): Promise<void>;
    hide(input: { tabId: string }): Promise<void>;
    toggleDevtools(input: { tabId: string }): Promise<BrowserTabInfo>;
    openExternal(input: { tabId: string }): Promise<void>;
    /** Toggle Design Mode (point-and-select). `theme` carries Modus light/dark tokens. */
    setDesignMode(input: {
      tabId: string;
      enabled: boolean;
      theme?: DesignModeTheme;
    }): Promise<BrowserTabInfo>;
    find(input: {
      tabId: string;
      query: string;
      forward?: boolean;
      findNext?: boolean;
      matchCase?: boolean;
    }): Promise<void>;
    findStop(input: {
      tabId: string;
      action?: "clearSelection" | "keepSelection" | "activateSelection";
    }): Promise<void>;
    listRecents(input: { workspaceId: string }): Promise<BrowserRecentInfo[]>;
    deleteRecent(input: { id: string }): Promise<void>;
    onEvent(callback: (event: BrowserEvent) => void): () => void;
  };
  diff: {
    review(input: { cwd: string; target: DiffTarget }): Promise<DiffReview>;
    read(input: { cwd: string; path?: string; mode?: FileDiff["mode"] }): Promise<FileDiff>;
    filePatch(input: {
      cwd: string;
      path: string;
      target: DiffTarget;
      originalPath?: string;
      untracked: boolean;
      ignoreWhitespace: boolean;
    }): Promise<DiffFilePatch>;
    stage(input: { cwd: string; path: string }): Promise<void>;
    unstage(input: { cwd: string; path: string }): Promise<void>;
    discardUnstaged(input: { cwd: string; path: string }): Promise<void>;
    status(cwd: string): Promise<GitStatusSummary>;
    /** File list + ± line counters for the changes strip / apply review. */
    stats(cwd: string): Promise<WorkingChangeStats>;
    /** File list + ± line counters since a Git commit-ish. */
    statsSince(input: { cwd: string; base: string }): Promise<WorkingChangeStats>;
    /**
     * Session-scoped change summary: changes since this session's baseline
     * (its first checkpoint), for the composer strip. Empty when the session
     * has no baseline yet (it has changed nothing).
     */
    sessionStats(sessionId: string): Promise<WorkingChangeStats>;
    commitOrPush(input: {
      cwd: string;
      message?: string;
      commit: boolean;
      push: boolean;
      includeUnstaged?: boolean;
    }): Promise<GitCommitResult>;
  };
  files: {
    list(input: { cwd: string; dir?: string }): Promise<FileEntry[]>;
    read(input: { cwd: string; path: string }): Promise<FileReadResult>;
    write(input: { cwd: string; path: string; content: string }): Promise<FileWriteResult>;
    /** Start live-watching the workspace root (ref-counted). Returns resolved root. */
    watch(cwd: string): Promise<string>;
    /** Stop live-watching (ref-counted). */
    unwatch(cwd: string): Promise<void>;
    /** Subscribe to debounced workspace-change events. Returns an unsubscribe fn. */
    onChanged(callback: (event: FilesChangeEvent) => void): () => void;
  };
  preview: {
    read(input: { cwd: string; path: string }): Promise<PreviewReadResult>;
  };
  git: {
    branches(cwd: string): Promise<GitBranchSummary>;
    checkout(input: { cwd: string; name: string; remote?: boolean }): Promise<GitActionResult>;
    isRepository(cwd: string): Promise<boolean>;
    init(cwd: string): Promise<GitActionResult>;
    /** Recent commit history for the Source Control "All commits" scope. */
    log(input: { cwd: string; limit?: number }): Promise<GitCommit[]>;
    /** Start live-watching the repo containing cwd (ref-counted). */
    watch(cwd: string): Promise<string | undefined>;
    /** Stop live-watching (ref-counted). */
    unwatch(cwd: string): Promise<void>;
    /** Subscribe to debounced repository-change events. Returns an unsubscribe fn. */
    onChanged(callback: (event: GitChangeEvent) => void): () => void;
  };
  permission: {
    decide(input: {
      requestId?: string;
      sessionId?: string;
      action: PermissionAction;
      target: string;
      decision: PermissionDecision["decision"];
    }): Promise<PermissionDecision>;
    list(): Promise<PermissionDecision[]>;
    getMode(input?: { cwd?: string }): Promise<ApprovalModeState>;
    setMode(input: { mode: ApprovalMode; cwd?: string }): Promise<ApprovalModeState>;
    clearProjectMode(input: { cwd: string }): Promise<ApprovalModeState>;
  };
  questions: {
    /** Resolve a pending ask_user request with the user's answers (or a skip). */
    respond(input: {
      requestId: string;
      answers: QuestionAnswer[];
      skipped: boolean;
    }): Promise<QuestionResponse | null>;
  };
  context: {
    search(input: {
      workspaceId: string;
      cwd: string;
      query: string;
      kind?: ContextKind;
    }): Promise<ContextSuggestion[]>;
    resolve(input: { cwd: string; items: ContextItem[] }): Promise<ResolvedContext[]>;
  };
  docs: {
    list(workspaceId: string): Promise<DocSource[]>;
    add(input: AddDocInput): Promise<DocSource>;
    search(input: { workspaceId: string; query: string }): Promise<DocHit[]>;
  };
  projectMemory: {
    snapshot(input: { workspaceId?: string }): Promise<ProjectMemorySnapshot>;
    setEnabled(input: {
      scope: ProjectMemoryScope;
      enabled: boolean;
    }): Promise<ProjectMemorySnapshot>;
    verify(input: { memoryId: string }): Promise<ProjectMemorySnapshot>;
    markObsolete(input: { memoryId: string }): Promise<ProjectMemorySnapshot>;
    delete(input: { memoryId: string }): Promise<ProjectMemorySnapshot>;
  };
  harnessInsights: {
    get(input: HarnessInsightsQuery): Promise<HarnessInsightsResult>;
    listPromotions(input?: { workspaceId?: string }): Promise<unknown[]>;
    promote(input: {
      workspaceId?: string;
      insight: HarnessInsight;
      confirmedByUser: true;
    }): Promise<{ ok: boolean; reasonCodes?: string[]; record?: unknown }>;
    rejectPromotion(input: {
      workspaceId?: string;
      promotionId: string;
      reason?: string;
    }): Promise<{ ok: boolean }>;
    listFailureBlacklist(input?: { workspaceId?: string }): Promise<FailureBlacklistEntry[]>;
    clearFailureBlacklist(input?: {
      workspaceId?: string;
      strategyCode?: string;
      clearAll?: boolean;
    }): Promise<{ cleared: number }>;
  };
  model: {
    list(): Promise<ModelInfo[]>;
    setDefault(model: string): Promise<void>;
    settings(): Promise<ModelSettingsState>;
    limits(): Promise<ProviderLimitsState>;
    refreshLimits(): Promise<ProviderLimitsState>;
    setCodexLimitsEnabled(enabled: boolean): Promise<ProviderLimitsState>;
    refreshCatalog(): Promise<ModelSettingsState>;
    onCatalogChanged(callback: () => void): () => void;
    providerDetail(provider: string): Promise<ModelProviderDetail | undefined>;
    connectionMethods(provider: string): Promise<ProviderConnectionMethod[]>;
    startProviderAuth(input: {
      provider: string;
      riskAcknowledged?: true;
    }): Promise<ProviderAuthOperationState>;
    providerAuthState(input: { operationId: string }): Promise<ProviderAuthOperationState>;
    respondProviderAuth(input: { operationId: string; value?: string }): Promise<void>;
    cancelProviderAuth(input: { operationId: string }): Promise<void>;
    disconnectProvider(provider: string): Promise<void>;
    customProviderConfig(provider: string): Promise<CustomProviderConfig | undefined>;
    deleteCustomProvider(provider: string): Promise<void>;
    configureProvider(input: ConfigureProviderInput): Promise<ModelProviderDetail>;
    upsertCustomProvider(input: UpsertCustomProviderInput): Promise<ModelProviderDetail>;
    /** Live connectivity probe for the custom provider form (nothing is saved). */
    testCustomProvider(input: TestCustomProviderInput): Promise<TestCustomProviderResult>;
    updateConfig(input: UpdateModelConfigInput): Promise<ModelInfo>;
    /** Enable or disable every model for a provider (Settings select-all). */
    setProviderModelsEnabled(input: {
      provider: string;
      enabled: boolean;
    }): Promise<ModelProviderDetail>;
  };
  review: {
    start(input: {
      cwd: string;
      sessionId?: string;
      workspaceId?: string;
      depth?: AgentReviewDepth;
    }): Promise<AgentReviewResult>;
    list(cwd: string): Promise<AgentReviewResult[]>;
  };
  checkpoint: {
    list(sessionId: string): Promise<CheckpointInfo[]>;
    restore(input: { checkpointId: string }): Promise<CheckpointInfo>;
  };
  mcp: {
    list(): Promise<McpServerInfo[]>;
    sync(cwd: string): Promise<McpServerInfo[]>;
    openConfig(cwd: string): Promise<string>;
    upsert(input: { cwd: string } & McpServerUpsertInput): Promise<McpServerInfo[]>;
    delete(input: { cwd: string; name: string }): Promise<McpServerInfo[]>;
    setEnabled(input: { cwd: string; name: string; enabled: boolean }): Promise<McpServerInfo[]>;
    entry(input: { cwd: string; name: string }): Promise<RawMcpEntry | undefined>;
  };
  composio: {
    getState(): Promise<ComposioSettingsState>;
    diagnose(): Promise<ComposioConnectivityResult>;
    setApiKey(input: { apiKey: string }): Promise<ComposioSettingsState>;
    removeApiKey(): Promise<ComposioSettingsState>;
    refreshCatalog(): Promise<ComposioSettingsState>;
    listTools(input: { toolkitSlug: string }): Promise<ComposioToolSummary[]>;
    startConnection(input: ComposioStartConnectionInput): Promise<ComposioConnectionOperation>;
    getConnectionOperation(input: { operationId: string }): Promise<ComposioConnectionOperation>;
    setToolkitPolicy(input: ComposioToolkitPolicyInput): Promise<ComposioSettingsState>;
    renameAccount(input: {
      toolkitSlug: string;
      accountId: string;
      alias: string;
    }): Promise<ComposioSettingsState>;
    disconnectAccount(input: {
      toolkitSlug: string;
      accountId: string;
    }): Promise<ComposioSettingsState>;
  };
  rules: {
    /** Detected project rule files (AGENTS.md, .cursor/rules…) with apply modes. */
    list(cwd: string): Promise<RuleFileInfo[]>;
    /** Workspace AGENTS.md for the Settings editor. */
    getAgents(cwd: string): Promise<WorkspaceAgentsState>;
    /** Create or overwrite workspace AGENTS.md. */
    saveAgents(input: { cwd: string; content: string }): Promise<WorkspaceAgentsState>;
  };
  personalization: {
    get(): Promise<PersonalizationState>;
    save(input: { content: string }): Promise<PersonalizationState>;
    open(): Promise<string>;
  };
  skills: {
    list(cwd: string): Promise<SkillInfo[]>;
    get(input: { cwd: string; path: string }): Promise<SkillDetail | undefined>;
    create(input: {
      cwd: string;
      name: string;
      description: string;
      body: string;
    }): Promise<SkillInfo>;
    openDir(cwd: string): Promise<string>;
  };
  subagents: {
    list(cwd: string): Promise<SubagentInfo[]>;
    get(input: { cwd: string; path: string }): Promise<SubagentDetail | undefined>;
    create(input: {
      cwd: string;
      scope?: "user" | "workspace";
      name: string;
      description: string;
      model?: string;
      readOnly: boolean;
      tools?: string[];
      disallowedTools?: string[];
      isolation?: "shared" | "worktree";
      body: string;
    }): Promise<SubagentInfo>;
    update(input: {
      cwd: string;
      path: string;
      name: string;
      description: string;
      model?: string;
      readOnly: boolean;
      tools?: string[];
      disallowedTools?: string[];
      isolation?: "shared" | "worktree";
      body: string;
    }): Promise<SubagentInfo>;
    delete(input: { cwd: string; path: string }): Promise<SubagentInfo[]>;
    openDir(input: { cwd: string; scope?: "user" | "workspace" }): Promise<string>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    getState(): Promise<{ maximized: boolean }>;
    onStateChange(listener: (state: { maximized: boolean }) => void): () => void;
  };
  /** App auto-update (GitHub Releases). Everything is a no-op in dev and beta builds. */
  update: {
    getState(): Promise<UpdateState>;
    /** Downloads and installs (restart waits for running agents), or opens the release page. */
    install(): Promise<void>;
    retry(): Promise<void>;
    /** In `waiting-for-agents`: restart now instead of waiting for running agents. */
    restartNow(): Promise<void>;
    /** Hides the notice for this version until a newer one appears (in memory only). */
    dismiss(): Promise<void>;
    openReleasePage(): Promise<void>;
    /** While a downloaded update is pending: the latest UI state, written by main on quit. */
    saveUiState(state: UpdateRestoreUiState): Promise<void>;
    /** Once per start: the UI state saved by the previous version, or null. */
    takeRestoredUiState(): Promise<UpdateRestoreUiState | null>;
    onStateChange(listener: (state: UpdateState) => void): () => void;
  };
  /**
   * Modus account (Supabase Auth). Sign-in runs in main; replies carry display data only,
   * never tokens or the OAuth code.
   */
  auth: {
    getState(): Promise<AuthState>;
    signUp(input: AuthCredentialsInput): Promise<AuthState>;
    signInWithPassword(input: AuthCredentialsInput): Promise<AuthState>;
    /** Opens the default browser; resolves after the callback was handled, failed or timed out. */
    signInWithOAuth(input: AuthOAuthInput): Promise<AuthState>;
    cancelOAuth(): Promise<AuthState>;
    /** Clears the stored session even when offline. */
    signOut(): Promise<AuthState>;
    onStateChange(listener: (state: AuthState) => void): () => void;
  };
  /**
   * Plan and credits (Mercado Pago, optionally Stripe, via Supabase Edge Functions). Checkout /
   * Portal open in the default browser; replies carry display data only, never tokens, provider
   * ids or session URLs.
   */
  billing: {
    getState(): Promise<BillingState>;
    refresh(): Promise<BillingState>;
    /** Only a plan key (+ provider, default Mercado Pago); the server maps it to the price. */
    checkout(input: BillingCheckoutInput): Promise<BillingState>;
    openPortal(): Promise<BillingState>;
    /** L1e: cancel the own Mercado Pago subscription; main finds it, no id is passed. */
    cancelSubscription(): Promise<BillingState>;
    /** L5b: Mercado Pago Checkout Pro for a credit pack (only the pack id crosses IPC). */
    buyCredits(input: BillingBuyCreditsInput): Promise<BillingState>;
    onStateChange(listener: (state: BillingState) => void): () => void;
  };
  clipboard: {
    /** Write PNG bytes to the OS clipboard as an image. */
    writeImage(input: { png: Uint8Array }): Promise<void>;
  };
  dialog: {
    /** Native Save dialog + write PNG bytes. Cancel → `{ saved: false }`. */
    saveImage(input: {
      png: Uint8Array;
      defaultName?: string;
    }): Promise<{ saved: false } | { saved: true; path: string }>;
  };
};
