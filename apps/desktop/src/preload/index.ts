import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";
import type { AppearanceState } from "../shared/appearance";
import type { AuthState } from "../shared/auth";
import type { BillingState } from "../shared/billing";
import type {
  AgentEvent,
  BrowserEvent,
  FilesChangeEvent,
  GitChangeEvent,
  GroupRuntimeEvent,
  HarnessInsightsQuery,
  TerminalEvent,
  UpdateRestoreUiState,
  UpdateState,
} from "../shared/contracts";
import { resolveWindowAppearance } from "../shared/window-appearance";
import type { ModusApi, SecurityState } from "./types";

const windowAppearance = resolveWindowAppearance(
  process.platform,
  process.getSystemVersion?.() ?? "",
);
const APPEARANCE_ARGUMENT_PREFIX = "--modus-appearance=";

function readInitialAppearance(): AppearanceState | null {
  const raw = process.argv.find((arg) => arg.startsWith(APPEARANCE_ARGUMENT_PREFIX));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.slice(APPEARANCE_ARGUMENT_PREFIX.length)) as AppearanceState;
    return typeof parsed?.glass === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

const initialAppearance = readInitialAppearance();
let nativeGlassAvailable = initialAppearance?.glass ?? windowAppearance.glass === "native";
const nativeGlassListeners = new Set<(available: boolean) => void>();
const appearanceListeners = new Set<(state: AppearanceState) => void>();

ipcRenderer.on("appearance:event", (_event: IpcRendererEvent, state: AppearanceState) => {
  if (typeof state?.glass !== "boolean") return;
  for (const listener of appearanceListeners) listener(state);
  if (state.glass === nativeGlassAvailable) return;
  nativeGlassAvailable = state.glass;
  for (const listener of nativeGlassListeners) listener(state.glass);
});

const api: ModusApi = {
  app: {
    platform: process.platform,
    windowChrome: windowAppearance.chrome,
    nativeGlass: windowAppearance.glass === "native",
    isNativeGlassAvailable: () => nativeGlassAvailable,
    onNativeGlassChange(handler) {
      nativeGlassListeners.add(handler);
      return () => nativeGlassListeners.delete(handler);
    },
    appearance: {
      initial: initialAppearance,
      get: () => ipcRenderer.invoke("appearance:get") as Promise<AppearanceState>,
      set: (input) => ipcRenderer.invoke("appearance:set", input) as Promise<AppearanceState>,
      onChange(handler) {
        appearanceListeners.add(handler);
        return () => appearanceListeners.delete(handler);
      },
    },
    version: () => ipcRenderer.invoke("app:version") as Promise<string>,
    securityState: () => ipcRenderer.invoke("app:security-state") as Promise<SecurityState>,
    startupMetric: (input) => ipcRenderer.invoke("app:startup-metric", input),
  },
  workspace: {
    open: () => ipcRenderer.invoke("workspace:open"),
    list: () => ipcRenderer.invoke("workspace:list"),
    ensureChats: () => ipcRenderer.invoke("workspace:ensure-chats"),
    select: (input) => ipcRenderer.invoke("workspace:select", input),
    pin: (input) => ipcRenderer.invoke("workspace:pin", input),
    rename: (input) => ipcRenderer.invoke("workspace:rename", input),
    archiveChats: (id) => ipcRenderer.invoke("workspace:archive-chats", { id }),
    deleteChats: (id) => ipcRenderer.invoke("workspace:delete-chats", { id }),
    remove: (id) => ipcRenderer.invoke("workspace:remove", { id }),
    reveal: (id) => ipcRenderer.invoke("workspace:reveal", { id }),
  },
  group: {
    list: () => ipcRenderer.invoke("group:list"),
    create: (input) => ipcRenderer.invoke("group:create", input),
    rename: (input) => ipcRenderer.invoke("group:rename", input),
    remove: (id) => ipcRenderer.invoke("group:delete", { id }),
    addMember: (input) => ipcRenderer.invoke("group:add-member", input),
    removeMember: (input) => ipcRenderer.invoke("group:remove-member", input),
    setWorkspace: (input) => ipcRenderer.invoke("group:set-workspace", input),
    setLead: (input) => ipcRenderer.invoke("group:set-lead", input),
    setMode: (input) => ipcRenderer.invoke("group:set-mode", input),
    updateMembers: (input) => ipcRenderer.invoke("group:update-members", input),
    postMessage: (input) => ipcRenderer.invoke("group:post-message", input),
    resumeExecution: (input) => ipcRenderer.invoke("group:resume-execution", input),
    listMessages: (input) => ipcRenderer.invoke("group:list-messages", input),
    workingGroupIds: () => ipcRenderer.invoke("group:working"),
    memberStates: () => ipcRenderer.invoke("group:member-states"),
    listTasks: (groupId) => ipcRenderer.invoke("group:list-tasks", { groupId }),
    cancelTask: (taskId) => ipcRenderer.invoke("group:cancel-task", { taskId }),
    previewTaskIntegration: (taskId) => ipcRenderer.invoke("group:integration-preview", { taskId }),
    applyTaskIntegration: (input) => ipcRenderer.invoke("group:integration-apply", input),
    abortTaskIntegration: (taskId) => ipcRenderer.invoke("group:integration-abort", { taskId }),
    getIntegrationState: (taskId) => ipcRenderer.invoke("group:integration-state", { taskId }),
    refreshTaskIntegrationState: (taskId) =>
      ipcRenderer.invoke("group:integration-refresh", { taskId }),
    getWorkState: (groupId, executionId) =>
      ipcRenderer.invoke("group:get-work-state", {
        groupId,
        ...(executionId ? { executionId } : {}),
      }),
    getTaskDetails: (groupId, taskId) =>
      ipcRenderer.invoke("group:get-task-details", {
        groupId,
        taskId,
      }),
    listTaskTransitions: (taskId) => ipcRenderer.invoke("group:list-task-transitions", { taskId }),
    updateTask: (taskId, draft, expectedVersion) =>
      ipcRenderer.invoke("group:update-task", {
        taskId,
        draft,
        expectedVersion,
      }),
    getProactivityMode: (groupId) => ipcRenderer.invoke("group:get-proactivity-mode", { groupId }),
    setProactivityMode: (groupId, mode) =>
      ipcRenderer.invoke("group:set-proactivity-mode", { groupId, mode }),
    listSuggestions: (groupId) => ipcRenderer.invoke("group:list-suggestions", { groupId }),
    resolveSuggestion: (actionId, decision, expectedVersion, targetSessionId) =>
      ipcRenderer.invoke("group:resolve-suggestion", {
        actionId,
        decision,
        expectedVersion,
        ...(targetSessionId ? { targetSessionId } : {}),
      }),
    listDecisions: (groupId) => ipcRenderer.invoke("group:list-decisions", { groupId }),
    deleteDecision: (decisionId) => ipcRenderer.invoke("group:delete-decision", { decisionId }),
    stop: (groupId) => ipcRenderer.invoke("group:stop", { groupId }),
    projectContext: (workspaceId) => ipcRenderer.invoke("group:project-context", { workspaceId }),
    onEvent: (callback) => {
      const listener = (_event: IpcRendererEvent, event: GroupRuntimeEvent) => callback(event);
      ipcRenderer.on("group:event", listener);
      return () => ipcRenderer.removeListener("group:event", listener);
    },
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list"),
    create: (input) => ipcRenderer.invoke("agents:create", input),
    update: (input) => ipcRenderer.invoke("agents:update", input),
    setArchived: (input) => ipcRenderer.invoke("agents:archive", input),
    remove: (id) => ipcRenderer.invoke("agents:delete", { id }),
    openChat: (id) => ipcRenderer.invoke("agents:open-chat", { id }),
    generateProfile: (input) => ipcRenderer.invoke("agents:generate-profile", input),
  },
  file: {
    open: (input) => ipcRenderer.invoke("file:open", input),
  },
  agent: {
    create: (input) => ipcRenderer.invoke("agent:create", input),
    list: (input) => ipcRenderer.invoke("agent:list", input),
    listArchived: (workspaceId) => ipcRenderer.invoke("agent:list-archived", workspaceId),
    listEvents: (sessionId) => ipcRenderer.invoke("agent:list-events", sessionId),
    listRuns: (sessionId) => ipcRenderer.invoke("agent:list-runs", sessionId),
    runWorkspaceRevision: (input) => ipcRenderer.invoke("agent:run-workspace-revision", input),
    ensure: (sessionId) => ipcRenderer.invoke("agent:ensure", sessionId),
    releaseRuntime: (sessionId) => ipcRenderer.invoke("agent:release-runtime", sessionId),
    prompt: (input) => ipcRenderer.invoke("agent:prompt", input),
    branchState: (sessionId) => ipcRenderer.invoke("agent:branch-state", sessionId),
    setBranch: (input) => ipcRenderer.invoke("agent:set-branch", input),
    reviewPlanWithHyperPlan: (input) => ipcRenderer.invoke("agent:review-plan-hyperplan", input),
    applyHyperPlanRevision: (input) => ipcRenderer.invoke("agent:apply-hyperplan-revision", input),
    createHyperPlanDraft: (input) => ipcRenderer.invoke("agent:create-hyperplan-draft", input),
    resolveHyperPlanDraft: (input) =>
      ipcRenderer.invoke("agent:resolve-hyperplan-draft-choice", input),
    startPlanBuild: (input) => ipcRenderer.invoke("agent:start-plan-build", input),
    startOriginalPlanBuild: (input) => ipcRenderer.invoke("agent:start-original-plan-build", input),
    compact: (sessionId) => ipcRenderer.invoke("agent:compact", sessionId),
    abort: (sessionId) => ipcRenderer.invoke("agent:abort", sessionId),
    rollback: (input) => ipcRenderer.invoke("agent:rollback", input),
    pin: (input) => ipcRenderer.invoke("agent:pin", input),
    rename: (input) => ipcRenderer.invoke("agent:rename", input),
    archive: (sessionId) => ipcRenderer.invoke("agent:archive", sessionId),
    restore: (sessionId) => ipcRenderer.invoke("agent:restore", sessionId),
    delete: (sessionId) => ipcRenderer.invoke("agent:delete", sessionId),
    applySubagentWorktree: (sessionId) =>
      ipcRenderer.invoke("agent:apply-subagent-worktree", sessionId),
    abortSubagentWorktreeApply: (sessionId) =>
      ipcRenderer.invoke("agent:abort-subagent-worktree-apply", sessionId),
    cleanupSubagentWorktree: (sessionId) =>
      ipcRenderer.invoke("agent:cleanup-subagent-worktree", sessionId),
    setModel: (input) => ipcRenderer.invoke("agent:set-model", input),
    cycleModel: (input) => ipcRenderer.invoke("agent:cycle-model", input),
    onEvent: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as AgentEvent);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
    onFocusSession: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload as string);
      ipcRenderer.on("agent:focus-session", listener);
      return () => ipcRenderer.removeListener("agent:focus-session", listener);
    },
  },
  terminal: {
    create: (input) => ipcRenderer.invoke("terminal:create", input),
    write: (input) => ipcRenderer.invoke("terminal:write", input),
    resize: (input) => ipcRenderer.invoke("terminal:resize", input),
    kill: (terminalId) => ipcRenderer.invoke("terminal:kill", terminalId),
    remove: (terminalId) => ipcRenderer.invoke("terminal:remove", terminalId),
    list: () => ipcRenderer.invoke("terminal:list"),
    onEvent: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as TerminalEvent);
      ipcRenderer.on("terminal:event", listener);
      return () => ipcRenderer.removeListener("terminal:event", listener);
    },
  },
  process: {
    list: (input) => ipcRenderer.invoke("process:list", input),
    kill: (id) => ipcRenderer.invoke("process:kill", { id }),
    onChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("process:changed", listener);
      return () => ipcRenderer.removeListener("process:changed", listener);
    },
  },
  browser: {
    listTabs: (input) => ipcRenderer.invoke("browser:list-tabs", input),
    createTab: (input) => ipcRenderer.invoke("browser:create-tab", input),
    selectTab: (input) => ipcRenderer.invoke("browser:select-tab", input),
    closeTab: (input) => ipcRenderer.invoke("browser:close-tab", input),
    navigate: (input) => ipcRenderer.invoke("browser:navigate", input),
    back: (input) => ipcRenderer.invoke("browser:back", input),
    forward: (input) => ipcRenderer.invoke("browser:forward", input),
    reload: (input) => ipcRenderer.invoke("browser:reload", input),
    setBounds: (input) => ipcRenderer.invoke("browser:set-bounds", input),
    show: (input) => ipcRenderer.invoke("browser:show", input),
    hide: (input) => ipcRenderer.invoke("browser:hide", input),
    toggleDevtools: (input) => ipcRenderer.invoke("browser:toggle-devtools", input),
    openExternal: (input) => ipcRenderer.invoke("browser:open-external", input),
    setDesignMode: (input) => ipcRenderer.invoke("browser:design-mode", input),
    find: (input) => ipcRenderer.invoke("browser:find", input),
    findStop: (input) => ipcRenderer.invoke("browser:find-stop", input),
    listRecents: (input) => ipcRenderer.invoke("browser:list-recents", input),
    deleteRecent: (input) => ipcRenderer.invoke("browser:delete-recent", input),
    onEvent: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as BrowserEvent);
      ipcRenderer.on("browser:event", listener);
      return () => ipcRenderer.removeListener("browser:event", listener);
    },
  },
  diff: {
    review: (input) => ipcRenderer.invoke("diff:review", input),
    read: (input) => ipcRenderer.invoke("diff:read", input),
    filePatch: (input) => ipcRenderer.invoke("diff:file-patch", input),
    stage: (input) => ipcRenderer.invoke("diff:stage", input),
    unstage: (input) => ipcRenderer.invoke("diff:unstage", input),
    discardUnstaged: (input) => ipcRenderer.invoke("diff:discard-unstaged", input),
    status: (cwd) => ipcRenderer.invoke("diff:status", cwd),
    stats: (cwd) => ipcRenderer.invoke("diff:stats", cwd),
    statsSince: (input) => ipcRenderer.invoke("diff:stats-since", input),
    sessionStats: (sessionId) => ipcRenderer.invoke("diff:session-stats", sessionId),
    commitOrPush: (input) => ipcRenderer.invoke("diff:commit-or-push", input),
  },
  files: {
    list: (input) => ipcRenderer.invoke("files:list", input),
    read: (input) => ipcRenderer.invoke("files:read", input),
    write: (input) => ipcRenderer.invoke("files:write", input),
    watch: (cwd) => ipcRenderer.invoke("files:watch", cwd),
    isWatching: (cwd) => ipcRenderer.invoke("files:watch-status", cwd),
    unwatch: (cwd) => ipcRenderer.invoke("files:unwatch", cwd),
    onChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as FilesChangeEvent);
      ipcRenderer.on("files:event", listener);
      return () => ipcRenderer.removeListener("files:event", listener);
    },
  },
  preview: {
    read: (input) => ipcRenderer.invoke("preview:read", input),
  },
  git: {
    branches: (cwd) => ipcRenderer.invoke("git:branches", cwd),
    checkout: (input) => ipcRenderer.invoke("git:checkout", input),
    isRepository: (cwd) => ipcRenderer.invoke("git:is-repository", cwd),
    init: (cwd) => ipcRenderer.invoke("git:init", cwd),
    log: (input) => ipcRenderer.invoke("git:log", input),
    watch: (cwd) => ipcRenderer.invoke("git:watch", cwd),
    unwatch: (cwd) => ipcRenderer.invoke("git:unwatch", cwd),
    onChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as GitChangeEvent);
      ipcRenderer.on("git:event", listener);
      return () => ipcRenderer.removeListener("git:event", listener);
    },
  },
  permission: {
    decide: (input) => ipcRenderer.invoke("permission:decide", input),
    list: () => ipcRenderer.invoke("permission:list"),
    getMode: (input) => ipcRenderer.invoke("permission:get-mode", input ?? {}),
    setMode: (input) => ipcRenderer.invoke("permission:set-mode", input),
    clearProjectMode: (input) => ipcRenderer.invoke("permission:clear-project-mode", input),
  },
  questions: {
    respond: (input) => ipcRenderer.invoke("questions:respond", input),
  },
  context: {
    search: (input) => ipcRenderer.invoke("context:search", input),
    resolve: (input) => ipcRenderer.invoke("context:resolve", input),
  },
  docs: {
    list: (workspaceId) => ipcRenderer.invoke("docs:list", workspaceId),
    add: (input) => ipcRenderer.invoke("docs:add", input),
    search: (input) => ipcRenderer.invoke("docs:search", input),
  },
  projectMemory: {
    snapshot: (input) => ipcRenderer.invoke("project-memory:snapshot", input),
    setEnabled: (input) => ipcRenderer.invoke("project-memory:set-enabled", input),
    verify: (input) => ipcRenderer.invoke("project-memory:verify", input),
    markObsolete: (input) => ipcRenderer.invoke("project-memory:mark-obsolete", input),
    delete: (input) => ipcRenderer.invoke("project-memory:delete", input),
  },
  harnessInsights: {
    get: (input: HarnessInsightsQuery) => ipcRenderer.invoke("harness-insights:get", input),
    listPromotions: (input) => ipcRenderer.invoke("harness-promotions:list", input ?? {}),
    promote: (input) => ipcRenderer.invoke("harness-promotions:promote", input),
    rejectPromotion: (input) => ipcRenderer.invoke("harness-promotions:reject", input),
    listFailureBlacklist: (input) =>
      ipcRenderer.invoke("harness-failure-blacklist:list", input ?? {}),
    clearFailureBlacklist: (input) =>
      ipcRenderer.invoke("harness-failure-blacklist:clear", input ?? {}),
  },
  model: {
    list: () => ipcRenderer.invoke("model:list"),
    setDefault: (model) => ipcRenderer.invoke("model:set-default", model),
    settings: () => ipcRenderer.invoke("model:settings"),
    limits: () => ipcRenderer.invoke("model:limits"),
    refreshLimits: () => ipcRenderer.invoke("model:limits-refresh"),
    setCodexLimitsEnabled: (enabled) =>
      ipcRenderer.invoke("model:limits-set-codex-enabled", { enabled }),
    refreshCatalog: () => ipcRenderer.invoke("model:refresh-catalog"),
    onCatalogChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("model:catalog-changed", listener);
      return () => ipcRenderer.removeListener("model:catalog-changed", listener);
    },
    providerDetail: (provider) => ipcRenderer.invoke("model:provider-detail", provider),
    connectionMethods: (provider) =>
      ipcRenderer.invoke("model:provider-connection-methods", provider),
    startProviderAuth: (input) => ipcRenderer.invoke("model:provider-auth-start", input),
    providerAuthState: (input) => ipcRenderer.invoke("model:provider-auth-state", input),
    respondProviderAuth: (input) => ipcRenderer.invoke("model:provider-auth-respond", input),
    cancelProviderAuth: (input) => ipcRenderer.invoke("model:provider-auth-cancel", input),
    disconnectProvider: (provider) => ipcRenderer.invoke("model:disconnect-provider", provider),
    customProviderConfig: (provider) =>
      ipcRenderer.invoke("model:custom-provider-config", provider),
    deleteCustomProvider: (provider) =>
      ipcRenderer.invoke("model:delete-custom-provider", provider),
    configureProvider: (input) => ipcRenderer.invoke("model:configure-provider", input),
    upsertCustomProvider: (input) => ipcRenderer.invoke("model:upsert-custom-provider", input),
    testCustomProvider: (input) => ipcRenderer.invoke("model:test-custom-provider", input),
    updateConfig: (input) => ipcRenderer.invoke("model:update-config", input),
    setProviderModelsEnabled: (input) =>
      ipcRenderer.invoke("model:set-provider-models-enabled", input),
  },
  review: {
    start: (input) => ipcRenderer.invoke("review:start", input),
    list: (cwd) => ipcRenderer.invoke("review:list", cwd),
  },
  checkpoint: {
    list: (sessionId) => ipcRenderer.invoke("checkpoint:list", sessionId),
    restore: (input) => ipcRenderer.invoke("checkpoint:restore", input),
  },
  mcp: {
    list: () => ipcRenderer.invoke("mcp:list"),
    sync: (cwd) => ipcRenderer.invoke("mcp:sync", cwd),
    openConfig: (cwd) => ipcRenderer.invoke("mcp:open-config", cwd),
    upsert: (input) => ipcRenderer.invoke("mcp:upsert", input),
    delete: (input) => ipcRenderer.invoke("mcp:delete", input),
    setEnabled: (input) => ipcRenderer.invoke("mcp:set-enabled", input),
    entry: (input) => ipcRenderer.invoke("mcp:entry", input),
  },
  composio: {
    getState: () => ipcRenderer.invoke("composio:get-state"),
    diagnose: () => ipcRenderer.invoke("composio:diagnose"),
    setApiKey: (input) => ipcRenderer.invoke("composio:set-api-key", input),
    removeApiKey: () => ipcRenderer.invoke("composio:remove-api-key"),
    refreshCatalog: () => ipcRenderer.invoke("composio:refresh-catalog"),
    listTools: (input) => ipcRenderer.invoke("composio:list-tools", input),
    startConnection: (input) => ipcRenderer.invoke("composio:start-connection", input),
    getConnectionOperation: (input) =>
      ipcRenderer.invoke("composio:get-connection-operation", input),
    setToolkitPolicy: (input) => ipcRenderer.invoke("composio:set-toolkit-policy", input),
    renameAccount: (input) => ipcRenderer.invoke("composio:rename-account", input),
    disconnectAccount: (input) => ipcRenderer.invoke("composio:disconnect-account", input),
  },
  rules: {
    list: (cwd) => ipcRenderer.invoke("rules:list", cwd),
    getAgents: (cwd) => ipcRenderer.invoke("rules:get-agents", cwd),
    saveAgents: (input) => ipcRenderer.invoke("rules:save-agents", input),
  },
  personalization: {
    get: () => ipcRenderer.invoke("personalization:get"),
    save: (input) => ipcRenderer.invoke("personalization:save", input),
    open: () => ipcRenderer.invoke("personalization:open"),
  },
  skills: {
    list: (cwd) => ipcRenderer.invoke("skills:list", cwd),
    get: (input) => ipcRenderer.invoke("skills:get", input),
    create: (input) => ipcRenderer.invoke("skills:create", input),
    openDir: (cwd) => ipcRenderer.invoke("skills:open-dir", cwd),
  },
  subagents: {
    list: (cwd) => ipcRenderer.invoke("subagents:list", cwd),
    get: (input) => ipcRenderer.invoke("subagents:get", input),
    create: (input) => ipcRenderer.invoke("subagents:create", input),
    update: (input) => ipcRenderer.invoke("subagents:update", input),
    delete: (input) => ipcRenderer.invoke("subagents:delete", input),
    openDir: (input) => ipcRenderer.invoke("subagents:open-dir", input),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize") as Promise<void>,
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize") as Promise<void>,
    close: () => ipcRenderer.invoke("window:close") as Promise<void>,
    getState: () => ipcRenderer.invoke("window:state") as Promise<{ maximized: boolean }>,
    onStateChange: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as { maximized: boolean });
      ipcRenderer.on("window:state-event", listener);
      return () => ipcRenderer.removeListener("window:state-event", listener);
    },
  },
  update: {
    getState: () => ipcRenderer.invoke("update:get-state") as Promise<UpdateState>,
    install: () => ipcRenderer.invoke("update:install") as Promise<void>,
    retry: () => ipcRenderer.invoke("update:retry") as Promise<void>,
    restartNow: () => ipcRenderer.invoke("update:restart-now") as Promise<void>,
    dismiss: () => ipcRenderer.invoke("update:dismiss") as Promise<void>,
    openReleasePage: () => ipcRenderer.invoke("update:open-release-page") as Promise<void>,
    saveUiState: (state) => ipcRenderer.invoke("update:save-ui-state", state) as Promise<void>,
    takeRestoredUiState: () =>
      ipcRenderer.invoke("update:take-restored-ui-state") as Promise<UpdateRestoreUiState | null>,
    onStateChange: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as UpdateState);
      ipcRenderer.on("update:state-event", listener);
      return () => ipcRenderer.removeListener("update:state-event", listener);
    },
  },
  auth: {
    getState: () => ipcRenderer.invoke("auth:get-state") as Promise<AuthState>,
    signUp: (input) => ipcRenderer.invoke("auth:sign-up", input) as Promise<AuthState>,
    signInWithPassword: (input) =>
      ipcRenderer.invoke("auth:sign-in-password", input) as Promise<AuthState>,
    signInWithOAuth: (input) =>
      ipcRenderer.invoke("auth:sign-in-oauth", input) as Promise<AuthState>,
    cancelOAuth: () => ipcRenderer.invoke("auth:cancel-oauth") as Promise<AuthState>,
    signOut: () => ipcRenderer.invoke("auth:sign-out") as Promise<AuthState>,
    onStateChange: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as AuthState);
      ipcRenderer.on("auth:state-event", listener);
      return () => ipcRenderer.removeListener("auth:state-event", listener);
    },
  },
  billing: {
    getState: () => ipcRenderer.invoke("billing:get-state") as Promise<BillingState>,
    refresh: () => ipcRenderer.invoke("billing:refresh") as Promise<BillingState>,
    checkout: (input) => ipcRenderer.invoke("billing:checkout", input) as Promise<BillingState>,
    openPortal: () => ipcRenderer.invoke("billing:portal") as Promise<BillingState>,
    cancelSubscription: () => ipcRenderer.invoke("billing:cancel") as Promise<BillingState>,
    buyCredits: (input) => ipcRenderer.invoke("billing:buyCredits", input) as Promise<BillingState>,
    onStateChange: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) =>
        callback(payload as BillingState);
      ipcRenderer.on("billing:state-event", listener);
      return () => ipcRenderer.removeListener("billing:state-event", listener);
    },
  },
  clipboard: {
    writeImage: (input) => ipcRenderer.invoke("clipboard:write-image", input) as Promise<void>,
  },
  dialog: {
    saveImage: (input) =>
      ipcRenderer.invoke("dialog:save-image", input) as Promise<
        { saved: false } | { saved: true; path: string }
      >,
  },
};

contextBridge.exposeInMainWorld("modus", api);
