import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  Type,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { BrowserWindow as BrowserWindowType } from "electron";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, PlanRef } from "../../shared/contracts";

let userData: string;
let cwd: string;
const execFileAsync = promisify(execFile);

const mocks = vi.hoisted(() => {
  const model = { id: "model", name: "Mock Model", provider: "mock" };
  let subscriber: ((event: unknown) => void) | undefined;
  const processState = { processes: [] as unknown[] };
  return {
    createAgentSession: vi.fn(),
    killManagedProcess: vi.fn(async () => true),
    listManagedProcesses: vi.fn((query: { sessionId?: string; origin?: string }) =>
      processState.processes.filter((process) => {
        const item = process as { sessionId?: string; origin?: string };
        return (
          (query.sessionId === undefined || item.sessionId === query.sessionId) &&
          (query.origin === undefined || item.origin === query.origin)
        );
      }),
    ),
    model,
    emitPiEvent: (event: unknown) => subscriber?.(event),
    setManagedProcesses: (processes: unknown[]) => {
      processState.processes = processes;
    },
    setPiSubscriber: (next: ((event: unknown) => void) | undefined) => {
      subscriber = next;
    },
    sessionManagerCreate: vi.fn(() => ({ kind: "create" })),
    sessionManagerOpen: vi.fn(() => ({ kind: "open" })),
    settingsManagerInMemory: vi.fn(
      (_settings?: Parameters<typeof SettingsManager.inMemory>[0]) => ({}),
    ),
    resourceLoaderOptions: [] as unknown[],
    globalGuidance: undefined as string | undefined,
    allowlistedMcpToolNames: [] as string[],
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
}));

/** Window stub: focused + alive, so background notifications never fire in tests. */
function createWindowStub(): BrowserWindowType {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
  } as unknown as BrowserWindowType;
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  defineTool: <T>(tool: T): T => tool,
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      mocks.resourceLoaderOptions.push(options);
    }
    async reload(): Promise<void> {}
  },
  SessionManager: {
    create: mocks.sessionManagerCreate,
    open: mocks.sessionManagerOpen,
  },
  SettingsManager: {
    inMemory: mocks.settingsManagerInMemory,
  },
}));

vi.mock("../guidance/guidance-service", () => ({
  resolveGlobalGuidancePrompt: vi.fn(() => mocks.globalGuidance),
}));

vi.mock("../process/managed-process-facade", () => ({
  killManagedProcess: mocks.killManagedProcess,
  listManagedProcesses: mocks.listManagedProcesses,
}));

vi.mock("../mcp/mcp-service", () => ({
  listAllowlistedMcpToolNames: () => mocks.allowlistedMcpToolNames,
}));

vi.mock("./model-service", () => ({
  cycleDefaultModel: vi.fn(() => ({
    id: "mock/model",
    provider: "mock",
    name: "Mock Model",
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: true,
    thinkingLevel: "off",
    thinkingLevels: ["off", "low", "medium", "high"],
  })),
  findModel: vi.fn(() => mocks.model),
  isUsableModelId: vi.fn(() => true),
  getDefaultModel: vi.fn(() => mocks.model),
  getModelInfo: vi.fn(() => ({
    id: "mock/model",
    provider: "mock",
    name: "Mock Model",
    available: true,
    enabled: true,
    configured: true,
    source: "builtin",
    supportsThinking: true,
    thinkingLevel: "off",
    thinkingLevels: ["off", "low", "medium", "high"],
  })),
  getModelThinkingVariant: vi.fn(() => "off"),
  getModelRegistry: vi.fn(() => ({ authStorage: {} })),
  listModels: vi.fn(() => [{ id: "mock/model" }]),
  listScopedModels: vi.fn(() => [{ model: mocks.model, thinkingLevel: "off" }]),
  modelToId: (model: typeof mocks.model) => `${model.provider}/${model.id}`,
  resolveModelThinking: vi.fn((model: typeof mocks.model, variant?: string) => ({
    model,
    thinkingLevel: variant === "high" ? "high" : "off",
    variant: variant ?? "off",
  })),
  setDefaultModel: vi.fn(),
}));

const { getDatabase } = await import("../db/database");
const { PiSdkRuntime, activeToolNamesForSession, removeRunOutputTrackerIfOwned } = await import(
  "./pi-sdk-runtime"
);
const modelService = await import("./model-service");
const { toolRegistry } = await import("./tools/registry");
const { deleteAgentSessionTree, setAgentSessionArchivedTree } = await import("./session-lifecycle");
const contextPlanner = await import("../context/context-planner");
const gitMemoryContext = await import("../git/git-service");
const { getLatestHarnessTaskState, listAgentEvents, recordAgentEvent } = await import(
  "./agent-event-store"
);
const { getAgentSession, updateAgentSessionWorktree } = await import("./agent-store");
const { getActiveAgentRun, getAgentRun, createAgentRun, updateAgentRunStatus } = await import(
  "./agent-run-store"
);
const mcpCitations = await import("./harness/mcp-citation-registry");
const projectMemory = await import("../memory/project-memory-service");
const { writePlan, readPlanById, fingerprintPlanSource } = await import("../plan/plan-store");
const checkpointService = await import("./checkpoint-service");
const { resolveAgentToolContext, setAgentToolContext } = await import("./tools/tool-context");
const { resolveQuestionRequest } = await import("../interaction/question-broker");
const todoToolRuntime = await import("./tools/todo-tools");
const permissionExtension = await import("./pi-permission-extension");
const hyperPlanDraftStore = await import("./harness/hyperplan-draft-store");
const { setFeatureFlagOverrides, resetFeatureFlagOverrides } = await import(
  "./harness/feature-flags"
);
const { ResponsePolicyRegistry } = await import("./harness/response");
const { HarnessObserver } = await import("./harness/observability");

function createMockPiSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { prompt: promptOverride, deferPreflight, ...sessionOverrides } = overrides;
  const prompt = vi.fn(
    (
      message: string,
      options?: {
        preflightResult?: (success: boolean) => void;
        streamingBehavior?: string;
      },
    ) => {
      if (deferPreflight !== true) options?.preflightResult?.(true);
      if (typeof promptOverride === "function") {
        return Promise.resolve(
          (promptOverride as (text: string, options?: unknown) => unknown)(message, options),
        );
      }
      return Promise.resolve();
    },
  );
  return {
    abort: vi.fn(async () => undefined),
    agent: { thinkingBudgets: undefined },
    cycleModel: vi.fn(async () => ({ model: mocks.model })),
    dispose: vi.fn(),
    getContextUsage: vi.fn(() => ({
      contextWindow: 1000,
      percent: 24,
      tokens: 240,
    })),
    model: mocks.model,
    prompt,
    sessionFile: join(userData, "pi-sessions", "resumed.jsonl"),
    sessionId: "pi-resumed",
    // Authoritative turn state read by the runtime: whether a turn is streaming
    // (so a steer/follow-up joins it instead of opening a run) and the message
    // log (so the end-of-turn outcome reads the last assistant stopReason).
    isStreaming: false,
    state: { messages: [] },
    // Rollback anchor source: an empty tree reads as the "root" sentinel.
    sessionManager: { getLeafId: vi.fn(() => null) },
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn((callback) => {
      mocks.setPiSubscriber(callback);
      return vi.fn();
    }),
    ...sessionOverrides,
  };
}

/** Real PI tool registration/execution, with only the provider stream replaced. */
async function useOfflinePiToolSessions() {
  const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  const authStorage = sdk.AuthStorage.inMemory({
    mock: { type: "api_key", key: "offline-test-only" },
  });
  const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
  const sessions: AgentSession[] = [];
  let requestedTool: string | undefined;
  mocks.sessionManagerCreate.mockImplementation(() => sdk.SessionManager.inMemory(cwd) as never);
  mocks.settingsManagerInMemory.mockImplementation((settings) =>
    sdk.SettingsManager.inMemory(settings),
  );
  mocks.createAgentSession.mockImplementation(async (options) => {
    const loaderOptions = mocks.resourceLoaderOptions.at(-1) as ConstructorParameters<
      typeof sdk.DefaultResourceLoader
    >[0];
    const resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
    await resourceLoader.reload();
    const { session } = await sdk.createAgentSession({
      ...options,
      authStorage,
      modelRegistry,
      resourceLoader,
      model: {
        api: "openai-completions",
        baseUrl: "https://offline.invalid",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1000,
        ...options.model,
      },
    });
    session.agent.streamFn = (model, context) => {
      const stream = createAssistantMessageEventStream();
      const toolName = context.messages.at(-1)?.role !== "toolResult" ? requestedTool : undefined;
      const callTool = Boolean(toolName);
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: toolName
          ? [{ type: "toolCall", id: crypto.randomUUID(), name: toolName, arguments: {} }]
          : [{ type: "text", text: "Done." }],
        stopReason: callTool ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message });
      // The installed SDK and app resolve different pi-ai patch versions.
      return stream as unknown as ReturnType<AgentSession["agent"]["streamFn"]>;
    };
    sessions.push(session);
    return { session };
  });
  return {
    sessionAt: (index = -1) => {
      const session = sessions.at(index);
      if (!session) throw new Error("Expected an offline PI session.");
      return session;
    },
    requestTool: (name: string) => {
      requestedTool = name;
    },
  };
}

function registerOfflineMcpTool(name: string, output: string, dangerous = false): void {
  const definition: ToolDefinition = {
    name,
    label: "Offline MCP lookup",
    description: "Look up an offline fixture.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
  };
  toolRegistry.registerTool({
    entry: {
      name,
      profiles: ["chat", "plan"],
      permission: { danger: dangerous ? "dangerous" : "safe", action: "mcp.call" },
      capabilities: ["read"],
      ui: { verb: "Lookup" },
    },
    definition,
  });
}

function insertSession(
  sessionId: string,
  workspaceId: string,
  missingSessionFile: string,
  title = "session",
): void {
  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(
    `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, cwd, "repo", 1, now, now);
  db.prepare(
    `insert into agent_sessions (
      id, workspace_id, title, cwd, status, runtime, model, pi_session_id, pi_session_file,
      created_at, updated_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    workspaceId,
    title,
    cwd,
    "idle",
    "pi-sdk",
    "mock/model",
    "old-pi-session",
    missingSessionFile,
    now,
    now,
  );
}

function setTaskToolContext(workspaceId: string, sessionId: string, window: unknown): void {
  createAgentRun({ sessionId, prompt: "Direct task-tool invocation test" });
  setAgentToolContext({
    workspaceId,
    cwd,
    sessionId,
    profile: "chat",
    window: window as never,
    emit: vi.fn(),
  });
}

function proposeMemoryForRun(input: {
  sessionId: string;
  workspaceId: string;
  runId: string;
  userMessageId?: string;
  cwd: string;
  title: string;
  claim: string;
  category?: "decision" | "failed_attempt" | "solution" | "task_result";
}) {
  return projectMemory.proposeProjectMemory(
    {
      scope: "project",
      category: input.category ?? "decision",
      title: input.title,
      claim: input.claim,
      evidence: [{ kind: "run" }],
    },
    {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      cwd: input.cwd,
    },
  );
}

function countMemoryCompactionEvents(memoryId: string | undefined, idempotencyKey: string): number {
  if (!memoryId) return 0;
  return (
    getDatabase()
      .prepare(`select count(*) as count from project_memory_events
    where memory_id = ? and idempotency_key = ?`)
      .get(memoryId, idempotencyKey) as { count: number }
  ).count;
}

function insertSubagentSession(
  sessionId: string,
  parentSessionId: string,
  workspaceId: string,
): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (
        id, workspace_id, title, cwd, status, runtime, model, parent_session_id,
        subagent_task, subagent_type, created_at, updated_at
       )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      workspaceId,
      "child",
      cwd,
      "idle",
      "pi-sdk",
      "mock/model",
      parentSessionId,
      "child task",
      "worker",
      now,
      now,
    );
}

async function initGitRepo(): Promise<void> {
  await execFileAsync("git", ["init"], { cwd, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Modus Test"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd, windowsHide: true });
}

async function initGitRepoWithKnownEmptyScope(): Promise<void> {
  await initGitRepo();
  await execFileAsync("git", ["add", "package.json"], { cwd, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "include package manifest"], {
    cwd,
    windowsHide: true,
  });
}

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-pi-runtime-test-"));
  cwd = await mkdtemp(join(tmpdir(), "modus-pi-runtime-cwd-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  mocks.createAgentSession.mockReset();
  vi.mocked(modelService.findModel)
    .mockReset()
    .mockReturnValue(mocks.model as never);
  vi.mocked(modelService.isUsableModelId).mockReset().mockReturnValue(true);
  vi.mocked(modelService.getDefaultModel)
    .mockReset()
    .mockReturnValue(mocks.model as never);
  mocks.setPiSubscriber(undefined);
  mocks.sessionManagerCreate.mockReset().mockImplementation(() => ({ kind: "create" }));
  mocks.sessionManagerOpen.mockClear();
  mocks.settingsManagerInMemory.mockReset().mockImplementation(() => ({}));
  mocks.resourceLoaderOptions = [];
  mocks.globalGuidance = undefined;
  mocks.allowlistedMcpToolNames = [];
  mocks.killManagedProcess.mockClear();
  mocks.listManagedProcesses.mockClear();
  mocks.setManagedProcesses([]);
  mocks.createAgentSession.mockImplementation(async () => ({
    session: createMockPiSession(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
});

describe("PiSdkRuntime", () => {
  afterEach(() => {
    resetFeatureFlagOverrides();
  });

  it("refuses a removed explicit model before creating a session", async () => {
    vi.mocked(modelService.findModel).mockImplementation((modelId) =>
      modelId === "openai/removed-model" ? undefined : (mocks.model as never),
    );
    const getDefaultModel = vi.mocked(modelService.getDefaultModel);
    getDefaultModel.mockClear();

    await expect(
      new PiSdkRuntime().create(createWindowStub(), {
        workspaceId: `workspace-${crypto.randomUUID()}`,
        cwd,
        title: "Selected model",
        model: "openai/removed-model",
      }),
    ).rejects.toThrow("Selected model is unavailable: openai/removed-model");

    expect(getDefaultModel).not.toHaveBeenCalled();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it("refuses an unavailable model with a registry entry", async () => {
    vi.mocked(modelService.isUsableModelId).mockReturnValue(false);
    const getDefaultModel = vi.mocked(modelService.getDefaultModel);
    getDefaultModel.mockClear();

    await expect(
      new PiSdkRuntime().create(createWindowStub(), {
        workspaceId: `workspace-${crypto.randomUUID()}`,
        cwd,
        title: "Unavailable provider",
        model: "mock/model",
      }),
    ).rejects.toThrow("Selected model is unavailable: mock/model");

    expect(getDefaultModel).not.toHaveBeenCalled();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it("refuses a cold resume when the stored model was removed", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    getDatabase()
      .prepare("update agent_sessions set model = ? where id = ?")
      .run("byok/removed-model", sessionId);
    vi.mocked(modelService.findModel).mockImplementation((modelId) =>
      modelId === "byok/removed-model" ? undefined : (mocks.model as never),
    );
    const getDefaultModel = vi.mocked(modelService.getDefaultModel);
    getDefaultModel.mockClear();

    await expect(new PiSdkRuntime().ensure(createWindowStub(), sessionId)).rejects.toThrow(
      "Selected model is unavailable: byok/removed-model",
    );

    expect(getDefaultModel).not.toHaveBeenCalled();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
    const row = getDatabase()
      .prepare("select model from agent_sessions where id = ?")
      .get(sessionId) as { model: string };
    expect(row.model).toBe("byok/removed-model");
  });

  it("rejects a removed per-turn model before the cached session prompt", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const session = createMockPiSession();
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    await runtime.ensure(window, sessionId);
    vi.mocked(modelService.findModel).mockImplementation((modelId) =>
      modelId === "modus/removed-model" ? undefined : (mocks.model as never),
    );

    await expect(
      runtime.prompt(window, {
        context: [],
        message: "Do not send this to another model",
        model: "modus/removed-model",
        sessionId,
      }),
    ).rejects.toThrow("Selected model is unavailable: modus/removed-model");

    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("rejects an unavailable per-turn model before the session prompt", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const session = createMockPiSession();
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    await runtime.ensure(window, sessionId);
    vi.mocked(modelService.isUsableModelId).mockReturnValue(false);

    await expect(
      runtime.prompt(window, {
        context: [],
        message: "Do not send while the selected provider is unavailable",
        model: "mock/model",
        sessionId,
      }),
    ).rejects.toThrow("Selected model is unavailable: mock/model");

    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("lets an explicit model replace a removed model during cold resume", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    getDatabase()
      .prepare("update agent_sessions set model = ? where id = ?")
      .run("openai/removed-model", sessionId);
    vi.mocked(modelService.findModel).mockImplementation((modelId) =>
      modelId === "openai/removed-model" ? undefined : (mocks.model as never),
    );
    const getDefaultModel = vi.mocked(modelService.getDefaultModel);
    getDefaultModel.mockClear();
    const session = createMockPiSession();
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, {
      context: [],
      message: "Use the replacement explicitly",
      model: "mock/model",
      sessionId,
    });

    expect(getDefaultModel).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledWith(mocks.model);
    const row = getDatabase()
      .prepare("select model from agent_sessions where id = ?")
      .get(sessionId) as { model: string };
    expect(row.model).toBe("mock/model");
  });

  it("waits for plugin bootstrap to settle before startup lifecycle sync", async () => {
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const sync = vi.fn(async () => [] as string[]);
    const { PluginLoader } = await import("./harness/plugin/plugin-loader");
    vi.spyOn(PluginLoader.prototype, "load").mockImplementation(async () => {
      await bootstrapGate;
      throw new Error("controlled bootstrap stop");
    });
    const lifecycleSpy = vi
      .spyOn(PiSdkRuntime.prototype, "getPluginLifecycleService")
      .mockReturnValue({
        syncOnStartup: sync,
      } as never);
    setFeatureFlagOverrides({ MODUS_PLUGINS: true, MODUS_PLUGIN_LIFECYCLE: true });
    const runtime = new PiSdkRuntime();
    await Promise.resolve();
    await Promise.resolve();
    expect(sync).not.toHaveBeenCalled();

    releaseBootstrap();
    await runtime.waitForPlugins();
    expect(sync).toHaveBeenCalledOnce();
    lifecycleSpy.mockRestore();
  });

  it("restrictive extension loader", async () => {
    const sessionId = `extension-containment-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      message: "hello",
      sessionId,
    });

    const options = mocks.resourceLoaderOptions.at(-1) as {
      noExtensions?: boolean;
      additionalExtensionPaths?: unknown[];
      cliEnabledExtensions?: unknown[];
      extensionFactories?: unknown[];
    };
    expect(options.noExtensions).toBe(true);
    expect(options.additionalExtensionPaths).toBeUndefined();
    expect(options.cliEnabledExtensions).toBeUndefined();
    expect(options.extensionFactories).toHaveLength(1);
  });

  it.each([
    "selected",
    "original",
  ] as const)("starts a fresh %s HyperPlan build without clarifying an ambiguous plan title", async (api) => {
    const sessionId = `hyperplan-intent-${api}-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Which target is unclear?",
      overview: "The approved plan should start immediately.",
      content: "# Which target is unclear?",
      todos: [
        { id: "first", content: "Implement selected feature" },
        { id: "second", content: "Validate acceptance criteria" },
      ],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const piSession = createMockPiSession();
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: piSession }));
    const operation = {
      ownerId: 601,
      requestId: `intent-${api}`,
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    } as const;
    const started = await hyperPlanDraftStore.runHyperPlanStartOperation({
      ...operation,
      start: (stored, onRunCreated) => {
        const startInput = {
          ...operation,
          idempotencyKey: `intent-${api}`,
          ...(stored.runId ? { existingRunId: stored.runId } : {}),
          onRunCreated,
        };
        return api === "selected"
          ? runtime.startPlanBuild(window, startInput)
          : runtime.startOriginalPlanBuild(window, startInput);
      },
    });

    await vi.waitFor(() =>
      expect(readPlanById(join(userData, "plans"), plan.id)?.buildStatus).toBe("building"),
    );
    await vi.waitFor(() => expect(piSession.prompt).toHaveBeenCalledTimes(1));
    const sentMessage = String((piSession.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(sentMessage).toContain(plan.path);
    expect(sentMessage).toMatch(/single\s+source of truth/);
    expect(sentMessage).toContain("implement it end-to-end");
    expect(sentMessage).toContain("1. Implement selected feature");
    expect(sentMessage).toContain("2. Validate acceptance criteria");
    expect(started.runId).toBeTruthy();
    expect(
      (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.some(
        ([, event]) => (event as AgentEvent).type === "question.requested",
      ),
    ).toBe(false);
  });

  it("rejects an old epoch before it can start through a replacement reservation", async () => {
    const ownerId = 501;
    const sessionId = `hyperplan-aba-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "ABA plan",
      overview: "ABA guard",
      content: "# ABA plan",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const runtime = new PiSdkRuntime();
    const oldEpoch = hyperPlanDraftStore.registerHyperPlanDraftOwner(ownerId);
    const fingerprint = fingerprintPlanSource(plan);
    const oldAttempt = hyperPlanDraftStore.runHyperPlanStartOperation({
      ownerId,
      ownerEpoch: oldEpoch,
      requestId: "same-request",
      kind: "original",
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprint,
      start: (operation, onRunCreated) =>
        runtime.startOriginalPlanBuild(createWindowStub(), {
          ownerId,
          ownerEpoch: oldEpoch,
          requestId: "same-request",
          sessionId,
          planId: plan.id,
          planFingerprint: fingerprint,
          idempotencyKey: "old-epoch-key",
          ...(operation.runId ? { existingRunId: operation.runId } : {}),
          onRunCreated,
        }),
    });
    expect(hyperPlanDraftStore.invalidateHyperPlanDraftOwner(ownerId, oldEpoch)).toBe(true);

    const newEpoch = hyperPlanDraftStore.registerHyperPlanDraftOwner(ownerId);
    let finishNew!: (result: {
      sessionId: string;
      planId: string;
      planFingerprint: string;
      runId: string;
    }) => void;
    const newAttempt = hyperPlanDraftStore.runHyperPlanStartOperation({
      ownerId,
      ownerEpoch: newEpoch,
      requestId: "same-request",
      kind: "original",
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprint,
      start: () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    });
    await expect(oldAttempt).rejects.toThrow(/reservation/i);
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(
      hyperPlanDraftStore.ownsHyperPlanStartReservation({
        ownerId,
        ownerEpoch: newEpoch,
        requestId: "same-request",
        sessionId,
      }),
    ).toBe(true);
    expect(
      hyperPlanDraftStore.ownsHyperPlanStartReservation({
        ownerId,
        ownerEpoch: oldEpoch,
        requestId: "same-request",
        sessionId,
      }),
    ).toBe(false);
    expect(hyperPlanDraftStore.invalidateHyperPlanDraftOwner(ownerId, newEpoch)).toBe(true);
    finishNew({ sessionId, planId: plan.id, planFingerprint: fingerprint, runId: "never-created" });
    await expect(newAttempt).resolves.toMatchObject({ runId: "never-created" });
  });

  it("rejects a HyperPlan start when the selected plan fingerprint is stale", async () => {
    const sessionId = `hyperplan-stale-start-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime() as InstanceType<typeof PiSdkRuntime> & {
      startPlanBuild: (
        window: BrowserWindowType,
        input: {
          sessionId: string;
          planId: string;
          planFingerprint: string;
          requestId: string;
        },
      ) => Promise<{ runId: string }>;
    };

    await expect(
      runtime.startPlanBuild(createWindowStub(), {
        sessionId,
        planId: "missing-plan",
        planFingerprint: "stale-fingerprint",
        requestId: "stale-start",
      }),
    ).rejects.toThrow(/plan|fingerprint|missing/i);
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
  });

  it("starts one fresh HyperPlan run and replays the same run.started after send failure", async () => {
    const sessionId = `hyperplan-start-replay-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plansRoot = join(userData, "plans");
    const plan = writePlan(plansRoot, {
      workspaceId,
      sessionId,
      title: "Exclusive plan",
      overview: "Start exclusively.",
      content: "# Exclusive plan",
      todos: [],
      spec: {
        requirements: [],
        acceptanceCriteria: [],
        assumptions: [],
        openQuestions: [],
      },
    });
    let resolvePiPrompt!: () => void;
    let signalPiPrompt!: () => void;
    const piPromptGate = new Promise<void>((resolve) => {
      resolvePiPrompt = resolve;
    });
    const piPromptCalled = new Promise<void>((resolve) => {
      signalPiPrompt = resolve;
    });
    const piSession = createMockPiSession({
      prompt: () => {
        signalPiPrompt();
        return piPromptGate;
      },
    });
    let resolveCreateSession!: () => void;
    let signalCreateSession!: () => void;
    const createSessionGate = new Promise<void>((resolve) => {
      resolveCreateSession = resolve;
    });
    const createSessionCalled = new Promise<void>((resolve) => {
      signalCreateSession = resolve;
    });
    mocks.createAgentSession.mockImplementationOnce(async () => {
      signalCreateSession();
      await createSessionGate;
      return { session: piSession };
    });
    const window = createWindowStub();
    const send = window.webContents.send as ReturnType<typeof vi.fn>;
    let throwStartedOnce = true;
    send.mockImplementation((_channel: string, event: AgentEvent) => {
      if (event.type === "run.started" && throwStartedOnce) {
        throwStartedOnce = false;
        throw new Error("renderer delivery failed");
      }
    });
    const runtime = new PiSdkRuntime();
    const operation = {
      ownerId: 42,
      requestId: "start-replay-request",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const invoke = (existingRunId?: string) =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(window, {
            ...operation,
            idempotencyKey: "stable-hyperplan-event",
            ...((existingRunId ?? stored.runId)
              ? { existingRunId: existingRunId ?? stored.runId }
              : {}),
            onRunCreated,
          }),
      });

    const firstStart = invoke();
    await createSessionCalled;
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(true);
    await expect(
      runtime.prompt(window, {
        sessionId,
        message: "Must not become a follow-up.",
        context: [],
      }),
    ).rejects.toThrow(/HyperPlan choice is pending/i);
    expect(() =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        requestId: "competing-start-request",
        start: async () => ({
          sessionId,
          planId: plan.id,
          planFingerprint: fingerprintPlanSource(plan),
          runId: "should-not-start",
        }),
      }),
    ).toThrow(/reserved/i);
    resolveCreateSession();
    await expect(firstStart).rejects.toThrow(/delivery failed/i);
    const persistedBeforeReplay = getDatabase()
      .prepare("select id from agent_events where session_id = ? and type = 'run.started'")
      .get(sessionId) as { id: string } | undefined;
    expect(persistedBeforeReplay).toBeDefined();
    const started = await invoke();
    expect(started).toMatchObject({ sessionId, planId: plan.id });
    expect(getAgentRun(started.runId)?.userMessageId).toBe("hyperplan:stable-hyperplan-event");
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(true);
    expect(getActiveAgentRun(sessionId)?.id).toBe(started.runId);
    expect(
      send.mock.calls.some(
        ([, event]) =>
          (event as AgentEvent).type === "session.status" &&
          (event as AgentEvent & { status: { type: string } }).status.type === "idle",
      ),
    ).toBe(false);
    await piPromptCalled;
    resolvePiPrompt();
    await vi.waitFor(() =>
      expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false),
    );
    const rows = getDatabase()
      .prepare(
        "select id, payload_json from agent_events where session_id = ? and type = 'run.started'",
      )
      .all(sessionId) as Array<{ id: string; payload_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(persistedBeforeReplay?.id);
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toMatchObject({
      type: "run.started",
      runId: started.runId,
    });
    expect(
      send.mock.calls.filter(([, event]) => (event as AgentEvent).type === "run.started"),
    ).toHaveLength(2);
    await vi.waitFor(() => expect(piSession.prompt).toHaveBeenCalledTimes(1));
    expect(piSession.prompt).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        streamingBehavior: "followUp",
      }),
    );
  });

  it("releases pre-run reservations and deduplicates a persisted message.started on retry", async () => {
    const sessionId = `hyperplan-message-retry-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Message retry plan",
      overview: "Retry before run creation.",
      content: "# Message retry plan",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const window = createWindowStub();
    const send = window.webContents.send as ReturnType<typeof vi.fn>;
    let failOnce = true;
    send.mockImplementation((_channel: string, event: AgentEvent) => {
      if (event.type === "message.started" && failOnce) {
        failOnce = false;
        throw new Error("message delivery failed after persistence");
      }
    });
    const runtime = new PiSdkRuntime();
    const operation = {
      ownerId: 51,
      requestId: "message-retry-request",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const invoke = () =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (_stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(window, {
            ...operation,
            idempotencyKey: "message-retry-operation",
            onRunCreated,
          }),
      });

    await expect(invoke()).rejects.toThrow(/message delivery failed/i);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
    const before = getDatabase()
      .prepare("select id from agent_events where session_id = ? and type = 'message.started'")
      .all(sessionId) as Array<{ id: string }>;
    expect(before).toHaveLength(1);

    const started = await invoke();
    expect(started.runId).toBeTruthy();
    const after = getDatabase()
      .prepare("select id from agent_events where session_id = ? and type = 'message.started'")
      .all(sessionId) as Array<{ id: string }>;
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("settles the same run when a post-acknowledgement busy send throws", async () => {
    const sessionId = `hyperplan-post-start-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Post-start failure plan",
      overview: "Fail after run.started.",
      content: "# Post-start failure plan",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const window = createWindowStub();
    const send = window.webContents.send as ReturnType<typeof vi.fn>;
    let startedSeen = false;
    send.mockImplementation((_channel: string, event: AgentEvent) => {
      if (event.type === "run.started") startedSeen = true;
      if (event.type === "session.status" && event.status.type === "busy" && startedSeen) {
        throw new Error("post-start busy status delivery failed");
      }
    });
    const runtime = new PiSdkRuntime();
    const operation = {
      ownerId: 52,
      requestId: "post-start-failure-request",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const invoke = () =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(window, {
            ...operation,
            idempotencyKey: "post-start-failure-operation",
            ...(stored.runId ? { existingRunId: stored.runId } : {}),
            onRunCreated,
          }),
      });

    const started = await invoke();
    await vi.waitFor(() => expect(getAgentRun(started.runId)?.status).toBe("failed"));
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(getAgentSession(sessionId)?.status).toBe("idle");
    expect(readPlanById(join(userData, "plans"), plan.id)?.buildStatus).toBe("not_built");
    expect(
      (runtime as unknown as { runOutputTrackers: Map<string, unknown> }).runOutputTrackers.has(
        sessionId,
      ),
    ).toBe(false);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
    expect((await invoke()).runId).toBe(started.runId);
    expect((await runtime.listRuns(sessionId)).map((run) => run.id)).toEqual([started.runId]);
    expect(
      getDatabase()
        .prepare("select type from agent_events where session_id = ? and type = 'run.failed'")
        .all(sessionId),
    ).toHaveLength(1);
  });

  it("settles a created HyperPlan run when reading its spec fails before run.started", async () => {
    const sessionId = `hyperplan-spec-read-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Spec read failure",
      overview: "Fail during post-create setup.",
      content: "# Spec read failure",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const runtime = new PiSdkRuntime();
    const originalCreate = createAgentRun;
    let createdRunId: string | undefined;
    const createSpy = vi.spyOn(await import("./agent-run-store"), "createAgentRun");
    createSpy.mockImplementation((input) => {
      const run = originalCreate(input);
      createdRunId = run.id;
      return run;
    });
    const originalRead = readPlanById;
    const readSpy = vi.spyOn(await import("../plan/plan-store"), "readPlanById");
    readSpy.mockImplementation((root, id) => {
      if (createdRunId) throw new Error("plan spec read failed");
      return originalRead(root, id);
    });
    const operation = {
      ownerId: 55,
      requestId: "spec-read-failure-request",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };

    await expect(
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (_stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(createWindowStub(), {
            ...operation,
            idempotencyKey: "spec-read-failure-operation",
            onRunCreated,
          }),
      }),
    ).rejects.toThrow("plan spec read failed");

    expect(createdRunId).toBeDefined();
    const failedRun = createdRunId ? getAgentRun(createdRunId) : undefined;
    expect(failedRun?.status).toBe("failed");
    readSpy.mockRestore();
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(getAgentSession(sessionId)?.status).toBe("idle");
    expect(readPlanById(join(userData, "plans"), plan.id)?.buildStatus).toBe("not_built");
    expect(
      (runtime as unknown as { runOutputTrackers: Map<string, unknown> }).runOutputTrackers.has(
        sessionId,
      ),
    ).toBe(false);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
    expect((await runtime.listRuns(sessionId)).map((run) => run.id)).toEqual([createdRunId]);
    expect(
      getDatabase()
        .prepare("select type from agent_events where session_id = ? and type = 'run.failed'")
        .all(sessionId),
    ).toHaveLength(1);
    expect(
      getDatabase()
        .prepare("select id from agent_events where session_id = ? and type = 'run.started'")
        .all(sessionId),
    ).toHaveLength(0);
  });

  it("settles a legacy run when post-create setup fails before run.started without a phantom failure event", async () => {
    const sessionId = `legacy-post-create-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const window = createWindowStub();
    const runtime = new PiSdkRuntime();
    const setupSpy = vi
      .spyOn(runtime as unknown as { specBuildPlan: () => unknown }, "specBuildPlan")
      .mockImplementation(() => {
        throw new Error("legacy setup failed");
      });

    await expect(
      runtime.prompt(window, { sessionId, message: "Legacy prompt", context: [] }),
    ).rejects.toThrow("legacy setup failed");

    setupSpy.mockRestore();
    const runs = await runtime.listRuns(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(getAgentSession(sessionId)?.status).toBe("error");
    const types = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, event]) => (event as AgentEvent).type,
    );
    expect(types).toContain("runtime.error");
    expect(types).toContain("session.status");
    expect(types).not.toContain("run.failed");
    expect(
      (runtime as unknown as { runOutputTrackers: Map<string, unknown> }).runOutputTrackers.has(
        sessionId,
      ),
    ).toBe(false);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
  });

  it("settles a legacy run when run.started persists but its delivery throws", async () => {
    const sessionId = `legacy-started-delivery-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: AgentEvent) => {
        if (event.type === "run.started") throw new Error("started delivery failed");
      },
    );
    const runtime = new PiSdkRuntime();

    await expect(
      runtime.prompt(window, { sessionId, message: "Legacy prompt", context: [] }),
    ).rejects.toThrow("started delivery failed");

    const runs = await runtime.listRuns(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(getAgentSession(sessionId)?.status).toBe("error");
    expect(
      getDatabase()
        .prepare("select type from agent_events where session_id = ? and type = 'run.started'")
        .all(sessionId),
    ).toHaveLength(1);
    expect(
      getDatabase()
        .prepare("select type from agent_events where session_id = ? and type = 'run.failed'")
        .all(sessionId),
    ).toHaveLength(1);
    expect(
      (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.some(
        ([, event]) =>
          (event as AgentEvent).type === "session.status" && event.status.type === "idle",
      ),
    ).toBe(true);
    expect(
      (runtime as unknown as { runOutputTrackers: Map<string, unknown> }).runOutputTrackers.has(
        sessionId,
      ),
    ).toBe(false);
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
  });

  it("settles a replayed HyperPlan run when setup fails before this attempt emits run.started", async () => {
    const sessionId = `hyperplan-replay-setup-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Replay setup failure",
      overview: "Fail setup on replay.",
      content: "# Replay setup failure",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const window = createWindowStub();
    const send = window.webContents.send as ReturnType<typeof vi.fn>;
    let throwStarted = true;
    send.mockImplementation((_channel: string, event: AgentEvent) => {
      if (event.type === "run.started" && throwStarted) {
        throwStarted = false;
        throw new Error("started delivery failed");
      }
    });
    const runtime = new PiSdkRuntime();
    let setupCalls = 0;
    vi.spyOn(
      runtime as unknown as { specBuildPlan: () => unknown },
      "specBuildPlan",
    ).mockImplementation(() => {
      setupCalls += 1;
      if (setupCalls === 2) throw new Error("replay setup failed");
      return undefined;
    });
    const operation = {
      ownerId: 56,
      requestId: "replay-setup-failure",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const invoke = () =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(window, {
            ...operation,
            idempotencyKey: "replay-setup-failure",
            ...(stored.runId ? { existingRunId: stored.runId } : {}),
            onRunCreated,
          }),
      });

    await expect(invoke()).rejects.toThrow("started delivery failed");
    const originalRunId = (await runtime.listRuns(sessionId))[0]?.id;
    expect(originalRunId).toBeDefined();
    await expect(invoke()).rejects.toThrow("replay setup failed");

    expect((await runtime.listRuns(sessionId)).map(({ id }) => id)).toEqual([originalRunId]);
    expect(getAgentRun(originalRunId ?? "")?.status).toBe("failed");
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(
      (runtime as unknown as { runOutputTrackers: Map<string, unknown> }).runOutputTrackers.has(
        sessionId,
      ),
    ).toBe(false);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(
      getDatabase()
        .prepare("select type from agent_events where session_id = ? and type = 'run.started'")
        .all(sessionId),
    ).toHaveLength(1);
    expect(
      getDatabase()
        .prepare("select type from agent_events where session_id = ? and type = 'run.failed'")
        .all(sessionId),
    ).toHaveLength(1);
  });

  it("settles and releases a HyperPlan run when building status delivery fails", async () => {
    const sessionId = `hyperplan-building-send-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Building delivery failure",
      overview: "Fail after run start.",
      content: "# Building delivery failure",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const window = createWindowStub();
    const send = window.webContents.send as ReturnType<typeof vi.fn>;
    send.mockImplementation((_channel: string, event: AgentEvent) => {
      if (event.type === "plan.updated" && event.plan.buildStatus === "building") {
        throw new Error("building status delivery failed");
      }
      if (event.type === "run.failed") throw new Error("terminal delivery failed");
    });
    const runtime = new PiSdkRuntime();
    const operation = {
      ownerId: 53,
      requestId: "building-send-failure",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const started = await hyperPlanDraftStore.runHyperPlanStartOperation({
      ...operation,
      start: (_stored, onRunCreated) =>
        runtime.startOriginalPlanBuild(window, {
          ...operation,
          idempotencyKey: "building-send-failure",
          onRunCreated,
        }),
    });

    await vi.waitFor(() => expect(getAgentRun(started.runId)?.status).toBe("failed"));
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(getAgentSession(sessionId)?.status).toBe("idle");
    expect(readPlanById(join(userData, "plans"), plan.id)?.buildStatus).toBe("not_built");
    expect(
      (runtime as unknown as { runOutputTrackers: Map<string, unknown> }).runOutputTrackers.has(
        sessionId,
      ),
    ).toBe(false);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
    expect((await runtime.listRuns(sessionId)).map((run) => run.id)).toEqual([started.runId]);
    const events = send.mock.calls.map(([, event]) => event as AgentEvent);
    const terminalIndex = events.findIndex((event) => event.type === "run.failed");
    const runtimeErrorIndex = events.findIndex((event) => event.type === "runtime.error");
    const idleIndex = events.findIndex(
      (event) => event.type === "session.status" && event.status.type === "idle",
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeErrorIndex).toBeGreaterThan(terminalIndex);
    expect(idleIndex).toBeGreaterThan(runtimeErrorIndex);
  });

  it.each([
    1, 2,
  ])("cleans up preflight and HyperPlan reservations when executePrompt plan read %i throws", async (readPoint) => {
    const sessionId = `hyperplan-preflight-read-${readPoint}-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Preflight read failure",
      overview: "Fail while preparing the build.",
      content: "# Preflight read failure",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const runtime = new PiSdkRuntime();
    const originalRead = readPlanById;
    const readSpy = vi.spyOn(await import("../plan/plan-store"), "readPlanById");
    let readsDuringPreflight = 0;
    let injected = false;
    readSpy.mockImplementation((root, id) => {
      const hasReservation = (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId);
      if (hasReservation) {
        readsDuringPreflight += 1;
        if (readsDuringPreflight === readPoint) {
          injected = true;
          throw new Error(`plan preflight read ${readPoint} failed`);
        }
      }
      return originalRead(root, id);
    });
    const operation = {
      ownerId: 57 + readPoint,
      requestId: `preflight-read-${readPoint}`,
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const invoke = () =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (_stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(createWindowStub(), {
            ...operation,
            idempotencyKey: `preflight-read-${readPoint}`,
            onRunCreated,
          }),
      });

    await expect(invoke()).rejects.toThrow(`plan preflight read ${readPoint} failed`);
    expect(injected).toBe(true);
    expect(await runtime.listRuns(sessionId)).toHaveLength(0);
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);

    readSpy.mockRestore();
    const retry = await invoke();
    expect(retry.runId).toBeTruthy();
    expect(getAgentRun(retry.runId)?.sessionId).toBe(sessionId);
  });

  it("releases only its preflight reservation when run creation fails and allows retry", async () => {
    const sessionId = `hyperplan-run-create-failure-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Run creation failure",
      overview: "Retry before run creation.",
      content: "# Run creation failure",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    const runtime = new PiSdkRuntime();
    const operation = {
      ownerId: 54,
      requestId: "run-create-failure",
      kind: "original" as const,
      sessionId,
      planId: plan.id,
      planFingerprint: fingerprintPlanSource(plan),
    };
    const runStore = await import("./agent-run-store");
    const createSpy = vi.spyOn(runStore, "createAgentRun").mockImplementationOnce(() => {
      throw new Error("run database unavailable");
    });
    const invoke = () =>
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ...operation,
        start: (_stored, onRunCreated) =>
          runtime.startOriginalPlanBuild(createWindowStub(), {
            ...operation,
            idempotencyKey: "run-create-failure",
            onRunCreated,
          }),
      });

    await expect(invoke()).rejects.toThrow(/run database unavailable/i);
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(await runtime.listRuns(sessionId)).toHaveLength(0);
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
    createSpy.mockRestore();
    const retry = await invoke();
    expect(getAgentRun(retry.runId)).toMatchObject({ id: retry.runId, sessionId });
    await vi.waitFor(() =>
      expect(
        (
          runtime as unknown as { preflightReservations: Map<string, symbol> }
        ).preflightReservations.has(sessionId),
      ).toBe(false),
    );
  });

  it("rejects a HyperPlan build start when an authoritative run is already active", async () => {
    const sessionId = `hyperplan-busy-start-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Busy plan",
      overview: "Busy guard.",
      content: "# Busy plan",
      todos: [],
      spec: {
        requirements: [],
        acceptanceCriteria: [],
        assumptions: [],
        openQuestions: [],
      },
    });
    const activeRun = createAgentRun({ sessionId, prompt: "Existing work" });
    const runtime = new PiSdkRuntime();
    await expect(
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ownerId: 43,
        requestId: "busy-start",
        kind: "original",
        sessionId,
        planId: plan.id,
        planFingerprint: fingerprintPlanSource(plan),
        start: (_operation, onRunCreated) =>
          runtime.startOriginalPlanBuild(createWindowStub(), {
            ownerId: 43,
            requestId: "busy-start",
            sessionId,
            planId: plan.id,
            planFingerprint: fingerprintPlanSource(plan),
            idempotencyKey: "busy-start",
            onRunCreated,
          }),
      }),
    ).rejects.toThrow(/busy/i);
    expect(getActiveAgentRun(sessionId)?.id).toBe(activeRun.id);
    expect(hyperPlanDraftStore.isHyperPlanSessionReserved(sessionId)).toBe(false);
  });

  it("publishes a promoted plan through the persisted runtime event path", () => {
    const sessionId = `hyperplan-event-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const window = createWindowStub();
    const runtime = new PiSdkRuntime();
    const plan: PlanRef = {
      id: "plan-1",
      sessionId,
      workspaceId,
      title: "Promoted",
      overview: "Published by runtime.",
      path: join(userData, "plan.md"),
      hash: "hash",
      blocks: [{ type: "markdown", content: "# Promoted" }],
      content: "# Promoted",
      todos: [],
      buildStatus: "not_built",
      createdAt: "created",
      updatedAt: "updated",
    };

    runtime.publishPlanUpdated(window, sessionId, plan);

    expect(listAgentEvents(sessionId).at(-1)?.event).toEqual({
      type: "plan.updated",
      sessionId,
      plan,
      eventCursor: expect.any(Number),
    });
    expect(window.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.any(String),
      { type: "plan.updated", sessionId, plan, eventCursor: expect.any(Number) },
    );
  });

  it("persists at most one plan update across a failed delivery and keyed retry", () => {
    const sessionId = `hyperplan-delivery-retry-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const window = createWindowStub();
    const send = window.webContents.send as ReturnType<typeof vi.fn>;
    send.mockImplementationOnce(() => {
      throw new Error("renderer delivery failed");
    });
    const runtime = new PiSdkRuntime();
    const plan: PlanRef = {
      id: "plan-1",
      sessionId,
      workspaceId,
      title: "Promoted",
      overview: "Published by runtime.",
      path: join(userData, "plan.md"),
      hash: "hash",
      blocks: [{ type: "markdown", content: "# Promoted" }],
      content: "# Promoted",
      todos: [],
      buildStatus: "not_built",
      createdAt: "created",
      updatedAt: "updated",
    };
    const selectionId = `selection-${crypto.randomUUID()}`;
    const retry = () => runtime.publishPlanUpdated(window, sessionId, plan, selectionId);

    expect(retry).toThrow(/delivery failed/i);
    expect(() => retry()).not.toThrow();

    const persisted = getDatabase()
      .prepare(
        "select count(*) as count from agent_events where session_id = ? and type = 'plan.updated'",
      )
      .get(sessionId) as { count: number };
    expect(persisted.count).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.any(String), {
      type: "plan.updated",
      sessionId,
      plan,
      eventCursor: expect.any(Number),
    });
  });

  it("rejects generic prompts while a HyperPlan selection reserves the session", async () => {
    const sessionId = `hyperplan-reserved-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const window = createWindowStub();
    expect(hyperPlanDraftStore.reserveHyperPlanSession({ sessionId, ownerId: 4 })).toBe(true);

    await expect(
      new PiSdkRuntime().prompt(window, {
        sessionId,
        message: "Continue with another task.",
        context: [],
      }),
    ).rejects.toThrow(/HyperPlan choice/i);
    expect(window.webContents.send).not.toHaveBeenCalled();
    hyperPlanDraftStore.releaseHyperPlanSession({ sessionId, ownerId: 4 });
  });

  it("rejects HyperPlan operations while an authoritative run is active", () => {
    const sessionId = `hyperplan-busy-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const run = createAgentRun({ sessionId, prompt: "Active work" });

    expect(() => new PiSdkRuntime().assertHyperPlanSessionAvailable(sessionId)).toThrow(/busy/i);

    updateAgentRunStatus(run.id, "failed");
  });

  it("activates the group member tools only for group members; the tool context carries groupId", async () => {
    const { createAgentGroupWithMembers } = await import("../groups/group-store");
    const { GROUP_TOOL_NAMES } = await import("./tools/group-tools");
    const member = `group-member-${crypto.randomUUID()}`;
    const loner = `group-loner-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(member, workspaceId, join(userData, "missing.jsonl"));
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(loner, workspaceId, "loner", cwd, "idle", now, now);
    const partner = `group-partner-${crypto.randomUUID()}`;
    getDatabase()
      .prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(partner, workspaceId, "partner", cwd, "idle", now, now);
    const group = createAgentGroupWithMembers({
      name: "Squad",
      workspaceId,
      members: [{ sessionId: member }, { sessionId: partner }],
    });
    const runtime = new PiSdkRuntime(); // registers the process-wide tools
    const info = (id: string) => ({
      id,
      workspaceId,
      title: "chat",
      cwd,
      status: "idle" as const,
      createdAt: "",
      updatedAt: "",
    });

    expect(activeToolNamesForSession(info(member), "chat")).toEqual(
      expect.arrayContaining([...GROUP_TOOL_NAMES]),
    );
    const getActiveToolNames = (
      runtime as unknown as {
        getActiveToolNames?: (sessionId: string, profile: "chat" | "plan") => readonly string[];
      }
    ).getActiveToolNames;
    expect(getActiveToolNames?.call(runtime, member, "chat")).toEqual(
      activeToolNamesForSession(info(member), "chat"),
    );
    // Plan mode keeps only the read-only ones.
    expect(
      activeToolNamesForSession(info(member), "plan").filter((name) => name.startsWith("group_")),
    ).toEqual(["group_read_messages", "group_list_tasks", "group_get_work_state"]);
    for (const profile of ["chat", "plan"] as const) {
      expect(
        activeToolNamesForSession(info(loner), profile).filter((name) =>
          (GROUP_TOOL_NAMES as readonly string[]).includes(name),
        ),
      ).toEqual([]);
    }

    const toolContextFor = (
      runtime as unknown as {
        toolContextFor(session: unknown, window: unknown, profile: string, mode?: string): unknown;
      }
    ).toolContextFor.bind(runtime);
    const window = createWindowStub();
    expect(toolContextFor({ info: info(member), emit: vi.fn() }, window, "chat")).toMatchObject({
      sessionId: member,
      groupId: group.id,
    });
    expect(toolContextFor({ info: info(loner), emit: vi.fn() }, window, "chat")).not.toHaveProperty(
      "groupId",
    );
  });

  it("adds allowlisted MCP tools only to librarian sessions selecting the sentinel", async () => {
    const registeredName = "mcp_docs_search";
    mocks.allowlistedMcpToolNames = [registeredName];
    toolRegistry.registerTool({
      entry: {
        name: registeredName,
        profiles: ["chat", "plan"],
        permission: { danger: "safe" },
        capabilities: ["read"],
        ui: { verb: "Search" },
      },
      definition: { name: registeredName } as never,
    });
    const info = {
      id: "librarian-child",
      workspaceId: "workspace",
      title: "Librarian",
      cwd,
      status: "idle" as const,
      parentSessionId: "missing-parent",
      subagentType: "librarian",
      createdAt: "",
      updatedAt: "",
    };

    try {
      expect(activeToolNamesForSession(info, "chat")).toContain(registeredName);
      expect(
        activeToolNamesForSession({ ...info, subagentType: "reviewer" }, "chat"),
      ).not.toContain(registeredName);

      const agentsDir = join(cwd, ".modus", "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, "librarian.md"),
        "---\nname: librarian\ntools: read, grep, find, ls\n---\nWorkspace librarian override.",
      );
      expect(activeToolNamesForSession(info, "chat")).not.toContain(registeredName);
    } finally {
      toolRegistry.unregisterTool(registeredName);
    }
  });

  it("reports active turns only while a prompt is running", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    let activeDuringPrompt: boolean | undefined;
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        activeDuringPrompt = runtime.hasActiveTurns();
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    expect(runtime.hasActiveTurns()).toBe(false);
    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Fix a typo",
      sessionId,
    });

    expect(activeDuringPrompt).toBe(true);
    expect(runtime.hasActiveTurns()).toBe(false);
  });

  it("counts running background subagents as active turns", () => {
    const runtime = new PiSdkRuntime();
    const backgroundTasks = (
      runtime as unknown as {
        backgroundChildTasks: Map<
          string,
          { parentSessionId: string; task: string; status: "running" | "completed" }
        >;
      }
    ).backgroundChildTasks;
    backgroundTasks.set("child", { parentSessionId: "parent", task: "t", status: "completed" });
    expect(runtime.hasActiveTurns()).toBe(false);
    backgroundTasks.set("child", { parentSessionId: "parent", task: "t", status: "running" });
    expect(runtime.hasActiveTurns()).toBe(true);
  });

  it("expires MCP citations when a run completes", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    let citationId = "";
    let runId = "";
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        const run = getActiveAgentRun(sessionId);
        if (!run) throw new Error("expected active run for citation ownership");
        runId = run.id;
        const citation = mcpCitations.registerMcpCitations(sessionId, run.id, "docs", "search", {
          content: [
            { type: "resource_link", uri: "https://runtime.example.test/guide", name: "Guide" },
          ],
        } as never)[0];
        citationId = citation?.id ?? "";
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Completed." },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();

    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Fix a typo",
      sessionId,
    });

    expect(citationId).not.toBe("");
    expect(mcpCitations.resolveMcpCitation(sessionId, runId, citationId)).toBeUndefined();
  });

  it("expires MCP citations when an active run is aborted", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    let rejectPrompt: ((error: Error) => void) | undefined;
    let notifyCitationCreated: (() => void) | undefined;
    let citationId = "";
    const citationCreated = new Promise<void>((resolve) => {
      notifyCitationCreated = resolve;
    });
    const session = createMockPiSession({
      abort: vi.fn(async () => rejectPrompt?.(new Error("Aborted"))),
      prompt: vi.fn(() => {
        const run = getActiveAgentRun(sessionId);
        if (!run) throw new Error("expected active run for citation ownership");
        citationId =
          mcpCitations.registerMcpCitations(sessionId, run.id, "docs", "search", {
            content: [
              { type: "resource_link", uri: "https://runtime.example.test/abort", name: "Abort" },
            ],
          } as never)[0]?.id ?? "";
        notifyCitationCreated?.();
        return new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const prompt = runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Fix a typo",
      sessionId,
    });
    await citationCreated;
    const runId = getActiveAgentRun(sessionId)?.id;
    expect(runId).toBeDefined();

    expect(runtime.isSessionStreaming(sessionId)).toBe(session.isStreaming === true);
    await runtime.abort(sessionId);
    expect(await prompt).toEqual({ outcome: "aborted" });

    expect(citationId).not.toBe("");
    expect(mcpCitations.resolveMcpCitation(sessionId, runId ?? "", citationId)).toBeUndefined();
  });

  it("continues actionable todos once under the original root run and persists the attempt", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const prompts: string[] = [];
    let promptCount = 0;
    let rootRunId: string | undefined;
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        promptCount += 1;
        prompts.push(message);
        const rootRun = getActiveAgentRun(sessionId);
        if (!rootRun) throw new Error("expected current root run");
        rootRunId ??= rootRun.id;
        if (promptCount === 1) {
          recordAgentEvent({
            type: "todos.updated",
            sessionId,
            todos: [{ id: "todo-1", content: "Finish implementation", status: "pending" }],
          });
        }
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: `response ${promptCount}` },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Implement the feature",
      sessionId,
      userMessageId: "todo-root-user",
    });

    expect(promptCount).toBe(2);
    expect(prompts[1]).toContain("Continue the remaining actionable to-dos");
    const markers = getDatabase()
      .prepare(
        "select payload_json from agent_events where session_id = ? and type = 'harness.continuation'",
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0]?.payload_json ?? "{}")).toMatchObject({
      type: "harness.continuation",
      runId: rootRunId,
      attempt: 1,
      reasonCode: "actionable_todos",
    });
    expect(markers[0]?.payload_json).not.toContain("Implement the feature");
  });

  it("records the tool-call count of each assistant message_end (group_start_worktree must be alone)", async () => {
    const { lastAssistantToolCallCount } = await import("./tools/tool-batch");
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const seen: Array<number | undefined> = [];
    const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({
          type: "message_end",
          message: { role: "assistant", content: [toolCall("a"), toolCall("b")] },
        });
        // What a tool of that batch would read while it executes.
        seen.push(lastAssistantToolCallCount(sessionId));
        mocks.emitPiEvent({
          type: "message_end",
          message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
        });
        mocks.emitPiEvent({
          type: "message_end",
          message: { role: "assistant", content: [toolCall("c")] },
        });
        seen.push(lastAssistantToolCallCount(sessionId));
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();

    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "go",
      sessionId,
      userMessageId: "tool-batch-user",
    });

    expect(seen).toEqual([2, 1]);
    await runtime.releaseRuntime(sessionId);
    expect(lastAssistantToolCallCount(sessionId)).toBeUndefined();
  });

  it("does not auto-continue a turn whose stored cwd moved (member worktree); the turn is ok", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const moved = await mkdtemp(join(tmpdir(), "modus-pi-runtime-moved-"));
    let promptCount = 0;
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        promptCount += 1;
        recordAgentEvent({
          type: "todos.updated",
          sessionId,
          todos: [{ id: "todo-1", content: "Finish implementation", status: "pending" }],
        });
        // What group_start_worktree does mid-turn.
        getDatabase()
          .prepare("update agent_sessions set cwd = ? where id = ?")
          .run(moved, sessionId);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "moving to my worktree" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    const result = await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Implement the feature",
      sessionId,
      userMessageId: "cwd-moved-user",
    });

    expect(promptCount).toBe(1);
    expect(result.outcome).toBe("ok");
    await rm(moved, { recursive: true, force: true });
  });

  it.each([
    [false, "passed"],
    [true, "failed"],
  ] as const)("emits structured QA for a completed test tool call (error=%s)", async (isError, status) => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await initGitRepoWithKnownEmptyScope();
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({
          type: "tool_execution_start",
          toolCallId: "qa-terminal-call",
          toolName: "terminal_run",
          args: { command: "npm test" },
        });
        mocks.emitPiEvent({
          type: "tool_execution_end",
          toolCallId: "qa-terminal-call",
          toolName: "terminal_run",
          isError,
          result: { details: { exitCode: isError ? 1 : 0 } },
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Check completed" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
    });

    const qaPayload = (
      getDatabase()
        .prepare(
          "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
        )
        .get(sessionId) as { payload_json: string }
    ).payload_json;
    expect(JSON.parse(qaPayload)).toMatchObject({
      type: "harness.qa",
      result: {
        required: true,
        status,
        evidence: [expect.objectContaining({ label: "Tests", status })],
      },
    });
    expect(qaPayload).not.toContain("npm test");
  });

  it("does not accept scoped passing QA when the run change scope is unavailable", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({
          type: "tool_execution_start",
          toolCallId: "qa-scoped-call",
          toolName: "terminal_run",
          args: { command: "npm test", paths: ["src/changed.test.ts"] },
        });
        mocks.emitPiEvent({
          type: "tool_execution_end",
          toolCallId: "qa-scoped-call",
          toolName: "terminal_run",
          isError: false,
          result: { details: { exitCode: 0 } },
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Check completed" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
    });

    const qaPayload = (
      getDatabase()
        .prepare(
          "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
        )
        .get(sessionId) as { payload_json: string }
    ).payload_json;
    expect(JSON.parse(qaPayload)).toMatchObject({
      result: {
        required: true,
        status: "unavailable",
        evidence: [expect.objectContaining({ label: "Tests", status: "unavailable" })],
      },
    });
  });

  it("uses the shared continuation budget once when a requested QA check is missing", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run --root ." } }),
    );
    let promptCount = 0;
    const prompts: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        promptCount += 1;
        prompts.push(message);
        if (promptCount === 1) {
          mocks.emitPiEvent({
            type: "tool_execution_start",
            toolCallId: "missing-result-test-call",
            toolName: "terminal_run",
            args: { command: "npm test" },
          });
        }
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: `No check yet ${promptCount}` },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests for this change",
      sessionId,
    });

    expect(promptCount).toBe(2);
    expect(prompts[1]).toContain("Eligible existing project check scripts: test");
    expect(prompts[1]).not.toContain("vitest run --root .");
    const events = getDatabase()
      .prepare(
        "select type, payload_json from agent_events where session_id = ? and type in ('harness.continuation', 'harness.qa')",
      )
      .all(sessionId) as Array<{ type: string; payload_json: string }>;
    const markers = events.filter((event) => event.type === "harness.continuation");
    const qa = events.filter((event) => event.type === "harness.qa");
    expect(markers).toHaveLength(1);
    expect(JSON.parse(markers[0]?.payload_json ?? "{}")).toMatchObject({
      attempt: 1,
      reasonCode: "missing_qa",
    });
    expect(qa).toHaveLength(1);
    expect(JSON.parse(qa[0]?.payload_json ?? "{}")).toMatchObject({
      result: { required: true, status: "unavailable", reasonCode: "required_check_unavailable" },
    });
  });

  it("does not spend the QA continuation budget when no trusted project check script exists", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest list", lint: "eslint --fix ." } }),
    );
    const modelPrompt = vi.fn(async () => {
      mocks.emitPiEvent({
        type: "tool_execution_start",
        toolCallId: "listed-tests-call",
        toolName: "terminal_run",
        args: { command: "npm test" },
      });
      mocks.emitPiEvent({
        type: "tool_execution_end",
        toolCallId: "listed-tests-call",
        toolName: "terminal_run",
        isError: false,
        result: { details: { exitCode: 0 } },
      });
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "No known test script" },
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt: modelPrompt }),
    }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
    });

    expect(modelPrompt).toHaveBeenCalledTimes(1);
    expect(
      (
        getDatabase()
          .prepare(
            "select count(*) as count from agent_events where session_id = ? and type = 'harness.continuation'",
          )
          .get(sessionId) as { count: number }
      ).count,
    ).toBe(0);
    const taskStateEvents = listAgentEvents(sessionId).filter(
      ({ event }) => event.type === "harness.task_state",
    );
    const runStartedEvents = listAgentEvents(sessionId).filter(
      ({ event }) => event.type === "run.started",
    );
    const firstStartedEvent = runStartedEvents[0]?.event;
    expect(runStartedEvents).toHaveLength(1);
    expect(taskStateEvents.length).toBeGreaterThan(0);
    expect(
      new Set(
        taskStateEvents.map(({ event }) =>
          event.type === "harness.task_state" ? event.runId : "",
        ),
      ).size,
    ).toBe(1);
    expect(
      taskStateEvents.every(
        ({ event }) =>
          event.type === "harness.task_state" &&
          firstStartedEvent?.type === "run.started" &&
          event.runId === firstStartedEvent.runId,
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        (
          getDatabase()
            .prepare(
              "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
            )
            .get(sessionId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ result: { status: "unavailable", required: true } });
  });

  it.each([
    ["rejects a posttest hook that mutates source", "eslint --fix .", false],
    ["allows a safe script without lifecycle hooks", undefined, true],
  ] as const)("%s", async (_label, posttest, eligible) => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", ...(posttest ? { posttest } : {}) },
      }),
    );
    const prompts: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        prompts.push(message);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "No test evidence" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
    });

    if (eligible) {
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Eligible existing project check scripts: test");
    } else {
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain("Eligible existing project check scripts: test");
    }
  });

  it("does not offer package check scripts whose bodies contain shell expansion", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run $VITEST_FLAGS" } }),
    );
    const prompts: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        prompts.push(message);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "No test evidence" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Eligible existing project check scripts: test");
  });

  it("does not use a check script from a package outside the declared workspace set", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await mkdir(join(cwd, "apps", "desktop"), { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await writeFile(
      join(cwd, "apps", "desktop", "package.json"),
      JSON.stringify({ name: "@modus/desktop", scripts: { typecheck: "tsc -p tsconfig.json" } }),
    );
    const modelPrompt = vi.fn(async () => {
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "No declared typecheck workspace" },
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt: modelPrompt }),
    }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run typecheck",
      sessionId,
    });

    expect(modelPrompt).toHaveBeenCalledTimes(1);
    expect(
      (
        getDatabase()
          .prepare(
            "select count(*) as count from agent_events where session_id = ? and type = 'harness.continuation'",
          )
          .get(sessionId) as { count: number }
      ).count,
    ).toBe(0);
  });

  it("discovers bounded declared workspace scripts and passes only the exact eligible command", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await mkdir(join(cwd, "apps", "desktop"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ workspaces: ["apps/*"], scripts: { build: "build-root" } }),
    );
    await writeFile(
      join(cwd, "apps", "desktop", "package.json"),
      JSON.stringify({ name: "@modus/desktop", scripts: { typecheck: "tsc -p tsconfig.json" } }),
    );
    const prompts: string[] = [];
    let calls = 0;
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        calls += 1;
        prompts.push(message);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: `response ${calls}` },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run typecheck",
      sessionId,
    });

    expect(calls).toBe(2);
    expect(prompts[1]).toContain("npm --workspace @modus/desktop run typecheck");
    expect(prompts[1]).not.toContain("tsc -p tsconfig.json");
    expect(prompts[1]).not.toContain("build-root");
  });

  it("records not_required for a simple run without requested checks", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "Done" },
          });
        }),
      }),
    }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Fix a typo",
      sessionId,
    });

    expect(
      JSON.parse(
        (
          getDatabase()
            .prepare(
              "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
            )
            .get(sessionId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ result: { required: false, status: "not_required", evidence: [] } });
  });

  it("does not require or retry a check explicitly negated in the Build request", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const modelPrompt = vi.fn(async () => {
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "I will not run tests." },
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt: modelPrompt }),
    }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Do not run tests",
      sessionId,
    });

    expect(modelPrompt).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        (
          getDatabase()
            .prepare(
              "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
            )
            .get(sessionId) as { payload_json: string }
        ).payload_json,
      ),
    ).toMatchObject({ result: { required: false, status: "not_required" } });
    expect(
      (
        getDatabase()
          .prepare(
            "select count(*) as count from agent_events where session_id = ? and type = 'harness.continuation'",
          )
          .get(sessionId) as { count: number }
      ).count,
    ).toBe(0);
  });

  it("keeps an affirmative tests request when a different check is negated", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
    );
    const prompts: string[] = [];
    const modelPrompt = vi.fn(async (message: string) => {
      prompts.push(message);
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "No check result." },
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt: modelPrompt }),
    }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Don't run typecheck, but run tests",
      sessionId,
    });

    expect(modelPrompt).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("Eligible existing project check scripts: test");
    expect(prompts[1]).not.toContain("typecheck");
    const qa = JSON.parse(
      (
        getDatabase()
          .prepare(
            "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
          )
          .get(sessionId) as { payload_json: string }
      ).payload_json,
    ) as { result: { evidence: Array<{ label: string }> } };
    expect(qa.result.evidence.map((ref) => ref.label)).toEqual(["Tests"]);
  });

  it.each([
    ["Run tests, but don't run typecheck", "test", "typecheck"],
    ["Don't run tests, but run typecheck", "typecheck", "test"],
    ["Run tests and skip typecheck", "test", "typecheck"],
    ["Run tests and typecheck", "test, typecheck", "lint"],
  ])("limits continuation QA guidance to the affirmative clause in %s", async (message, allowed, prohibited) => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
    );
    const prompts: string[] = [];
    const modelPrompt = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "No check result." },
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt: modelPrompt }),
    }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message,
      sessionId,
    });

    expect(modelPrompt).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain(`Eligible existing project check scripts: ${allowed}`);
    expect(prompts[1]).not.toContain(prohibited);
  });

  it("marks a started check unavailable when its run is aborted before the tool ends", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    let rejectPrompt: ((error: Error) => void) | undefined;
    let notifyCheckStarted: (() => void) | undefined;
    const checkStarted = new Promise<void>((resolve) => {
      notifyCheckStarted = resolve;
    });
    const abort = vi.fn(async () => rejectPrompt?.(new Error("Aborted")));
    const session = createMockPiSession({
      abort,
      prompt: vi.fn(() => {
        mocks.emitPiEvent({
          type: "tool_execution_start",
          toolCallId: "aborted-check-call",
          toolName: "terminal_run",
          args: { command: "npm test" },
        });
        notifyCheckStarted?.();
        return new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const prompt = runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
    });
    await checkStarted;
    await runtime.abort(sessionId);
    await prompt;

    const result = JSON.parse(
      (
        getDatabase()
          .prepare(
            "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
          )
          .get(sessionId) as { payload_json: string }
      ).payload_json,
    ) as { result: { required: boolean; status: string } };
    expect(result.result).toMatchObject({ required: true, status: "unavailable" });
    expect(result.result.status).not.toBe("passed");
  });

  it("does not continue todos after input is queued into the current run", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    let releaseModel: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const modelStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let session: Record<string, unknown>;
    const modelPrompt = vi.fn(async () => {
      if (modelPrompt.mock.calls.length > 1) return;
      session.isStreaming = true;
      recordAgentEvent({
        type: "todos.updated",
        sessionId,
        todos: [{ id: "todo-1", content: "Finish work", status: "pending" }],
      });
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "Working" },
      });
      notifyStarted?.();
      await modelGate;
      session.isStreaming = false;
      mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
    });
    session = createMockPiSession({ prompt: modelPrompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const firstRun = runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Work through the todo list",
      sessionId,
    });
    await modelStarted;
    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "steer",
      message: "Take this new input into account",
      sessionId,
    });
    releaseModel?.();
    await firstRun;

    expect(modelPrompt).toHaveBeenCalledTimes(2);
    expect(
      (
        getDatabase()
          .prepare(
            "select count(*) as count from agent_events where session_id = ? and type = 'harness.continuation'",
          )
          .get(sessionId) as { count: number }
      ).count,
    ).toBe(0);
  });

  it("clears the in-memory TODO projection when runtime resources are released", async () => {
    const clearCache = vi.spyOn(todoToolRuntime, "clearTodoSessionCache");
    await new PiSdkRuntime().releaseRuntime("released-todo-cache-session");
    expect(clearCache).toHaveBeenCalledWith("released-todo-cache-session");
  });

  it("applies the intent gate once to a fresh turn and not its queued steer", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    let releaseModelPrompt: (() => void) | undefined;
    let notifyModelPrompt: (() => void) | undefined;
    const modelPromptStarted = new Promise<void>((resolve) => {
      notifyModelPrompt = resolve;
    });
    const modelPromptGate = new Promise<void>((resolve) => {
      releaseModelPrompt = resolve;
    });
    let session: Record<string, unknown>;
    session = createMockPiSession({
      prompt: vi.fn(async () => {
        if (session.isStreaming) return;
        session.isStreaming = true;
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        notifyModelPrompt?.();
        await modelPromptGate;
        session.isStreaming = false;
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: { type?: string; request?: { id: string } }) => {
        if (event.type === "question.requested" && event.request) {
          queueMicrotask(() => resolveQuestionRequest(event.request?.id ?? "", [], true));
        }
      },
    );
    const runtime = new PiSdkRuntime();
    const firstTurn = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Which deployment option should I choose?",
      sessionId,
      userMessageId: "intent-user-one",
    });
    await modelPromptStarted;
    await runtime.prompt(window, {
      context: [],
      delivery: "steer",
      message: "Which rollout option should I choose?",
      sessionId,
      userMessageId: "intent-user-steer",
    });
    releaseModelPrompt?.();
    await firstTurn;

    const questionEvents = getDatabase()
      .prepare(
        "select payload_json from agent_events where session_id = ? and type = 'question.requested'",
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    expect(questionEvents).toHaveLength(1);
    expect(questionEvents[0]?.payload_json).not.toContain("Which deployment option");
    expect(questionEvents[0]?.payload_json).not.toContain("Which rollout option");
  });

  it("proceeds with only the default assumption when clarification is skipped", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const prompts: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        prompts.push(message);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: { type?: string; request?: { id: string } }) => {
        if (event.type === "question.requested" && event.request) {
          queueMicrotask(() => resolveQuestionRequest(event.request?.id ?? "", [], true));
        }
      },
    );

    await new PiSdkRuntime().prompt(window, {
      context: [],
      delivery: "normal",
      message: "Which rollout option should I choose? PRIVATE_INTENT_TEXT",
      sessionId,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Assumption: Use a conservative default and proceed.");
    const questionPayload = (
      getDatabase()
        .prepare(
          "select payload_json from agent_events where session_id = ? and type = 'question.requested'",
        )
        .get(sessionId) as { payload_json: string }
    ).payload_json;
    expect(questionPayload).not.toContain("PRIVATE_INTENT_TEXT");
  });

  it("blocks a consequential action when confirmation is skipped", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const modelPrompt = vi.fn(async () => undefined);
    const session = createMockPiSession({ prompt: modelPrompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: { type?: string; request?: { id: string } }) => {
        if (event.type === "question.requested" && event.request) {
          queueMicrotask(() => resolveQuestionRequest(event.request?.id ?? "", [], true));
        }
      },
    );

    const runtime = new PiSdkRuntime();
    const questionPending: string[] = [];
    runtime.onQuestionPending((id) => questionPending.push(id));
    const result = await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Delete the production database PRIVATE_INTENT_TEXT",
      sessionId,
    });

    expect(result).toEqual({ outcome: "blocked" });
    // The gate question opened once, while prompt() was still pending.
    expect(questionPending).toEqual([sessionId]);
    expect(modelPrompt).not.toHaveBeenCalled();
    const events = getDatabase()
      .prepare("select type, payload_json from agent_events where session_id = ? order by rowid")
      .all(sessionId) as Array<{ type: string; payload_json: string }>;
    expect(events.some((event) => event.type === "run.blocked")).toBe(true);
    const questions = events.filter((event) => event.type === "question.requested");
    expect(questions).toHaveLength(1);
    expect(questions[0]?.payload_json).not.toContain("PRIVATE_INTENT_TEXT");
    const run = getDatabase()
      .prepare("select id from agent_runs where session_id = ? order by rowid desc limit 1")
      .get(sessionId) as { id: string };
    expect(getLatestHarnessTaskState(sessionId, run.id)).toMatchObject({
      phase: "terminal",
      verificationStatus: "blocked",
    });
    expect(
      getLatestHarnessTaskState(sessionId, run.id)?.criteria.every(
        ({ status }) => status !== "verified",
      ),
    ).toBe(true);
  });

  it("uses a bounded clarification answer as the intent assumption", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const prompts: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        prompts.push(message);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const answer = "Prefer the legacy-compatible deployment strategy.";
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: { type?: string; request?: { id: string } }) => {
        if (event.type === "question.requested" && event.request) {
          queueMicrotask(() =>
            resolveQuestionRequest(
              event.request?.id ?? "",
              [
                {
                  questionId: "intent-clarification",
                  selected: ["Use a conservative default"],
                  custom: answer,
                },
              ],
              false,
            ),
          );
        }
      },
    );

    await new PiSdkRuntime().prompt(window, {
      context: [],
      delivery: "normal",
      message: "Which rollout option should I choose? PRIVATE_INTENT_TEXT",
      sessionId,
    });

    expect(prompts[0]).toContain(`Assumption: ${answer}`);
    expect(prompts[0]).not.toContain("Use a conservative default and proceed.");
  });

  it.each([
    "abort",
    "releaseRuntime",
    "dispose",
  ] as const)("cancels a pending gate on %s and ignores a late confirmation", async (cancellation) => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const modelPrompt = vi.fn(async () => undefined);
    const session = createMockPiSession({ prompt: modelPrompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    let requestId: string | undefined;
    let runId: string | undefined;
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: { type?: string; request?: { id: string; runId?: string } }) => {
        if (event.type === "question.requested" && event.request) {
          requestId = event.request.id;
          runId = event.request.runId;
        }
      },
    );
    const runtime = new PiSdkRuntime();
    const pendingPrompt = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Delete production data",
      sessionId,
    });
    await vi.waitFor(() => expect(requestId).toBeDefined());

    if (cancellation === "abort") await runtime.abort(sessionId);
    else if (cancellation === "releaseRuntime") await runtime.releaseRuntime(sessionId);
    else await runtime.dispose(sessionId);
    resolveQuestionRequest(
      requestId ?? "",
      [{ questionId: "intent-confirmation", selected: ["Proceed"] }],
      false,
    );
    await pendingPrompt;

    expect(modelPrompt).not.toHaveBeenCalled();
    expect(getAgentRun(runId ?? "")?.status).toBe("cancelled");
    const events = getDatabase()
      .prepare("select type from agent_events where session_id = ?")
      .all(sessionId) as Array<{ type: string }>;
    expect(events.some((event) => event.type === "run.cancelled")).toBe(true);
    expect(events.some((event) => event.type === "run.blocked")).toBe(false);
  });

  it("rejects concurrent prompts during intent preflight before recording the second user turn", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const modelPrompt = vi.fn(async () => undefined);
    const session = createMockPiSession({ prompt: modelPrompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const requests: Array<{ id: string; runId?: string }> = [];
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_channel: string, event: { type?: string; request?: { id: string; runId?: string } }) => {
        if (event.type === "question.requested" && event.request) requests.push(event.request);
      },
    );
    const runtime = new PiSdkRuntime();
    const firstPrompt = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Delete production data",
      sessionId,
      userMessageId: "preflight-user-one",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const secondPrompt = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Delete customer records",
      sessionId,
      userMessageId: "preflight-user-two",
    });
    const secondOutcome = secondPrompt.then(
      () => "resolved",
      () => "rejected",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await runtime.abort(sessionId);
    for (const request of requests) {
      resolveQuestionRequest(
        request.id,
        [{ questionId: "intent-confirmation", selected: ["Proceed"] }],
        false,
      );
    }
    await Promise.allSettled([firstPrompt, secondPrompt]);

    expect(await secondOutcome).toBe("rejected");
    expect(modelPrompt).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    const eventTypes = getDatabase()
      .prepare("select type from agent_events where session_id = ?")
      .all(sessionId) as Array<{ type: string }>;
    expect(eventTypes.filter((event) => event.type === "message.started")).toHaveLength(1);
    expect(eventTypes.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(eventTypes.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(getAgentRun(requests[0]?.runId ?? "")?.status).toBe("cancelled");
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(
      (
        getDatabase().prepare("select status from agent_sessions where id = ?").get(sessionId) as {
          status: string;
        }
      ).status,
    ).toBe("idle");
  });

  it("holds the preflight reservation until the SDK reports preflight completion", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    let releaseHook: (() => void) | undefined;
    let notifyHookEntered: (() => void) | undefined;
    let notifyPreflightComplete: (() => void) | undefined;
    let releaseAgentRun: (() => void) | undefined;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hookEntered = new Promise<void>((resolve) => {
      notifyHookEntered = resolve;
    });
    const preflightComplete = new Promise<void>((resolve) => {
      notifyPreflightComplete = resolve;
    });
    const agentGate = new Promise<void>((resolve) => {
      releaseAgentRun = resolve;
    });
    type PromptOpts = { preflightResult?: (success: boolean) => void; streamingBehavior?: string };
    let session: Record<string, unknown>;
    const promptCalls: Array<{ message: string; options?: PromptOpts }> = [];
    session = createMockPiSession({
      deferPreflight: true,
      prompt: vi.fn(async (message: string, options?: PromptOpts) => {
        promptCalls.push({ message, ...(options ? { options } : {}) });
        if (promptCalls.length === 1) {
          notifyHookEntered?.();
          await hookGate;
          session.isStreaming = true;
          options?.preflightResult?.(true);
          notifyPreflightComplete?.();
          await agentGate;
          session.isStreaming = false;
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "done" },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
          return;
        }
        options?.preflightResult?.(true);
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const window = createWindowStub();
    (window.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(
      (
        _channel: string,
        event: { type?: string; request?: { id: string; questions: Array<{ id: string }> } },
      ) => {
        if (event.type === "question.requested" && event.request) {
          queueMicrotask(() =>
            resolveQuestionRequest(
              event.request?.id ?? "",
              [{ questionId: event.request?.questions[0]?.id ?? "", selected: ["Proceed"] }],
              false,
            ),
          );
        }
      },
    );
    const runtime = new PiSdkRuntime();
    const firstPrompt = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Delete production data",
      sessionId,
      userMessageId: "hook-user-one",
    });
    await hookEntered;

    const secondBeforePreflight = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Fix a typo",
      sessionId,
      userMessageId: "hook-user-two-early",
    });
    const earlyOutcome = secondBeforePreflight.then(
      () => "resolved",
      () => "rejected",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeCallback = getDatabase()
      .prepare("select type from agent_events where session_id = ?")
      .all(sessionId) as Array<{ type: string }>;
    releaseHook?.();
    await preflightComplete;
    const secondAfterPreflight = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "Follow up after preflight",
      sessionId,
      userMessageId: "hook-user-two-late",
    });
    const lateOutcome = secondAfterPreflight.then(
      () => "resolved",
      () => "rejected",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseAgentRun?.();
    await Promise.allSettled([firstPrompt, secondBeforePreflight, secondAfterPreflight]);

    expect(await earlyOutcome).toBe("rejected");
    expect(beforeCallback.filter((event) => event.type === "message.started")).toHaveLength(1);
    expect(beforeCallback.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(await lateOutcome).toBe("resolved");
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1]?.options?.streamingBehavior).toBe("followUp");
    expect(
      (
        getDatabase()
          .prepare("select count(*) as count from agent_runs where session_id = ?")
          .get(sessionId) as { count: number }
      ).count,
    ).toBe(1);
    releaseAgentRun?.();
    await firstPrompt;
  });

  it("surfaces complex-work plan guidance in the first model prompt without asking or switching mode", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const prompts: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        prompts.push(message);
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const window = createWindowStub();
    await new PiSdkRuntime().prompt(window, {
      context: ["src/main/a.ts", "src/main/b.ts", "src/renderer/c.tsx", "src/shared/d.ts"].map(
        (path) => ({ type: "file" as const, path }),
      ),
      delivery: "normal",
      message: "Implement a cross-cutting feature",
      sessionId,
    });

    expect(prompts[0]).toContain("Optional plan suggestion");
    expect(prompts[0]).toContain("continue in the current mode unless the user chooses otherwise");
    const questions = getDatabase()
      .prepare(
        "select count(*) as count from agent_events where session_id = ? and type = 'question.requested'",
      )
      .get(sessionId) as { count: number };
    expect(questions.count).toBe(0);
  });

  it("removes a run output tracker only when that run still owns the session entry", () => {
    const trackerA = { runId: "run-a" };
    const trackerB = { runId: "run-b" };
    const trackers = new Map([["session", trackerB]]);

    expect(removeRunOutputTrackerIfOwned(trackers, "session", trackerA)).toBe(false);
    expect(trackers.get("session")).toBe(trackerB);
    expect(removeRunOutputTrackerIfOwned(trackers, "session", trackerB)).toBe(true);
    expect(trackers.has("session")).toBe(false);
  });

  it("includes aggregated assistant response usage and model on the completed run", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    let memoryId: string | undefined;
    const assistantResponse = (usage: Record<string, number>, responseModel: string) => ({
      role: "assistant",
      provider: "mock-provider",
      model: "configured-model",
      responseModel,
      usage,
    });
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        const activeRun = getActiveAgentRun(sessionId);
        if (!activeRun) throw new Error("expected an active run during prompt");
        const memory = proposeMemoryForRun({
          sessionId,
          workspaceId,
          runId: activeRun.id,
          ...(activeRun.userMessageId ? { userMessageId: activeRun.userMessageId } : {}),
          cwd,
          title: "Successful run memory",
          claim: "The completed run established this reusable implementation fact.",
        });
        memoryId = memory.id;
        mocks.emitPiEvent({
          type: "message_end",
          message: assistantResponse(
            { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16 },
            "actual-model-1",
          ),
        });
        mocks.emitPiEvent({
          type: "message_end",
          message: {
            role: "tool",
            usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200 },
          },
        });
        mocks.emitPiEvent({
          type: "message_end",
          message: assistantResponse(
            { input: 4, output: 5, cacheRead: 6, cacheWrite: 2, totalTokens: 17 },
            "actual-model-2",
          ),
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "hello",
      sessionId,
      userMessageId: "user-message",
    });

    const row = getDatabase()
      .prepare(
        "select payload_json from agent_events where session_id = ? and type = 'run.completed'",
      )
      .get(sessionId) as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({
      tokenUsage: { input: 14, output: 7, cacheRead: 9, cacheWrite: 3, totalTokens: 33 },
      responseModel: {
        provider: "mock-provider",
        model: "configured-model",
        responseModel: "actual-model-2",
      },
    });
    expect(memoryId).toBeDefined();
    expect(
      projectMemory
        .getProjectMemorySnapshot(workspaceId)
        .memories.find((memory) => memory.id === memoryId)?.status,
    ).toBe("active");
  });

  it("keeps a successful run completed when project-memory finalization fails", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    let memoryId: string | undefined;
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        const activeRun = getActiveAgentRun(sessionId);
        if (!activeRun) throw new Error("expected active run");
        memoryId = proposeMemoryForRun({
          sessionId,
          workspaceId,
          runId: activeRun.id,
          cwd,
          title: "Run must survive memory failure",
          claim: "A memory finalization error must not fail a successful run.",
        }).id;
        getDatabase().exec(`create trigger fail_memory_finalization before insert on project_memory_events
          when new.memory_id = '${memoryId}' and new.to_status = 'active'
          begin select raise(abort, 'injected memory finalization failure'); end`);
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "completed successfully" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const finalize = vi.spyOn(projectMemory, "finalizeProjectMemoryRun").mockImplementation(() => {
      throw new Error("injected memory finalization failure");
    });
    let finalizeAttempted = false;
    try {
      await new PiSdkRuntime().prompt(createWindowStub(), {
        context: [],
        delivery: "normal",
        message: "complete safely",
        sessionId,
        userMessageId: "message-success",
      });
      finalizeAttempted = finalize.mock.calls.length > 0;
    } finally {
      getDatabase().exec("drop trigger if exists fail_memory_finalization");
      finalize.mockRestore();
    }
    const run = getDatabase()
      .prepare("select status from agent_runs where session_id = ?")
      .get(sessionId) as { status: string };
    const eventTypes = (
      getDatabase()
        .prepare("select type from agent_events where session_id = ?")
        .all(sessionId) as Array<{ type: string }>
    ).map((row) => row.type);
    expect(run.status).toBe("completed");
    expect(finalizeAttempted).toBe(true);
    expect(eventTypes).toContain("run.completed");
    expect(eventTypes).not.toContain("run.failed");
    expect(
      projectMemory
        .getProjectMemorySnapshot(workspaceId)
        .memories.find((memory) => memory.id === memoryId)?.status,
    ).toBe("candidate");
  });

  it("injects one cited untrusted active-memory block before user text, never into system prompts", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "cache.ts"), "export const cacheSize = 4;\n");
    const sourceRun = createAgentRun({
      sessionId,
      prompt: "seed project memories",
      userMessageId: "seed-user",
    });
    updateAgentRunStatus(sourceRun.id, "completed");
    const active = projectMemory.proposeProjectMemory(
      {
        scope: "project",
        category: "constraint",
        title: "Cache key constraint",
        claim: "Normalize cache keys before lookup to avoid duplicate entries.",
        evidence: [
          { kind: "run" },
          { kind: "file", path: "src/cache.ts" },
          { kind: "symbol", symbol: "cacheSize" },
        ],
      },
      { workspaceId, sessionId, runId: sourceRun.id, userMessageId: "seed-user", cwd },
    );
    const decoys = [
      projectMemory.proposeProjectMemory(
        {
          scope: "project",
          category: "decision",
          title: "Inactive candidate",
          claim: "This candidate must not appear in the prompt.",
          evidence: [{ kind: "run" }],
        },
        { workspaceId, sessionId, runId: sourceRun.id, userMessageId: "seed-user", cwd },
      ),
      projectMemory.proposeProjectMemory(
        {
          scope: "project",
          category: "decision",
          title: "Inactive provisional",
          claim: "This provisional claim must not appear in the prompt.",
          evidence: [{ kind: "run" }],
        },
        { workspaceId, sessionId, runId: sourceRun.id, userMessageId: "seed-user", cwd },
      ),
      projectMemory.proposeProjectMemory(
        {
          scope: "project",
          category: "decision",
          title: "Inactive review",
          claim: "This review claim must not appear in the prompt.",
          evidence: [{ kind: "run" }],
        },
        { workspaceId, sessionId, runId: sourceRun.id, userMessageId: "seed-user", cwd },
      ),
      projectMemory.proposeProjectMemory(
        {
          scope: "project",
          category: "decision",
          title: "Inactive obsolete",
          claim: "This obsolete claim must not appear in the prompt.",
          evidence: [{ kind: "run" }],
        },
        { workspaceId, sessionId, runId: sourceRun.id, userMessageId: "seed-user", cwd },
      ),
    ];
    projectMemory.finalizeProjectMemoryRun({
      sessionId,
      runId: sourceRun.id,
      outcome: "completed",
    });
    getDatabase()
      .prepare("update project_memory_records set status = 'candidate' where id = ?")
      .run(decoys[0]!.id);
    getDatabase()
      .prepare("update project_memory_records set status = 'provisional' where id = ?")
      .run(decoys[1]!.id);
    getDatabase()
      .prepare("update project_memory_records set status = 'needs_review' where id = ?")
      .run(decoys[2]!.id);
    getDatabase()
      .prepare("update project_memory_records set status = 'obsolete' where id = ?")
      .run(decoys[3]!.id);

    let composed = "";
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        composed = message;
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "checked" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const userText = "Please inspect cache normalization behavior.";
    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [{ type: "file", path: join(cwd, "src", "cache.ts") }],
      delivery: "normal",
      message: userText,
      sessionId,
      userMessageId: "user-query-memory-context",
    });

    const openTag = "<project_memory_context>";
    expect(composed.split(openTag)).toHaveLength(2);
    expect(composed.indexOf(openTag)).toBeLessThan(composed.indexOf(userText));
    expect(composed.toLowerCase()).toContain("untrusted");
    expect(composed.toLowerCase()).toContain("possibly stale");
    expect(composed.toLowerCase()).toContain("verify");
    expect(composed).toContain("category:constraint");
    expect(composed).toContain("status:active");
    expect(composed).toContain(`memory:${active.id}`);
    expect(composed).toContain("file:src/cache.ts");
    expect(composed).toContain("symbol:cacheSize");
    for (const decoy of decoys) expect(composed).not.toContain(decoy.claim);
    const systemPrompt = (
      mocks.resourceLoaderOptions.at(-1) as { appendSystemPrompt: string[] }
    ).appendSystemPrompt.join("\n");
    expect(systemPrompt).not.toContain("<project_memory_context>");
    expect(systemPrompt).not.toContain(active.claim);
  });

  it("fails soft when planning memory context throws", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const planner = vi
      .spyOn(contextPlanner, "planTurnContext")
      .mockRejectedValue(new Error("sensitive planner failure detail"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let composed = "";
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        composed = message;
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    try {
      await expect(
        new PiSdkRuntime().prompt(createWindowStub(), {
          context: [],
          delivery: "normal",
          message: "continue without memory",
          sessionId,
          userMessageId: "planner-error-user",
        }),
      ).resolves.toEqual({ outcome: "ok", finalText: "done" });
      expect(composed).toContain("continue without memory");
      expect(composed).not.toContain("<project_memory_context>");
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls.flat().join(" ")).not.toContain("sensitive planner failure detail");
    } finally {
      planner.mockRestore();
      warning.mockRestore();
    }
  });

  it("forwards the session worktree's bounded Git context into Context Planner", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const worktreeCwd = join(cwd, "linked-worktree");
    await mkdir(join(worktreeCwd, "src"), { recursive: true });
    const sourcePath = join(worktreeCwd, "src", "cache.ts");
    await writeFile(sourcePath, "export const cacheSize = 3;\n");
    getDatabase()
      .prepare("update agent_sessions set cwd = ? where id = ?")
      .run(worktreeCwd, sessionId);
    const git = vi.spyOn(gitMemoryContext, "getGitMemoryContext").mockResolvedValue({
      branch: "feature/linked-worktree",
      head: "abc1234",
      changedPaths: ["src/renamed-cache.ts", "src/untracked-cache.ts"],
    });
    const planner = vi
      .spyOn(contextPlanner, "planTurnContext")
      .mockResolvedValue({ text: "", memoryIds: [], estimatedTokens: 0 });
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [{ type: "file", path: sourcePath }],
      delivery: "normal",
      message: "inspect this cache",
      sessionId,
      userMessageId: "git-context-user",
    });
    expect(git).toHaveBeenCalledWith(worktreeCwd);
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        sessionId,
        query: "inspect this cache",
        contextPaths: ["src/cache.ts"],
        git: {
          branch: "feature/linked-worktree",
          head: "abc1234",
          changedPaths: ["src/renamed-cache.ts", "src/untracked-cache.ts"],
        },
      }),
    );
  });

  it("passes empty Git metadata to planning and completes the prompt when Git metadata fails", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const git = vi
      .spyOn(gitMemoryContext, "getGitMemoryContext")
      .mockRejectedValue(new Error("git metadata unavailable"));
    const planner = vi
      .spyOn(contextPlanner, "planTurnContext")
      .mockResolvedValue({ text: "", memoryIds: [], estimatedTokens: 0 });
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    await expect(
      new PiSdkRuntime().prompt(createWindowStub(), {
        context: [],
        delivery: "normal",
        message: "continue without Git",
        sessionId,
        userMessageId: "git-failure-user",
      }),
    ).resolves.toEqual({ outcome: "ok", finalText: "done" });
    expect(git).toHaveBeenCalledOnce();
    expect(planner).toHaveBeenCalledWith(expect.objectContaining({ git: { changedPaths: [] } }));
  });

  it("queues an overlapping normal prompt into the active run without losing its metadata", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const planner = vi.spyOn(contextPlanner, "planTurnContext").mockResolvedValue({
      text: "- Cached rule [category:decision; status:active; memory:queued-digest; evidence file:src/cache.ts]",
      memoryIds: ["queued-digest"],
      estimatedTokens: 20,
    });
    let notifyFirstPromptStarted!: () => void;
    const firstPromptStarted = new Promise<void>((resolve) => {
      notifyFirstPromptStarted = resolve;
    });
    let releaseFirstPrompt!: () => void;
    const firstPromptGate = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    let promptCalls = 0;
    const composedMessages: string[] = [];
    const session = createMockPiSession({
      isStreaming: false,
      prompt: vi.fn(async (message: string, options?: { streamingBehavior?: string }) => {
        promptCalls += 1;
        composedMessages.push(message);
        if (promptCalls === 1) {
          session.isStreaming = true;
          mocks.emitPiEvent({
            type: "message_end",
            message: {
              role: "assistant",
              provider: "provider-one",
              model: "model-one",
              usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
            },
          });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "first response" },
          });
          notifyFirstPromptStarted();
          await firstPromptGate;
          session.isStreaming = false;
          return;
        }

        expect(options?.streamingBehavior).toBe(promptCalls === 2 ? "followUp" : "steer");
        if (promptCalls === 3) return;
        mocks.emitPiEvent({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "provider-two",
            model: "model-two",
            usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 2, totalTokens: 13 },
          },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const firstPrompt = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "first",
      sessionId,
      userMessageId: "user-one",
    });
    await firstPromptStarted;

    await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "second",
      sessionId,
      userMessageId: "user-two",
    });
    await runtime.prompt(window, {
      context: [],
      delivery: "steer",
      message: "steer while same run is active",
      sessionId,
      userMessageId: "user-steer",
    });
    releaseFirstPrompt();
    await firstPrompt;

    const events = getDatabase()
      .prepare("select type, payload_json from agent_events where session_id = ? order by rowid")
      .all(sessionId) as Array<{ type: string; payload_json: string }>;
    const runsStarted = events.filter(({ type }) => type === "run.started");
    const runsCompleted = events.filter(({ type }) => type === "run.completed");
    const userMessages = events.filter(({ type }) => type === "message.started");
    expect(runsStarted).toHaveLength(1);
    expect(runsCompleted).toHaveLength(1);
    expect(userMessages).toHaveLength(3);
    const completedPayload = runsCompleted[0]?.payload_json;
    expect(completedPayload).toBeDefined();
    expect(JSON.parse(completedPayload ?? "{}")).toMatchObject({
      tokenUsage: { input: 15, output: 8, cacheRead: 0, cacheWrite: 2, totalTokens: 25 },
      responseModel: { provider: "provider-two", model: "model-two" },
    });
    expect(promptCalls).toBe(3);
    expect(planner).toHaveBeenCalledOnce();
    expect(composedMessages[0]).toContain("<project_memory_context>");
    expect(
      composedMessages.slice(1).every((message) => !message.includes("<project_memory_context>")),
    ).toBe(true);
  });

  it("gets a fresh memory digest for a distinct user follow-up after the previous run ends", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const plannerInputs: Array<{ query: string; sessionId: string }> = [];
    const planner = vi
      .spyOn(contextPlanner, "planTurnContext")
      .mockImplementation(async (input) => {
        plannerInputs.push({ query: input.query, sessionId: input.sessionId });
        const marker = plannerInputs.length === 1 ? "first-digest" : "follow-up-digest";
        return {
          text: `- ${marker} [category:decision; status:active; memory:${marker}]`,
          memoryIds: [marker],
          estimatedTokens: 10,
        };
      });
    const messages: string[] = [];
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        messages.push(message);
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "first unique request",
      sessionId,
      userMessageId: "fresh-user-one",
    });
    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "follow-up",
      message: "second distinct follow-up",
      sessionId,
      userMessageId: "fresh-user-two",
    });
    expect(planner).toHaveBeenCalledTimes(2);
    expect(plannerInputs.map((input) => input.query)).toEqual([
      "first unique request",
      "second distinct follow-up",
    ]);
    expect(messages[0]).toContain("first-digest");
    expect(messages[1]).toContain("follow-up-digest");
  });

  it("registers task and wait for same-turn background work", () => {
    new PiSdkRuntime();

    expect(toolRegistry.resolveActiveTools("chat")).toContain("task");
    expect(toolRegistry.resolveActiveTools("chat")).toContain("wait");
    expect(toolRegistry.resolveActiveTools("chat")).not.toContain("list_agents");
    expect(toolRegistry.resolveActiveTools("chat")).not.toContain("send_message");
    expect(toolRegistry.resolveActiveTools("chat")).not.toContain("wait_agent");
    expect(toolRegistry.resolveActiveTools("chat")).not.toContain("close_agent");
  });

  it("compacts an idle session without creating a prompt run", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const completedRun = createAgentRun({ sessionId, prompt: "previous completed work" });
    updateAgentRunStatus(completedRun.id, "completed");
    const recordCompaction = vi.spyOn(projectMemory, "recordProjectMemoryCompaction");
    const memory = proposeMemoryForRun({
      sessionId,
      workspaceId,
      runId: completedRun.id,
      cwd,
      title: "Manual compaction candidate",
      claim: "Manual compaction preserves a concise candidate event.",
    });
    const compact = vi.fn(async () => {
      mocks.emitPiEvent({ type: "compaction_start", reason: "manual" });
      mocks.emitPiEvent({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ compact, isIdle: true }),
    }));
    const runtime = new PiSdkRuntime();
    await runtime.compact(createWindowStub(), sessionId);

    expect((await runtime.listRuns(sessionId)).map((run) => run.id)).toEqual([completedRun.id]);
    expect(recordCompaction).toHaveBeenCalledTimes(2);
    expect(recordCompaction).toHaveBeenCalledWith({
      sessionId,
      runId: completedRun.id,
      aborted: false,
      willRetry: false,
    });
    expect(
      countMemoryCompactionEvents(memory.id, `compaction:${sessionId}:${completedRun.id}`),
    ).toBe(1);
    recordCompaction.mockRestore();
    const rows = getDatabase()
      .prepare("select type from agent_events where session_id = ? order by rowid")
      .all(sessionId) as Array<{ type: string }>;
    expect(rows.map(({ type }) => type)).toEqual([
      "session.status",
      "compaction.started",
      "compaction.ended",
      "session.status",
    ]);
  });

  it("never lets manual compaction abort a busy session", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const compact = vi.fn();
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ compact, isIdle: false }),
    }));

    await expect(new PiSdkRuntime().compact(createWindowStub(), sessionId)).rejects.toThrow(
      "while Modus is idle",
    );
    expect(compact).not.toHaveBeenCalled();
  });

  it("rejects compaction synchronously while a HyperPlan start reservation is held", async () => {
    const sessionId = `compact-hyperplan-reserved-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const compactPi = vi.fn(async () => undefined);
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ isIdle: true, compact: compactPi }),
    }));
    let releaseOperation!: () => void;
    const heldStart = hyperPlanDraftStore.runHyperPlanStartOperation({
      ownerId: 61,
      requestId: "held-start-for-compact",
      kind: "original",
      sessionId,
      planId: "held-plan",
      planFingerprint: "held-fingerprint",
      start: () =>
        new Promise((resolve) => {
          releaseOperation = () =>
            resolve({
              sessionId,
              planId: "held-plan",
              planFingerprint: "held-fingerprint",
              runId: "held-run",
            });
        }),
    });
    const compact = runtime.compact(createWindowStub(), sessionId);

    await expect(compact).rejects.toThrow(/reserved|busy|compact/i);
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
    expect(compactPi).not.toHaveBeenCalled();
    releaseOperation();
    await heldStart;
  });

  it("holds a synchronous compact preflight across resume awaits against start and prompt", async () => {
    const sessionId = `compact-preflight-race-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Compaction race plan",
      overview: "Do not race compaction.",
      content: "# Compaction race plan",
      todos: [],
      spec: { requirements: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
    });
    let releaseResume!: () => void;
    let signalResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeCalled = new Promise<void>((resolve) => {
      signalResume = resolve;
    });
    mocks.createAgentSession.mockImplementationOnce(async () => {
      signalResume();
      await resumeGate;
      return { session: createMockPiSession({ isIdle: true, compact: async () => undefined }) };
    });
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const compact = runtime.compact(window, sessionId);
    await resumeCalled;

    await expect(
      runtime.prompt(window, { sessionId, message: "racing prompt", context: [] }),
    ).rejects.toThrow(/intent-gate|compaction|preflight|busy/i);
    await expect(
      hyperPlanDraftStore.runHyperPlanStartOperation({
        ownerId: 62,
        requestId: "start-during-compact",
        kind: "original",
        sessionId,
        planId: plan.id,
        planFingerprint: fingerprintPlanSource(plan),
        start: (_operation, onRunCreated) =>
          runtime.startOriginalPlanBuild(window, {
            ownerId: 62,
            requestId: "start-during-compact",
            sessionId,
            planId: plan.id,
            planFingerprint: fingerprintPlanSource(plan),
            idempotencyKey: "start-during-compact",
            onRunCreated,
          }),
      }),
    ).rejects.toThrow(/busy|reserved/i);

    releaseResume();
    await compact;
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
    expect(
      (
        runtime as unknown as { preflightReservations: Map<string, symbol> }
      ).preflightReservations.has(sessionId),
    ).toBe(false);
  });

  it("re-prompts after threshold compaction so the Modus run continues", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const recordCompaction = vi.spyOn(projectMemory, "recordProjectMemoryCompaction");
    const planner = vi.spyOn(contextPlanner, "planTurnContext").mockResolvedValue({
      text: "- threshold memory [category:decision; status:active; memory:threshold-memory]",
      memoryIds: ["threshold-memory"],
      estimatedTokens: 12,
    });
    let promptCalls = 0;
    let firstCompactedMemoryId: string | undefined;
    let secondCompactedMemoryId: string | undefined;
    let compactionRunId: string | undefined;
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        promptCalls += 1;
        if (promptCalls === 1 || promptCalls === 2) {
          const activeRun = getActiveAgentRun(sessionId);
          if (!activeRun) throw new Error("expected active run during compaction");
          compactionRunId = activeRun.id;
          const memory = proposeMemoryForRun({
            sessionId,
            workspaceId,
            runId: activeRun.id,
            ...(activeRun.userMessageId ? { userMessageId: activeRun.userMessageId } : {}),
            cwd,
            title: `Threshold compaction candidate ${promptCalls}`,
            claim: `Candidate ${promptCalls} was proposed between successful threshold compactions.`,
          });
          if (promptCalls === 1) firstCompactedMemoryId = memory.id;
          else secondCompactedMemoryId = memory.id;
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: `working ${promptCalls}` },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "compaction_start",
            reason: "threshold",
          });
          mocks.emitPiEvent({
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: `## Next Steps\n1. Finish ${promptCalls}`,
              firstKeptEntryId: "e1",
              tokensBefore: 9,
            },
            aborted: false,
            willRetry: false,
          });
          return;
        }
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "continued after two compactions" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();

    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "long task",
      sessionId,
      userMessageId: "local-user-compact-continue",
    });

    expect(promptCalls).toBe(3);
    const promptFn = session.prompt as ReturnType<typeof vi.fn>;
    expect(promptFn.mock.calls[1]?.[0]).toContain("Context was compacted");
    expect(promptFn.mock.calls[2]?.[0]).toContain("Context was compacted");
    expect(planner).toHaveBeenCalledOnce();
    expect(promptFn.mock.calls[0]?.[0]).toContain("<project_memory_context>");
    expect(
      promptFn.mock.calls
        .slice(1)
        .every(([message]) => !String(message).includes("<project_memory_context>")),
    ).toBe(true);
    const types = (
      getDatabase()
        .prepare(
          "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
        )
        .all(sessionId) as Array<{ type: string }>
    ).map((row) => row.type);
    expect(types).toContain("compaction.started");
    expect(types).toContain("compaction.ended");
    expect(types).toContain("run.completed");
    expect(recordCompaction).toHaveBeenCalledTimes(2);
    expect(recordCompaction.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      aborted: false,
      willRetry: false,
    });
    expect(recordCompaction.mock.calls[1]?.[0]).toMatchObject({
      sessionId,
      runId: compactionRunId,
      aborted: false,
      willRetry: false,
    });
    const compactionKey = `compaction:${sessionId}:${compactionRunId}`;
    for (const memoryId of [firstCompactedMemoryId, secondCompactedMemoryId]) {
      expect(countMemoryCompactionEvents(memoryId, compactionKey)).toBe(1);
    }
    recordCompaction.mockRestore();
  });

  it.each([
    { aborted: true, willRetry: false, failed: false },
    { aborted: false, willRetry: true, failed: false },
    { aborted: false, willRetry: false, failed: true },
  ])("does not finalize compaction aborted=$aborted willRetry=$willRetry failed=$failed", async ({
    aborted,
    willRetry,
    failed,
  }) => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const recordCompaction = vi.spyOn(projectMemory, "recordProjectMemoryCompaction");
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({ type: "compaction_start", reason: "overflow" });
          mocks.emitPiEvent({
            type: "compaction_end",
            reason: "overflow",
            aborted,
            willRetry,
            ...(failed ? { errorMessage: "compaction failed" } : {}),
          });
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: {
              type: "text_delta",
              delta: "completed after overflow handling",
            },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
        }),
      }),
    }));
    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "handle compaction",
      sessionId,
      userMessageId: `user-${sessionId}`,
    });
    expect(recordCompaction).not.toHaveBeenCalled();
    recordCompaction.mockRestore();
  });

  it("does not finalize a failed manual compaction event", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const completedRun = createAgentRun({ sessionId, prompt: "completed prior run" });
    updateAgentRunStatus(completedRun.id, "completed");
    const recordCompaction = vi.spyOn(projectMemory, "recordProjectMemoryCompaction");
    const compact = vi.fn(async () => {
      mocks.emitPiEvent({ type: "compaction_start", reason: "manual" });
      mocks.emitPiEvent({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        errorMessage: "manual compaction failed",
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ compact, isIdle: true }),
    }));
    await new PiSdkRuntime().compact(createWindowStub(), sessionId);
    expect(recordCompaction).not.toHaveBeenCalled();
    recordCompaction.mockRestore();
  });

  it("activates plan_write without visual_write in plan mode", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "plan complete" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const runtime = new PiSdkRuntime();

    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "plan this",
      mode: "plan",
      sessionId,
      userMessageId: "local-user-plan-tools",
    });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["plan_write"]),
    );
    const setActiveToolsByName = session.setActiveToolsByName as ReturnType<typeof vi.fn>;
    const activeTools = setActiveToolsByName.mock.calls.at(-1)?.[0] as string[];
    expect(activeTools).not.toContain("visual_write");
  });

  it("wires Spec Mode through the read-only Plan profile and tool context", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    let observedMode: string | undefined;
    let observedProfile: string | undefined;
    let observedPrompt = "";
    const session = createMockPiSession({
      prompt: vi.fn(async (message: string) => {
        observedPrompt = message;
        const context = resolveAgentToolContext(cwd);
        observedMode = context.mode;
        observedProfile = context.profile;
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "spec complete" },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Specify the feature",
      mode: "spec",
      sessionId,
    });

    expect(observedMode).toBe("spec");
    expect(observedProfile).toBe("plan");
    expect(observedPrompt).toContain("SPEC MODE");
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["plan_write"]),
    );
    const activeTools = (session.setActiveToolsByName as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[0] as string[];
    expect(activeTools).not.toContain("visual_write");
  });

  it("task tool returns immediately; wait harvests the child output", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const agentsDir = join(cwd, ".modus", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "security-auditor.md"),
      "---\nname: security-auditor\n---\nSecurity reviewer.",
      "utf8",
    );
    let releaseChild: (() => void) | undefined;
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChild = () => {
                mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
                mocks.emitPiEvent({
                  type: "message_update",
                  message: { role: "assistant" },
                  assistantMessageEvent: { type: "text_delta", delta: "audit complete" },
                });
                mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
                resolve();
              };
            }),
        ),
      }),
    }));
    new PiSdkRuntime();
    const window = createWindowStub();
    setTaskToolContext(workspaceId, parentSessionId, window);
    const tools = toolRegistry.getCustomToolDefinitions("chat");
    const taskTool = tools.find((definition) => definition.name === "task") as {
      execute(
        toolCallId: string,
        params: { description: string; prompt: string; subagent?: string },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: { cwd: string },
      ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
    };
    const waitTool = tools.find((definition) => definition.name === "wait") as {
      execute(
        toolCallId: string,
        params: { timeout_ms?: number },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: { cwd: string },
      ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
    };

    const started = await taskTool.execute(
      "task-call",
      {
        description: "Audit auth",
        prompt: "Audit login.",
        subagent: "security-auditor",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    expect(started.content[0]?.text).toContain("Background task started");
    expect(started.content[0]?.text).not.toContain("audit complete");

    await vi.waitFor(() => expect(releaseChild).toBeTypeOf("function"));
    const waiting = waitTool.execute(
      "wait-1",
      { timeout_ms: 5_000 },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    releaseChild?.();
    const waited = await waiting;
    expect(waited.content[0]?.text).toContain("audit complete");
  });

  it("falls back unknown subagent names to generic task type and still spawns async", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "generic task complete" },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
        }),
      }),
    }));
    new PiSdkRuntime();
    const window = createWindowStub();
    setTaskToolContext(workspaceId, parentSessionId, window);
    const taskTool = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((definition) => definition.name === "task") as {
      execute(
        toolCallId: string,
        params: { description: string; prompt: string; subagent?: string },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: { cwd: string },
      ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
    };

    const result = await taskTool.execute(
      "task-call",
      { description: "Check files", prompt: "Check the files.", subagent: "general-purpose" },
      new AbortController().signal,
      undefined,
      { cwd },
    );

    expect(result.content[0]?.text).toContain("Background task started");
    expect(
      getDatabase()
        .prepare("select subagent_type from agent_sessions where parent_session_id = ?")
        .get(parentSessionId),
    ).toEqual({ subagent_type: "task" });
  });

  it("creates new sessions directly in the workspace checkout", async () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, cwd, "repo", 1, now, now);
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    let resolveBacking!: (value: { session: Record<string, unknown> }) => void;
    mocks.createAgentSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBacking = resolve;
        }),
    );

    const session = await runtime.create(window, {
      workspaceId,
      cwd,
      title: "New chat",
      model: "mock/model",
    });

    expect(session.cwd).toBe(cwd);
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalled());
    resolveBacking({ session: createMockPiSession() });
    await runtime.ensure(window, session.id);
    expect(mocks.sessionManagerCreate).toHaveBeenCalledWith(cwd, expect.any(String));
    const row = getDatabase()
      .prepare("select cwd from agent_sessions where id = ?")
      .get(session.id) as { cwd: string };
    expect(row.cwd).toBe(cwd);
  });

  it("injects global guidance before workspace rules", async () => {
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    mocks.globalGuidance = "<global_guidance>global</global_guidance>";
    await writeFile(join(cwd, "AGENTS.md"), "project rules", "utf8");
    getDatabase()
      .prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, cwd, "repo", 1, now, now);
    const runtime = new PiSdkRuntime();

    const window = createWindowStub();
    const session = await runtime.create(window, {
      workspaceId,
      cwd,
      title: "New chat",
      model: "mock/model",
    });
    await runtime.ensure(window, session.id);

    const options = mocks.resourceLoaderOptions.at(-1) as { appendSystemPrompt: string[] };
    const globalIndex = options.appendSystemPrompt.findIndex((part) =>
      part.includes("<global_guidance>global"),
    );
    const rulesIndex = options.appendSystemPrompt.findIndex((part) =>
      part.includes("<project_rules>"),
    );

    expect(globalIndex).toBeGreaterThan(-1);
    expect(rulesIndex).toBeGreaterThan(globalIndex);
  });

  it("creates a fresh PI backing session when a persisted session is no longer in memory and its PI file is missing", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));

    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const resumed = await runtime.ensure(window, sessionId);

    expect(resumed.id).toBe(sessionId);
    expect(mocks.sessionManagerCreate).toHaveBeenCalledWith(cwd, expect.any(String));
    expect(mocks.sessionManagerOpen).not.toHaveBeenCalled();
    const row = getDatabase()
      .prepare("select pi_session_file from agent_sessions where id = ?")
      .get(sessionId) as { pi_session_file: string };
    expect(row.pi_session_file).toContain("resumed.jsonl");
  });

  it("does not bump updated_at when ensure resumes a session without a new turn", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    getDatabase()
      .prepare("update agent_sessions set updated_at = ? where id = ?")
      .run("2026-01-01T00:00:00.000Z", sessionId);

    const runtime = new PiSdkRuntime();
    await runtime.ensure(createWindowStub(), sessionId);

    const row = getDatabase()
      .prepare("select updated_at from agent_sessions where id = ?")
      .get(sessionId) as { updated_at: string };
    expect(row.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("uses an MCP tool added after the first chat turn and preserves the live history", async () => {
    const { sessionAt, requestTool } = await useOfflinePiToolSessions();
    const sessionId = `session-${crypto.randomUUID()}`;
    const name = "mcp_added_after_turn";
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const turn = () => runtime.prompt(window, { context: [], message: "hello", sessionId });
    try {
      await turn();
      const first = sessionAt(0);
      const previousMessages = [...first.state.messages];
      first.setThinkingLevel("high");
      first.agent.thinkingBudgets = { high: 1234 };
      first.settingsManager.setCompactionEnabled(false);
      const clearTodos = vi.spyOn(todoToolRuntime, "clearTodoSessionCache");
      registerOfflineMcpTool(name, "new connection result");
      requestTool(name);
      await Promise.all([runtime.ensure(window, sessionId), runtime.ensure(window, sessionId)]);
      expect(clearTodos).not.toHaveBeenCalledWith(sessionId);

      await turn();

      const current = sessionAt();
      expect(current.state.messages.slice(0, previousMessages.length)).toEqual(previousMessages);
      expect(current.state.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolName: name,
            isError: false,
            content: [{ type: "text", text: "new connection result" }],
          }),
        ]),
      );
      expect(current.sessionManager).toBe(first.sessionManager);
      expect(current.thinkingLevel).toBe("high");
      expect(current.agent.thinkingBudgets).toEqual({ high: 1234 });
      expect(current.autoCompactionEnabled).toBe(false);
    } finally {
      toolRegistry.unregisterTool(name);
      await runtime.releaseRuntime(sessionId);
    }
  });

  it("uses the replacement MCP definition after reconnecting with the same tool name", async () => {
    const { sessionAt, requestTool } = await useOfflinePiToolSessions();
    const sessionId = `session-${crypto.randomUUID()}`;
    const name = "mcp_reconnected_lookup";
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const turn = () => runtime.prompt(window, { context: [], message: "hello", sessionId });
    registerOfflineMcpTool(name, "old client result");
    requestTool(name);
    try {
      await turn();
      registerOfflineMcpTool(name, "reconnected client result");

      await turn();

      expect(sessionAt().state.messages.filter((message) => message.role === "toolResult")).toEqual(
        [
          expect.objectContaining({
            content: [{ type: "text", text: "old client result" }],
            isError: false,
          }),
          expect.objectContaining({
            content: [{ type: "text", text: "reconnected client result" }],
            isError: false,
          }),
        ],
      );
    } finally {
      toolRegistry.unregisterTool(name);
      await runtime.releaseRuntime(sessionId);
    }
  });

  it("keeps a removed MCP tool unavailable on the next chat turn", async () => {
    const { sessionAt, requestTool } = await useOfflinePiToolSessions();
    const sessionId = `session-${crypto.randomUUID()}`;
    const name = "mcp_removed_lookup";
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const turn = () => runtime.prompt(window, { context: [], message: "hello", sessionId });
    registerOfflineMcpTool(name, "before removal");
    requestTool(name);
    try {
      await turn();
      toolRegistry.unregisterTool(name);

      await turn();

      const current = sessionAt();
      expect(current.getAllTools().map((tool) => tool.name)).not.toContain(name);
      expect(current.state.messages.filter((message) => message.role === "toolResult")).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "before removal" }],
          isError: false,
        }),
        expect.objectContaining({ toolName: name, isError: true }),
      ]);
    } finally {
      toolRegistry.unregisterTool(name);
      await runtime.releaseRuntime(sessionId);
    }
  });

  it("requires mcp.call approval before executing a newly registered dangerous tool", async () => {
    const { sessionAt, requestTool } = await useOfflinePiToolSessions();
    const { setProjectApprovalMode } = await import("../permissions/permission-store");
    const { resolvePermissionRequest } = await import("../permissions/permission-broker");
    const sessionId = `session-${crypto.randomUUID()}`;
    const name = "mcp_added_dangerous_lookup";
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    setProjectApprovalMode(cwd, "request-approval");
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    const turn = () => runtime.prompt(window, { context: [], message: "hello", sessionId });
    let pendingTurn: ReturnType<typeof turn> | undefined;
    try {
      await turn();
      registerOfflineMcpTool(name, "must not execute when denied", true);
      requestTool(name);

      pendingTurn = turn();
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "permission.requested")).toBe(true);
      });
      const requested = events.find((event) => event.type === "permission.requested");
      if (!requested) throw new Error("Expected an MCP approval request.");
      const request = requested.request;
      expect(request.action).toBe("mcp.call");
      resolvePermissionRequest(request.id, "deny");
      await pendingTurn;

      expect(sessionAt().state.messages.filter((message) => message.role === "toolResult")).toEqual(
        [
          expect.objectContaining({
            toolName: name,
            isError: true,
            content: [{ type: "text", text: "Denied by user: {}" }],
          }),
        ],
      );
    } finally {
      toolRegistry.unregisterTool(name);
      await runtime.releaseRuntime(sessionId);
      await pendingTurn?.catch(() => undefined);
    }
  });

  it("rebuilds an idle cached SDK session in the moved cwd (member worktree), keeping to-dos", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    expect((await runtime.ensure(window, sessionId)).cwd).toBe(cwd);
    const creates = mocks.createAgentSession.mock.calls.length;
    // Same cwd: the cached session is reused.
    await runtime.ensure(window, sessionId);
    expect(mocks.createAgentSession.mock.calls.length).toBe(creates);

    const moved = await mkdtemp(join(tmpdir(), "modus-pi-runtime-moved-"));
    await writeFile(join(moved, "AGENTS.md"), "Worktree rule marker 4b.\n");
    const permission = vi.spyOn(permissionExtension, "createModusPermissionExtension");
    const clearCache = vi.spyOn(todoToolRuntime, "clearTodoSessionCache");
    getDatabase().prepare("update agent_sessions set cwd = ? where id = ?").run(moved, sessionId);
    expect((await runtime.ensure(window, sessionId)).cwd).toBe(moved);

    // Rebuilt once, with the PI tools, permission extension and Project rules on the worktree.
    expect(mocks.createAgentSession.mock.calls.length).toBe(creates + 1);
    expect(mocks.createAgentSession.mock.calls.at(-1)?.[0]).toMatchObject({ cwd: moved });
    const loader = mocks.resourceLoaderOptions.at(-1) as {
      cwd: string;
      appendSystemPrompt: string[];
    };
    expect(loader.cwd).toBe(moved);
    expect(loader.appendSystemPrompt.join("\n")).toContain("Worktree rule marker 4b.");
    expect(permission).toHaveBeenCalledWith(sessionId, expect.any(Function), moved);
    // Unlike releaseRuntime, the rebuild keeps the in-memory to-dos.
    expect(clearCache).not.toHaveBeenCalledWith(sessionId);
    permission.mockRestore();
    clearCache.mockRestore();
    await rm(moved, { recursive: true, force: true });
  });

  /** A 1:1 agent chat (A3): the test session linked to an agent of a group in its Project. */
  async function agentChatSession(instructions: string) {
    const { createGroupWithNewAgents } = await import("../agents/agents-store");
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "Ana");
    const group = createGroupWithNewAgents({
      name: `Crew ${crypto.randomUUID()}`,
      workspaceId,
      members: [
        { name: "Ana", role: "Reviewer", instructions, modelId: "mock/model" },
        { name: "Bo", modelId: "mock/model" },
      ],
    });
    const agentId = group.members[0]?.agentId ?? "";
    getDatabase()
      .prepare("update agent_sessions set agent_id = ?, kind = 'chat' where id = ?")
      .run(agentId, sessionId);
    return { sessionId, agentId, group };
  }

  const lastSystemPrompt = () =>
    (
      mocks.resourceLoaderOptions.at(-1) as { appendSystemPrompt: string[] }
    ).appendSystemPrompt.join("\n");

  it("a 1:1 chat picks up edited agent instructions on its next turn, without a manual resume (A3)", async () => {
    const { updateAgent } = await import("../agents/agents-store");
    const { sessionId, agentId } = await agentChatSession("Persona marker one.");
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    await runtime.ensure(window, sessionId);
    expect(lastSystemPrompt()).toContain("Persona marker one.");
    const creates = mocks.createAgentSession.mock.calls.length;
    // Unchanged agent: the cached session is reused.
    await runtime.ensure(window, sessionId);
    expect(mocks.createAgentSession.mock.calls.length).toBe(creates);

    updateAgent(agentId, { instructions: "Persona marker two." });
    await runtime.ensure(window, sessionId);
    expect(mocks.createAgentSession.mock.calls.length).toBe(creates + 1);
    expect(lastSystemPrompt()).toContain("Persona marker two.");
    expect(lastSystemPrompt()).not.toContain("Persona marker one.");
  });

  it("refuses a turn in a 1:1 chat whose group is blocked (no Project), before any session work (A3)", async () => {
    const { sessionId, group } = await agentChatSession("Be terse.");
    getDatabase().prepare("update agent_groups set workspace_id = null where id = ?").run(group.id);
    const runtime = new PiSdkRuntime();
    const creates = mocks.createAgentSession.mock.calls.length;
    await expect(
      runtime.prompt(createWindowStub(), {
        context: [],
        delivery: "normal",
        message: "hello",
        sessionId,
      }),
    ).rejects.toMatchObject({ code: "group-project-required" });
    expect(mocks.createAgentSession.mock.calls.length).toBe(creates);
    expect(getAgentSession(sessionId)?.status).toBe("idle");
  });

  it("releaseRuntime drops the SDK session without cancelling descendant DB rows", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const childSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent");
    insertSubagentSession(childSessionId, parentSessionId, workspaceId);

    const parentPi = createMockPiSession({ sessionId: "pi-parent" });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: parentPi }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    await runtime.ensure(window, parentSessionId);
    expect(parentPi.dispose).not.toHaveBeenCalled();

    await runtime.releaseRuntime(parentSessionId);

    expect(parentPi.dispose).toHaveBeenCalled();
    expect(mocks.listManagedProcesses).not.toHaveBeenCalled();
    expect(mocks.killManagedProcess).not.toHaveBeenCalled();
    const child = getDatabase()
      .prepare("select status from agent_sessions where id = ?")
      .get(childSessionId) as { status: string };
    expect(child.status).toBe("idle");
  });

  it("records the user prompt as persisted message events before running PI", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    let resolveBacking!: (value: { session: Record<string, unknown> }) => void;
    mocks.createAgentSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBacking = resolve;
        }),
    );

    const promptPromise = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "介绍一下你自己",
      sessionId,
      userMessageId: "local-user-1",
    });

    const rows = getDatabase()
      .prepare(
        `select type, payload_json
         from agent_events
         where session_id = ?
         order by created_at asc, rowid asc`,
      )
      .all(sessionId) as Array<{ type: string; payload_json: string }>;

    expect(rows.slice(0, 3).map((row) => row.type)).toEqual([
      "message.started",
      "message.delta",
      "message.completed",
    ]);
    expect(JSON.parse(rows[1]?.payload_json ?? "{}")).toEqual({
      type: "message.delta",
      sessionId,
      messageId: "local-user-1",
      delta: "介绍一下你自己",
    });
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalled());
    resolveBacking({ session: createMockPiSession() });
    await promptPromise;
    const allRows = getDatabase()
      .prepare(
        "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
      )
      .all(sessionId) as Array<{ type: string }>;
    expect(allRows.map((row) => row.type)).toContain("run.started");
    const session = getDatabase()
      .prepare("select title from agent_sessions where id = ?")
      .get(sessionId) as { title: string };
    expect(session.title).toBe("介绍一下你自己");
    expect(window.webContents.send).toHaveBeenCalledWith("agent:event", {
      type: "session.updated",
      sessionId,
      title: "介绍一下你自己",
    });
  });

  it("publishes context usage snapshots without persisting them to the timeline", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.ensure(window, sessionId);

    expect(window.webContents.send).toHaveBeenCalledWith("agent:event", {
      type: "context.updated",
      sessionId,
      usage: {
        contextWindow: 1000,
        percent: 24,
        tokens: 240,
      },
    });
    const rows = getDatabase()
      .prepare("select type from agent_events where session_id = ?")
      .all(sessionId) as Array<{ type: string }>;
    expect(rows.map((row) => row.type)).not.toContain("context.updated");
  });

  it("marks a run as failed when PI completes without visible output", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const result = await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "回答我",
      sessionId,
      userMessageId: "local-user-empty",
    });
    expect(result).toEqual({ outcome: "failed" });

    const run = getDatabase()
      .prepare(
        "select status, error from agent_runs where session_id = ? order by started_at desc limit 1",
      )
      .get(sessionId) as { status: string; error: string };
    const events = getDatabase()
      .prepare(
        "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
      )
      .all(sessionId) as Array<{ type: string }>;

    expect(run.status).toBe("failed");
    expect(run.error).toContain("finished without returning any assistant output");
    expect(events.map((event) => event.type)).toContain("runtime.error");
    expect(events.map((event) => event.type)).toContain("run.failed");
  });

  it("persists a private-data-free Task State across a fresh simple run", async () => {
    const sessionId = `task-state-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing-session.jsonl"));
    let runId = "";
    const session = createMockPiSession({
      prompt: () => {
        const run = getActiveAgentRun(sessionId);
        if (!run) throw new Error("expected active run for Task State integration");
        runId = run.id;
        mocks.emitPiEvent({
          type: "message_update",
          message: { id: "assistant-message", role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Completed." },
        });
      },
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Fix a typo",
      sessionId,
      userMessageId: "message-1",
    });

    const state = getLatestHarnessTaskState(sessionId, runId);
    expect(state).toMatchObject({
      sessionId,
      runId,
      goalMessageId: "message-1",
      phase: "terminal",
      verificationStatus: "not_required",
    });
    expect(JSON.stringify(state)).not.toContain("Fix a typo");
    const snapshots = (
      getDatabase()
        .prepare(
          "select payload_json from agent_events where session_id = ? and type = 'harness.task_state' order by rowid",
        )
        .all(sessionId) as Array<{ payload_json: string }>
    )
      .map(
        ({ payload_json }) =>
          JSON.parse(payload_json) as Extract<AgentEvent, { type: "harness.task_state" }>,
      )
      .filter((event) => event.runId === runId);
    expect(snapshots).toHaveLength(4);
    expect(snapshots.map(({ state }) => state.phase)).toEqual([
      "preflight",
      "executing",
      "verifying",
      "terminal",
    ]);
  });

  it("rechecks QA after a restore during deferred turn-end capture", async () => {
    const sessionId = `task-state-restore-race-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing-session.jsonl"));
    let runId = "";
    let releaseTurnEnd!: (
      value: Awaited<ReturnType<typeof checkpointService.createCheckpoint>>,
    ) => void;
    let notifyTurnEnd!: () => void;
    const turnEndGate = new Promise<Awaited<ReturnType<typeof checkpointService.createCheckpoint>>>(
      (resolve) => {
        releaseTurnEnd = resolve;
      },
    );
    const turnEndStarted = new Promise<void>((resolve) => {
      notifyTurnEnd = resolve;
    });
    vi.spyOn(gitMemoryContext, "getChangeStatsSinceStrict").mockResolvedValue({
      files: [],
      added: 0,
      removed: 0,
      fileCount: 0,
      truncated: false,
    });
    vi.spyOn(checkpointService, "createCheckpoint").mockImplementation(async (checkpointInput) => {
      const checkpoint = {
        id: checkpointInput.kind === "turn-end" ? "turn-end-checkpoint" : "run-checkpoint",
        sessionId: checkpointInput.sessionId,
        cwd: checkpointInput.cwd,
        commitHash: "abc123",
        kind: checkpointInput.kind ?? "auto",
        createdAt: new Date().toISOString(),
        ...(checkpointInput.runId ? { runId: checkpointInput.runId } : {}),
        ...(checkpointInput.userMessageId ? { userMessageId: checkpointInput.userMessageId } : {}),
      } as const;
      if (checkpointInput.kind === "turn-end") {
        notifyTurnEnd();
        return await turnEndGate;
      }
      return checkpoint;
    });
    const session = createMockPiSession({
      prompt: () => {
        const run = getActiveAgentRun(sessionId);
        if (!run) throw new Error("expected active run for restore-race test");
        runId = run.id;
        recordAgentEvent({
          type: "tool.started",
          sessionId,
          runId,
          toolCallId: "tests-before-restore",
          toolName: "bash",
          args: { command: "vitest run" },
        });
        recordAgentEvent({
          type: "tool.ended",
          sessionId,
          runId,
          toolCallId: "tests-before-restore",
          toolName: "bash",
          isError: false,
          exitCode: 0,
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { id: "assistant-message", role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Tests passed." },
        });
      },
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    const prompt = new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Run tests",
      sessionId,
      userMessageId: "message-restore-race",
    });
    await turnEndStarted;
    const startedRow = getDatabase()
      .prepare(
        "select rowid from agent_events where session_id = ? and type = 'run.started' order by rowid desc limit 1",
      )
      .get(sessionId) as { rowid: number };
    const restoreEvent = {
      type: "checkpoint.restored" as const,
      sessionId,
      checkpointId: "restore-during-capture",
    };
    expect(recordAgentEvent(restoreEvent)).toBeGreaterThan(startedRow.rowid);
    releaseTurnEnd({
      id: "turn-end-checkpoint",
      sessionId,
      cwd,
      commitHash: "def456",
      kind: "turn-end",
      createdAt: new Date().toISOString(),
    });
    await prompt;

    const rows = getDatabase()
      .prepare("select type, payload_json from agent_events where session_id = ? order by rowid")
      .all(sessionId) as Array<{ type: string; payload_json: string }>;
    const outcomes = rows.flatMap(({ type, payload_json }) => {
      const event = JSON.parse(payload_json) as {
        type: string;
        runId?: string;
        result?: { status?: string };
      };
      if (type === "checkpoint.restored") return [type];
      if (event.runId !== runId) return [];
      if (type === "harness.qa") return [`harness.qa:${event.result?.status}`];
      return type === "checkpoint.restored" || type === "run.completed" ? [type] : [];
    });
    expect(outcomes).toEqual([
      "harness.qa:passed",
      "checkpoint.restored",
      "harness.qa:missing",
      "run.completed",
    ]);
    expect(getLatestHarnessTaskState(sessionId, runId)?.verificationStatus).toBe("unknown");
  });

  it("completes a run when PI emits assistant text", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({
            type: "message_start",
            message: { role: "assistant" },
          });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "hello" },
          });
          mocks.emitPiEvent({
            type: "message_end",
            message: { role: "assistant" },
          });
        }),
      }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const settled: unknown[] = [];
    runtime.onTurnSettled((event) => settled.push(event));
    const questionPending = vi.fn();
    runtime.onQuestionPending(questionPending);

    const result = await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "hello",
      sessionId,
      userMessageId: "local-user-output",
    });
    expect(result).toEqual({ outcome: "ok", finalText: "hello" });
    expect(settled).toEqual([{ sessionId, origin: "prompt", result }]);
    expect(questionPending).not.toHaveBeenCalled();
    expect(runtime.isSessionStreaming(sessionId)).toBe(false);

    const run = getDatabase()
      .prepare(
        "select status, error from agent_runs where session_id = ? order by started_at desc limit 1",
      )
      .get(sessionId) as { status: string; error: string | null };
    const events = getDatabase()
      .prepare(
        "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
      )
      .all(sessionId) as Array<{ type: string }>;

    expect(run).toEqual({ status: "completed", error: null });
    expect(events.map((event) => event.type)).toContain("message.delta");
    expect(events.map((event) => event.type)).toContain("run.completed");
  });

  it("publishes busy then idle run-status around a turn", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "hi",
      sessionId,
      userMessageId: "local-user-status",
    });

    const statuses = (
      getDatabase()
        .prepare(
          "select payload_json from agent_events where session_id = ? and type = 'session.status' order by created_at asc, rowid asc",
        )
        .all(sessionId) as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json).status.type);
    // The composer's lock follows this: working while the turn runs, released
    // exactly once it ends.
    expect(statuses).toEqual(["busy", "idle"]);
  });

  it("spawns immediately and wait harvests output after the child settles", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    let releasePrompt: (() => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePrompt = () => {
            mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
            mocks.emitPiEvent({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: { type: "text_delta", delta: "done" },
            });
            mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
            resolve();
          };
        }),
    );
    const childPiSession = createMockPiSession({ prompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: childPiSession }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const started = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Audit files",
      prompt: "Audit files and report back.",
      subagentType: "reviewer",
    });

    expect(started.session.parentSessionId).toBe(parentSessionId);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(childPiSession.dispose).not.toHaveBeenCalled();
    const childRun = getActiveAgentRun(started.session.id);
    if (!childRun) throw new Error("expected active child run");
    const childMemory = proposeMemoryForRun({
      sessionId: started.session.id,
      workspaceId,
      runId: childRun.id,
      ...(childRun.userMessageId ? { userMessageId: childRun.userMessageId } : {}),
      cwd: started.session.cwd,
      title: "Child reusable fact",
      claim: "The child found a reusable cache key normalization rule.",
    });
    for (let index = 0; index < 40; index += 1) {
      const extraSessionId = `child-extra-session-${index}-${crypto.randomUUID()}`;
      const runId = `child-extra-run-${index}-${crypto.randomUUID()}`;
      const userMessageId = `child-extra-message-${index}`;
      const now = new Date().toISOString();
      getDatabase()
        .prepare(`insert into agent_sessions
        (id, workspace_id, title, cwd, status, parent_session_id, created_at, updated_at)
        values (?, ?, ?, ?, 'idle', ?, ?, ?)`)
        .run(
          extraSessionId,
          workspaceId,
          `Additional child ${index}`,
          started.session.cwd,
          parentSessionId,
          now,
          now,
        );
      getDatabase()
        .prepare(`insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at)
        values (?, ?, ?, ?, 'completed', ?)`)
        .run(runId, extraSessionId, userMessageId, "additional evidence run", now);
      proposeMemoryForRun({
        sessionId: extraSessionId,
        workspaceId,
        runId,
        userMessageId,
        cwd: started.session.cwd,
        title: "Child reusable fact",
        claim: "The child found a reusable cache key normalization rule.",
      });
    }
    const boundedChildMemory = projectMemory
      .getProjectMemorySnapshot(workspaceId)
      .memories.find((memory) => memory.id === childMemory.id);
    expect(
      boundedChildMemory?.evidence.some((evidence) => evidence.sessionId === started.session.id),
    ).toBe(false);
    mocks.setManagedProcesses([
      {
        id: "terminal-child",
        kind: "terminal",
        origin: "agent",
        sessionId: started.session.id,
        label: "dev server",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    ]);
    const waiting = runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 5_000,
      subagentIds: [started.session.id],
    });
    releasePrompt?.();
    const waited = await waiting;

    expect(waited.subagents).toEqual([
      expect.objectContaining({
        id: started.session.id,
        status: "completed",
        output: "done",
        memoryCandidates: [
          expect.objectContaining({
            id: childMemory.id,
            category: "decision",
            claim: "The child found a reusable cache key normalization rule.",
          }),
        ],
      }),
    ]);
    expect(waited.subagents[0]?.memoryCandidates?.[0]).not.toHaveProperty("output");
    expect(childPiSession.dispose).toHaveBeenCalled();
    expect(mocks.listManagedProcesses).toHaveBeenCalledWith({
      sessionId: started.session.id,
      origin: "agent",
    });
    expect(mocks.killManagedProcess).toHaveBeenCalledWith("terminal-child");
  });

  it("returns immediately for background subagents and stashes results for wait", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");

    let releaseChild: (() => void) | undefined;
    const childPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseChild = () => {
            mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
            mocks.emitPiEvent({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: { type: "text_delta", delta: "bg research done" },
            });
            mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
            resolve();
          };
        }),
    );

    mocks.createAgentSession.mockImplementation(async () => ({
      session: createMockPiSession({ prompt: childPrompt }),
    }));

    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const started = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Research topic",
      prompt: "Dig deep.",
      subagentType: "researcher",
    });

    expect(started.session.id).toBeTruthy();
    await vi.waitFor(() => expect(childPrompt).toHaveBeenCalled());

    // Harvest while/after the child finishes — wait is the only delivery path.
    const waiting = runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 5_000,
    });
    releaseChild?.();
    const waited = await waiting;
    expect(waited.timedOut).toBe(false);
    expect(waited.subagents).toEqual([
      expect.objectContaining({
        id: started.session.id,
        status: "completed",
        output: "bg research done",
      }),
    ]);

    const again = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 0,
    });
    expect(again.subagents).toEqual([]);
  });

  it("keeps background results for wait even when finished outside an active wait", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");

    let releaseChild: (() => void) | undefined;
    const childPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseChild = () => {
            mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
            mocks.emitPiEvent({
              type: "message_update",
              message: { role: "assistant" },
              assistantMessageEvent: { type: "text_delta", delta: "async done" },
            });
            mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
            resolve();
          };
        }),
    );
    const parentPrompt = vi.fn(async (message: string) => {
      void message;
    });

    let createCount = 0;
    mocks.createAgentSession.mockImplementation(async () => {
      createCount += 1;
      if (createCount === 1) {
        return { session: createMockPiSession({ prompt: childPrompt }) };
      }
      return { session: createMockPiSession({ prompt: parentPrompt }) };
    });

    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const started = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Async dig",
      prompt: "Go.",
      subagentType: "researcher",
    });
    await vi.waitFor(() => expect(childPrompt).toHaveBeenCalled());
    releaseChild?.();
    // No follow-up inject — parent prompt must not be called for delivery.
    await vi.waitFor(() => {
      expect(getAgentSession(started.session.id)?.status).toBe("idle");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(parentPrompt).not.toHaveBeenCalled();

    const waited = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 0,
    });
    expect(waited.subagents).toEqual([
      expect.objectContaining({
        id: started.session.id,
        status: "completed",
        output: "async done",
      }),
    ]);
  });

  it("releaseRuntime does not wipe unharvested background results", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");

    let releaseChild: (() => void) | undefined;
    mocks.createAgentSession.mockImplementation(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChild = () => {
                mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
                mocks.emitPiEvent({
                  type: "message_update",
                  message: { role: "assistant" },
                  assistantMessageEvent: { type: "text_delta", delta: "survived release" },
                });
                mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
                resolve();
              };
            }),
        ),
      }),
    }));

    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const started = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Keep me",
      prompt: "Go.",
      subagentType: "researcher",
    });
    await vi.waitFor(() => expect(releaseChild).toBeTypeOf("function"));
    releaseChild?.();
    await vi.waitFor(() => {
      const session = getAgentSession(started.session.id);
      expect(session?.status).toBe("idle");
    });
    // Allow finishBackgroundSubagent to stash after prompt settles.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await runtime.releaseRuntime(started.session.id);

    const waited = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 0,
      subagentIds: [started.session.id],
    });
    expect(waited.subagents).toEqual([
      expect.objectContaining({
        id: started.session.id,
        status: "completed",
        output: "survived release",
      }),
    ]);
  });

  it("wait holds until all watched subagents settle", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const releases: Array<() => void> = [];
    const makeSession = (output: string): Record<string, unknown> => {
      let subscriber: ((event: unknown) => void) | undefined;
      return createMockPiSession({
        subscribe: vi.fn((callback: (event: unknown) => void) => {
          subscriber = callback;
          return vi.fn();
        }),
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releases.push(() => {
                subscriber?.({ type: "message_start", message: { role: "assistant" } });
                subscriber?.({
                  type: "message_update",
                  message: { role: "assistant" },
                  assistantMessageEvent: { type: "text_delta", delta: output },
                });
                subscriber?.({ type: "message_end", message: { role: "assistant" } });
                resolve();
              });
            }),
        ),
      });
    };
    mocks.createAgentSession
      .mockImplementationOnce(async () => ({ session: makeSession("first done") }))
      .mockImplementationOnce(async () => ({ session: makeSession("second done") }));

    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const first = await runtime.runSubagent(window, {
      parentSessionId,
      task: "First",
      prompt: "A",
      subagentType: "worker",
    });
    const second = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Second",
      prompt: "B",
      subagentType: "worker",
    });
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    const waiting = runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 5_000,
    });
    releases[0]?.();
    // One finished is not enough — wait must still be pending.
    await new Promise((resolve) => setTimeout(resolve, 400));
    releases[1]?.();
    const waited = await waiting;
    expect(waited.timedOut).toBe(false);
    expect(waited.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.session.id,
          status: "completed",
          output: "first done",
        }),
        expect.objectContaining({
          id: second.session.id,
          status: "completed",
          output: "second done",
        }),
      ]),
    );
  });

  it("wait times out while a background subagent is still running", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    let releaseChild: (() => void) | undefined;
    mocks.createAgentSession.mockImplementation(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChild = () => resolve();
            }),
        ),
      }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();
    const started = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Slow dig",
      prompt: "Take your time.",
      subagentType: "researcher",
    });
    const waited = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 300,
    });
    expect(waited.timedOut).toBe(true);
    expect(waited.subagents).toEqual([
      expect.objectContaining({ id: started.session.id, status: "running" }),
    ]);
    releaseChild?.();
  });

  it("task tool returns before the child finishes", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    let releaseChild: (() => void) | undefined;
    mocks.createAgentSession.mockImplementation(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChild = () => resolve();
            }),
        ),
      }),
    }));
    new PiSdkRuntime();
    const window = createWindowStub();
    setTaskToolContext(workspaceId, parentSessionId, window);
    const taskTool = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((definition) => definition.name === "task") as {
      execute(
        toolCallId: string,
        params: { description: string; prompt: string },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: { cwd: string },
      ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
    };

    const result = await taskTool.execute(
      "task-bg",
      { description: "Parallel dig", prompt: "Go dig." },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    expect(result.content[0]?.text).toContain("Background task started");
    expect(result.content[0]?.text).toContain("wait()");
    expect(result.content[0]?.text).toContain("DO NOT sleep");
    releaseChild?.();
  });

  it("wait tool collects a background subagent result in-process", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    let releaseChild: (() => void) | undefined;
    mocks.createAgentSession.mockImplementation(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChild = () => {
                mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
                mocks.emitPiEvent({
                  type: "message_update",
                  message: { role: "assistant" },
                  assistantMessageEvent: { type: "text_delta", delta: "tool wait done" },
                });
                mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
                resolve();
              };
            }),
        ),
      }),
    }));
    new PiSdkRuntime();
    const window = createWindowStub();
    setTaskToolContext(workspaceId, parentSessionId, window);
    const tools = toolRegistry.getCustomToolDefinitions("chat");
    const taskTool = tools.find((definition) => definition.name === "task") as {
      execute(
        toolCallId: string,
        params: { description: string; prompt: string },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: { cwd: string },
      ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
    };
    const waitTool = tools.find((definition) => definition.name === "wait") as {
      execute(
        toolCallId: string,
        params: { timeout_ms?: number },
        signal: AbortSignal,
        onUpdate: undefined,
        ctx: { cwd: string },
      ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
    };

    await taskTool.execute(
      "task-bg-wait",
      { description: "Collect me", prompt: "Finish." },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    await vi.waitFor(() => expect(releaseChild).toBeTypeOf("function"));
    const waiting = waitTool.execute(
      "wait-1",
      { timeout_ms: 5_000 },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    releaseChild?.();
    const waited = await waiting;
    expect(waited.content[0]?.text).toContain("Waited");
    expect(waited.content[0]?.text).toMatch(/for subagent/i);
    expect(waited.content[0]?.text).toContain("tool wait done");
  });

  it("runs independent subagents concurrently; wait joins both results", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const releases: Array<() => void> = [];
    const makeSession = (output: string): Record<string, unknown> => {
      let subscriber: ((event: unknown) => void) | undefined;
      return createMockPiSession({
        subscribe: vi.fn((callback: (event: unknown) => void) => {
          subscriber = callback;
          return vi.fn();
        }),
        prompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releases.push(() => {
                subscriber?.({ type: "message_start", message: { role: "assistant" } });
                subscriber?.({
                  type: "message_update",
                  message: { role: "assistant" },
                  assistantMessageEvent: { type: "text_delta", delta: output },
                });
                subscriber?.({ type: "message_end", message: { role: "assistant" } });
                resolve();
              });
            }),
        ),
      });
    };
    mocks.createAgentSession
      .mockImplementationOnce(async () => ({ session: makeSession("first result") }))
      .mockImplementationOnce(async () => ({ session: makeSession("second result") }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const first = await runtime.runSubagent(window, {
      parentSessionId,
      task: "First task",
      prompt: "Do first task.",
      subagentType: "worker",
    });
    const second = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Second task",
      prompt: "Do second task.",
      subagentType: "worker",
    });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const waiting = runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 5_000,
    });
    for (const release of releases) {
      release();
    }
    const waited = await waiting;
    expect(waited.timedOut).toBe(false);
    expect(waited.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.session.id,
          status: "completed",
          output: "first result",
        }),
        expect.objectContaining({
          id: second.session.id,
          status: "completed",
          output: "second result",
        }),
      ]),
    );
  });

  it("stashes subagent failures for wait and disposes the child runtime", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const childPiSession = createMockPiSession({
      prompt: vi.fn(async () => {
        throw new Error("child failed");
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: childPiSession }));
    const runtime = new PiSdkRuntime();

    const started = await runtime.runSubagent(createWindowStub(), {
      parentSessionId,
      task: "Failing task",
      prompt: "Fail now.",
      subagentType: "worker",
    });
    const waited = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 5_000,
      subagentIds: [started.session.id],
    });
    expect(waited.subagents).toEqual([
      expect.objectContaining({
        id: started.session.id,
        status: "error",
        output: "child failed",
      }),
    ]);
    expect(childPiSession.dispose).toHaveBeenCalled();
  });

  it("applies configured subagent prompt and readonly tools", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const prompt = vi.fn(async (_message: string) => {
      mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      });
      mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
    });
    const childPiSession = createMockPiSession({ prompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: childPiSession }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    toolRegistry.registerTool({
      entry: {
        name: "synthetic_mutator",
        profiles: ["chat"],
        permission: { danger: "dangerous", action: "file.write" },
        ui: { iconName: "favicon", verb: "Mutated" },
      },
      definition: { name: "synthetic_mutator" } as never,
    });
    try {
      await runtime.runSubagent(window, {
        parentSessionId,
        task: "Audit auth",
        prompt: "Check login changes.",
        subagentType: "security-auditor",
        subagent: {
          name: "security-auditor",
          body: "You are a security reviewer.",
          model: "inherit",
          readOnly: true,
        },
      });

      await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
      const message = prompt.mock.calls[0]?.[0] as unknown as string;
      expect(message).toContain('<subagent_definition name="security-auditor">');
      expect(message).toContain("You are a security reviewer.");
      expect(message).toContain("<task>\nCheck login changes.\n</task>");

      const setActiveToolsByName = childPiSession.setActiveToolsByName as ReturnType<typeof vi.fn>;
      const activeTools = setActiveToolsByName.mock.calls[0]?.[0] as string[];
      expect(activeTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
      expect(activeTools).not.toEqual(
        expect.arrayContaining(["bash", "edit", "write", "terminal_run", "browser_cdp", "task"]),
      );
      expect(activeTools).not.toContain("wait");
      expect(activeTools).not.toContain("synthetic_mutator");

      const send = window.webContents.send as unknown as ReturnType<typeof vi.fn>;
      expect(send).toHaveBeenCalledWith(
        "agent:event",
        expect.objectContaining({
          type: "subagent.started",
          subagentType: "security-auditor",
        }),
      );
    } finally {
      toolRegistry.unregisterTool("synthetic_mutator");
    }
  });

  it("applies configured subagent tool allow and deny lists", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const agentsDir = join(cwd, ".modus", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "limited-agent.md"),
      "---\nname: limited-agent\ntools: [read, grep, web_search]\ndisallowedTools: [grep]\n---\nLimited agent.",
      "utf8",
    );
    const childPiSession = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: childPiSession }));
    const runtime = new PiSdkRuntime();

    await runtime.runSubagent(createWindowStub(), {
      parentSessionId,
      task: "Limited work",
      prompt: "Read only selected tools.",
      subagentType: "limited-agent",
      subagent: {
        name: "limited-agent",
        body: "Limited agent.",
        model: "inherit",
        readOnly: false,
      },
    });

    await vi.waitFor(() => expect(childPiSession.setActiveToolsByName).toHaveBeenCalled());
    const activeTools = (childPiSession.setActiveToolsByName as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    expect(activeTools).not.toContain("grep");
    expect(activeTools).not.toContain("find");
  });

  it("creates writable worktree-isolated subagents in their own checkout", async () => {
    await initGitRepo();
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    let childCwd = "";
    const childPiSession = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "worktree complete" },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async (options: unknown) => {
      childCwd = (options as { cwd: string }).cwd;
      return { session: childPiSession };
    });
    const runtime = new PiSdkRuntime();

    const result = await runtime.runSubagent(createWindowStub(), {
      parentSessionId,
      task: "Write child file",
      prompt: "Create child.txt.",
      subagentType: "writer",
      subagent: {
        name: "writer",
        body: "Write code.",
        model: "inherit",
        readOnly: false,
        isolation: "worktree",
      },
    });

    expect(result.session.cwd.replace(/\\/g, "/")).toContain("/.modus/worktrees/writer-");
    expect(childCwd).toBe(result.session.cwd);
    expect(existsSync(result.session.cwd)).toBe(true);
    expect(existsSync(join(cwd, ".modus", "worktrees"))).toBe(true);

    await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 5_000,
      subagentIds: [result.session.id],
    });
    expect(getAgentSession(result.session.id)?.subagentWorktree?.integrationStatus).toBe(
      "no_changes",
    );
  });

  it("does not inject subagent run status into root prompts", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const childSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    insertSubagentSession(childSessionId, parentSessionId, workspaceId);
    recordAgentEvent({
      type: "message.started",
      sessionId: childSessionId,
      messageId: "assistant-message",
      role: "assistant",
    });
    recordAgentEvent({
      type: "message.delta",
      sessionId: childSessionId,
      messageId: "assistant-message",
      delta: "final result",
    });
    recordAgentEvent({
      type: "message.completed",
      sessionId: childSessionId,
      messageId: "assistant-message",
    });
    const prompt = vi.fn(async (_message: string) => {
      mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
      mocks.emitPiEvent({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "parent done" },
      });
      mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt }),
    }));
    const runtime = new PiSdkRuntime();

    await runtime.prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "continue",
      sessionId: parentSessionId,
      userMessageId: "local-user-subagent-runs",
    });

    const message = prompt.mock.calls[0]?.[0] as string;
    expect(message).not.toContain("<subagent_runs>");
    expect(message).not.toContain(childSessionId);
    expect(message).not.toContain("last_result");
    expect(message).not.toContain("final result");
  });

  it("aborts active subagents when the parent session is aborted", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    let rejectPrompt: ((error: Error) => void) | undefined;
    const childPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    const childAbort = vi.fn(async () => rejectPrompt?.(new Error("aborted")));
    const childPiSession = createMockPiSession({ abort: childAbort, prompt: childPrompt });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session: childPiSession }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const started = await runtime.runSubagent(window, {
      parentSessionId,
      task: "Run checks",
      prompt: "Run checks.",
      subagentType: "worker",
    });
    await vi.waitFor(() => expect(childPrompt).toHaveBeenCalled());
    mocks.setManagedProcesses([
      {
        id: "app-child",
        kind: "app",
        origin: "agent",
        sessionId: started.session.id,
        label: "Preview",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    ]);

    await runtime.abort(parentSessionId);

    expect(childAbort).toHaveBeenCalledOnce();
    expect(childPiSession.dispose).toHaveBeenCalled();
    expect(mocks.killManagedProcess).toHaveBeenCalledWith("app-child");
    expect(
      getDatabase()
        .prepare("select status from agent_sessions where id = ?")
        .get(started.session.id),
    ).toEqual({ status: "cancelled" });
  });

  it("does not count completed subagents against the active subagent limit", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    for (let index = 0; index < 6; index += 1) {
      insertSubagentSession(`child-${crypto.randomUUID()}`, parentSessionId, workspaceId);
    }
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "done" },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
        }),
      }),
    }));
    const runtime = new PiSdkRuntime();

    await expect(
      runtime.runSubagent(createWindowStub(), {
        parentSessionId,
        task: "Fresh child",
        prompt: "Do work.",
        subagentType: "worker",
      }),
    ).resolves.toMatchObject({
      session: expect.objectContaining({
        parentSessionId,
        subagentTask: "Fresh child",
      }),
    });
  });

  it("archives child sessions before deleting the parent session", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const childSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent chat");
    const completedRun = createAgentRun({
      sessionId: parentSessionId,
      prompt: "completed before explicit close",
      userMessageId: "archive-user-message",
    });
    updateAgentRunStatus(completedRun.id, "completed");
    const closedMemory = proposeMemoryForRun({
      sessionId: parentSessionId,
      workspaceId,
      runId: completedRun.id,
      userMessageId: "archive-user-message",
      cwd,
      title: "Close sweep memory",
      claim: "Explicit close finalizes durable memories from completed runs.",
    });
    insertSubagentSession(childSessionId, parentSessionId, workspaceId);
    mocks.setManagedProcesses([
      {
        id: "terminal-archive-child",
        kind: "terminal",
        origin: "agent",
        sessionId: childSessionId,
        label: "dev server",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    ]);

    await deleteAgentSessionTree(parentSessionId);

    expect(mocks.killManagedProcess).toHaveBeenCalledWith("terminal-archive-child");
    expect(
      getDatabase()
        .prepare("select count(*) as count from agent_sessions where id in (?, ?)")
        .get(parentSessionId, childSessionId),
    ).toEqual({ count: 0 });
    expect(
      projectMemory
        .getProjectMemorySnapshot(workspaceId)
        .memories.find((memory) => memory.id === closedMemory.id)?.status,
    ).toBe("active");
  });

  it("finalizes completed runs on explicit archive but does not treat runtime release as completion", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "Archive sweep chat");
    const archivedRun = createAgentRun({
      sessionId,
      prompt: "completed before archive",
      userMessageId: "archive-sweep-message",
    });
    updateAgentRunStatus(archivedRun.id, "completed");
    const archivedMemory = proposeMemoryForRun({
      sessionId,
      workspaceId,
      runId: archivedRun.id,
      userMessageId: "archive-sweep-message",
      cwd,
      title: "Archive sweep memory",
      claim: "Explicit archive finalizes the completed memory candidate.",
    });
    await setAgentSessionArchivedTree(sessionId, true);
    expect(
      projectMemory
        .getProjectMemorySnapshot(workspaceId)
        .memories.find((memory) => memory.id === archivedMemory.id)?.status,
    ).toBe("active");

    const releaseSessionId = `session-${crypto.randomUUID()}`;
    const releaseWorkspaceId = workspaceId;
    const now = new Date().toISOString();
    getDatabase()
      .prepare(`insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
      values (?, ?, ?, ?, 'idle', ?, ?)`)
      .run(releaseSessionId, releaseWorkspaceId, "Released chat", cwd, now, now);
    const releaseRun = createAgentRun({
      sessionId: releaseSessionId,
      prompt: "not an explicit completion",
    });
    updateAgentRunStatus(releaseRun.id, "running");
    const releasedMemory = proposeMemoryForRun({
      sessionId: releaseSessionId,
      workspaceId: releaseWorkspaceId,
      runId: releaseRun.id,
      cwd,
      title: "Release must not finalize",
      claim: "Runtime release alone does not signal run completion.",
    });
    await new PiSdkRuntime().releaseRuntime(releaseSessionId);
    expect(
      projectMemory
        .getProjectMemorySnapshot(releaseWorkspaceId)
        .memories.find((memory) => memory.id === releasedMemory.id)?.status,
    ).toBe("candidate");
  });

  it("queues a steer message into the live turn without opening a phantom run", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const prompt = vi.fn(async () => undefined);
    // A turn is already streaming: a steer message must JOIN it (pi queues it
    // and resolves immediately), never get its own run lifecycle — that phantom
    // run.started→run.failed is exactly what used to unlock the composer mid-turn.
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ isStreaming: true, prompt }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, {
      context: [],
      delivery: "steer",
      message: "actually use bun",
      sessionId,
      userMessageId: "local-user-steer",
    });

    const runCount = getDatabase()
      .prepare("select count(*) as count from agent_runs where session_id = ?")
      .get(sessionId);
    expect(runCount).toEqual({ count: 0 });

    const types = (
      getDatabase()
        .prepare(
          "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
        )
        .all(sessionId) as Array<{ type: string }>
    ).map((row) => row.type);
    expect(types).toContain("message.started");
    expect(types).not.toContain("run.started");
    expect(types).not.toContain("run.failed");
    expect(types).not.toContain("session.status");
    expect(prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ streamingBehavior: "steer" }),
    );
  });

  it("fails the run from the last assistant error when the turn ends in error", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    let failedAttemptMemoryId: string | undefined;
    let ordinaryMemoryId: string | undefined;
    // The turn streams some text, then ends with the last assistant message
    // carrying stopReason "error" — i.e. auto-retries were exhausted. The
    // authoritative outcome is read from that message, surfaced once as a fatal
    // run.failed (never doubled, never a red retry line).
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        state: {
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "Provider is overloaded" },
          ],
        },
        prompt: vi.fn(async () => {
          const activeRun = getActiveAgentRun(sessionId);
          if (!activeRun) throw new Error("expected active run");
          failedAttemptMemoryId = proposeMemoryForRun({
            sessionId,
            workspaceId,
            runId: activeRun.id,
            cwd,
            title: "Failed attempt memory",
            claim: "The attempted migration failed due to the unavailable endpoint.",
            category: "failed_attempt",
          }).id;
          ordinaryMemoryId = proposeMemoryForRun({
            sessionId,
            workspaceId,
            runId: activeRun.id,
            cwd,
            title: "Ordinary solution memory",
            claim: "The solution uses a cache to avoid repeated endpoint calls.",
            category: "solution",
          }).id;
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "partial" },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
        }),
      }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "go",
      sessionId,
      userMessageId: "local-user-fatal",
    });

    const run = getDatabase()
      .prepare(
        "select status, error from agent_runs where session_id = ? order by started_at desc limit 1",
      )
      .get(sessionId) as { status: string; error: string };
    const types = (
      getDatabase()
        .prepare(
          "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
        )
        .all(sessionId) as Array<{ type: string }>
    ).map((row) => row.type);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Provider is overloaded");
    expect(types).toContain("run.failed");
    expect(types).not.toContain("run.completed");
    const memories = projectMemory.getProjectMemorySnapshot(workspaceId).memories;
    expect(memories.find((memory) => memory.id === failedAttemptMemoryId)?.status).toBe("active");
    expect(memories.find((memory) => memory.id === ordinaryMemoryId)?.status).toBe("candidate");
  });

  it("drives a plan's build status from the build turn lifecycle and tags the message", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const plansRoot = join(userData, "plans");
    const plan = writePlan(plansRoot, {
      workspaceId,
      sessionId,
      title: "Feat",
      overview: "Build the thing.",
      content: "# Feat\n",
      todos: [{ content: "Step one" }, { content: "Step two" }],
    });
    expect(plan.buildStatus).toBe("not_built");

    // The build turn produces output and completes cleanly.
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "building" },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
        }),
      }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: `Build the approved plan "Feat".`,
      sessionId,
      userMessageId: "local-user-build",
      planId: plan.id,
    });

    // Completed build turn → plan is built.
    expect(readPlanById(plansRoot, plan.id)?.buildStatus).toBe("built");

    const rows = getDatabase()
      .prepare(
        "select type, payload_json from agent_events where session_id = ? order by created_at asc, rowid asc",
      )
      .all(sessionId) as Array<{ type: string; payload_json: string }>;
    // The build user message is tagged so the timeline renders a Build card.
    const userMessage = rows.find((row) => row.type === "message.started");
    expect(JSON.parse(userMessage?.payload_json ?? "{}").planBuild).toEqual({
      planId: plan.id,
      title: "Feat",
      todoCount: 2,
    });
    // Status transitions are broadcast so the Plan panel + Review card react.
    expect(rows.filter((row) => row.type === "plan.updated").length).toBeGreaterThanOrEqual(2);
  });

  it("derives and persists checks for a todo-side-only linked criterion", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "Reciprocal Spec");
    await initGitRepoWithKnownEmptyScope();
    const plansRoot = join(userData, "plans");
    const plan = writePlan(plansRoot, {
      workspaceId,
      sessionId,
      title: "Reciprocal Spec",
      overview: "Use todo-side links.",
      content: "# Reciprocal Spec",
      todos: [
        {
          id: "todo-reciprocal",
          content: "Implement the check",
          acceptanceCriterionIds: ["ac-reciprocal"],
        },
      ],
      spec: {
        requirements: [{ id: "req", text: "Verify the linked criterion." }],
        acceptanceCriteria: [
          {
            id: "ac-reciprocal",
            requirementId: "req",
            description: "Check is linked from the todo.",
            todoIds: [],
            requiredCheckKinds: ["typecheck"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({
          type: "tool_execution_start",
          toolCallId: "reciprocal-typecheck",
          toolName: "terminal_run",
          args: { command: "tsc --noEmit" },
        });
        mocks.emitPiEvent({
          type: "tool_execution_end",
          toolCallId: "reciprocal-typecheck",
          toolName: "terminal_run",
          isError: false,
          result: { details: { exitCode: 0 } },
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Reciprocal Spec finished." },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Build the approved plan.",
      sessionId,
      planId: plan.id,
    });

    const qaPayload = (
      getDatabase()
        .prepare(
          "select payload_json from agent_events where session_id = ? and type = 'harness.qa'",
        )
        .get(sessionId) as { payload_json: string }
    ).payload_json;
    expect(JSON.parse(qaPayload)).toMatchObject({
      result: {
        required: true,
        evidence: [expect.objectContaining({ label: "Typecheck", status: "passed" })],
      },
    });
    const updated = readPlanById(plansRoot, plan.id);
    expect(updated?.spec?.acceptanceCriteria[0]?.status).toBe("passed");
    expect(updated?.spec?.evidence).toEqual([
      expect.objectContaining({
        criterionId: "ac-reciprocal",
        label: "Typecheck",
        status: "passed",
      }),
    ]);
  });

  it("harvests discoveries only for selected completed children owned by the parent", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const foreignParentId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent");
    const foreignWorkspaceId = `workspace-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(foreignWorkspaceId, join(cwd, "foreign-root"), "foreign", 1, now, now);
    getDatabase()
      .prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(foreignParentId, foreignWorkspaceId, "Foreign Parent", cwd, "idle", now, now);
    const ownedChildId = `child-${crypto.randomUUID()}`;
    const foreignChildId = `child-${crypto.randomUUID()}`;
    const unselectedChildId = `child-${crypto.randomUUID()}`;
    const runningChildId = `child-${crypto.randomUUID()}`;
    const sharedChildId = `child-${crypto.randomUUID()}`;
    insertSubagentSession(ownedChildId, parentSessionId, workspaceId);
    insertSubagentSession(foreignChildId, foreignParentId, foreignWorkspaceId);
    insertSubagentSession(unselectedChildId, parentSessionId, workspaceId);
    insertSubagentSession(runningChildId, parentSessionId, workspaceId);
    insertSubagentSession(sharedChildId, parentSessionId, workspaceId);
    const ownedHit = { path: "src/owned.ts", symbol: "owned", line: 4 };
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId: ownedChildId,
      runId: "owned-run",
      hits: [ownedHit],
      query: "private query text",
      sourceBody: "private source body",
    } as never);
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId: foreignChildId,
      runId: "foreign-run",
      hits: [{ path: "src/foreign.ts" }],
    });
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId: unselectedChildId,
      runId: "unselected-run",
      hits: [{ path: "src/unselected.ts" }],
    });
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId: runningChildId,
      runId: "running-run",
      hits: [{ path: "src/running.ts" }],
    });
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId: sharedChildId,
      runId: "shared-run",
      hits: [{ path: "src/shared.ts", symbol: "shared" }],
    });

    const runtime = new PiSdkRuntime();
    const backgroundTasks = (
      runtime as unknown as {
        backgroundChildTasks: Map<
          string,
          { parentSessionId: string; task: string; status: "running" | "completed"; output: string }
        >;
      }
    ).backgroundChildTasks;
    backgroundTasks.set(ownedChildId, {
      parentSessionId,
      task: "owned task",
      status: "completed",
      output: "owned output",
    });
    backgroundTasks.set(foreignChildId, {
      parentSessionId,
      task: "foreign task",
      status: "completed",
      output: "foreign output",
    });
    backgroundTasks.set(unselectedChildId, {
      parentSessionId,
      task: "unselected task",
      status: "completed",
      output: "unselected output",
    });
    backgroundTasks.set(runningChildId, {
      parentSessionId,
      task: "running task",
      status: "running",
      output: "partial output",
    });
    backgroundTasks.set(sharedChildId, {
      parentSessionId,
      task: "shared task",
      status: "completed",
      output: "shared output",
    });

    const result = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 0,
      subagentIds: [ownedChildId, foreignChildId, runningChildId, sharedChildId],
    });

    expect(result.subagents.map(({ id }) => id)).toEqual([
      ownedChildId,
      foreignChildId,
      runningChildId,
      sharedChildId,
    ]);
    expect(result.subagents[0]?.discoveries).toEqual([{ runId: "owned-run", ...ownedHit }]);
    expect(result.subagents[1]?.discoveries).toBeUndefined();
    expect(result.subagents[2]?.discoveries).toBeUndefined();
    expect(result.subagents[3]?.discoveries).toEqual([
      { runId: "shared-run", path: "src/shared.ts", symbol: "shared" },
    ]);
    expect(JSON.stringify(result.subagents[0]?.discoveries)).not.toContain("private query text");
    expect(JSON.stringify(result.subagents[0]?.discoveries)).not.toContain("private source body");
  });

  it("deduplicates and bounds worktree discovery references while marking them provisional", async () => {
    const parentSessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(parentSessionId, workspaceId, join(userData, "missing.jsonl"), "Parent");
    const childSessionId = `child-${crypto.randomUUID()}`;
    insertSubagentSession(childSessionId, parentSessionId, workspaceId);
    updateAgentSessionWorktree(childSessionId, {
      path: join(cwd, "child-worktree"),
      branch: "task/child",
      baseSha: "base",
      integrationStatus: "ready",
    });
    const hits = Array.from({ length: 60 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      symbol: `symbol-${index}`,
    }));
    recordAgentEvent({
      type: "codegraph.discoveries",
      sessionId: childSessionId,
      runId: "worktree-run",
      hits: [...hits, hits[0]],
    } as never);
    const runtime = new PiSdkRuntime();
    const backgroundTasks = (
      runtime as unknown as {
        backgroundChildTasks: Map<
          string,
          { parentSessionId: string; task: string; status: "completed"; output: string }
        >;
      }
    ).backgroundChildTasks;
    backgroundTasks.set(childSessionId, {
      parentSessionId,
      task: "worktree task",
      status: "completed",
      output: "child report",
    });

    const result = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: 0,
      subagentIds: [childSessionId],
    });
    const discoveries = result.subagents[0]?.discoveries ?? [];

    expect(discoveries).toHaveLength(50);
    expect(new Set(discoveries.map(({ path }) => path)).size).toBe(50);
    expect(discoveries.every((reference) => reference.provisional === true)).toBe(true);
    expect(discoveries[0]).toMatchObject({
      runId: "worktree-run",
      path: "src/file-0.ts",
      symbol: "symbol-0",
    });
  });

  it.each([
    ["all current-run checks pass", "all", "verified"],
    ["partial current-run checks pass", "partial", "unknown"],
    ["checks are missing", "missing", "unknown"],
    ["a current-run check fails", "failed", "failed"],
    ["only foreign-run checks pass", "foreign", "unknown"],
    ["the strict scope lookup is unavailable", "scope-unavailable", "unknown"],
    ["the strict scope result is truncated", "scope-truncated", "unknown"],
  ] as const)("persists Spec Build Task State correctly when %s", async (_scenario, evidenceCase, expectedVerification) => {
    const sessionId = `task-state-spec-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "Spec build");
    await initGitRepoWithKnownEmptyScope();
    if (evidenceCase === "scope-unavailable") {
      vi.spyOn(gitMemoryContext, "getChangeStatsSinceStrict").mockResolvedValue(undefined);
    } else if (evidenceCase === "scope-truncated") {
      vi.spyOn(gitMemoryContext, "getChangeStatsSinceStrict").mockResolvedValue({
        files: [],
        added: 0,
        removed: 0,
        fileCount: 0,
        truncated: true,
      });
    }
    const plan = writePlan(join(userData, "plans"), {
      workspaceId,
      sessionId,
      title: "Spec",
      overview: "Build and verify linked checks.",
      content: "# Spec plan",
      todos: [
        {
          id: "todo-verify",
          content: "Verify implementation",
          acceptanceCriterionIds: ["ac-verify"],
        },
      ],
      spec: {
        requirements: [{ id: "req-verify", text: "Complete the implementation." }],
        acceptanceCriteria: [
          {
            id: "ac-verify",
            requirementId: "req-verify",
            description: "Tests and typecheck pass.",
            todoIds: ["todo-verify"],
            requiredCheckKinds: ["tests", "typecheck"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });
    let runId = "";
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        const run = getActiveAgentRun(sessionId);
        if (!run) throw new Error("expected active run for Spec Build Task State");
        runId = run.id;
        if (evidenceCase === "foreign") {
          for (const [index, command] of ["npm test", "tsc --noEmit"].entries()) {
            recordAgentEvent({
              type: "tool.started",
              sessionId,
              runId: "foreign-run",
              toolCallId: `foreign-check-${index}`,
              toolName: "terminal_run",
              args: { command },
            });
            recordAgentEvent({
              type: "tool.ended",
              sessionId,
              runId: "foreign-run",
              toolCallId: `foreign-check-${index}`,
              toolName: "terminal_run",
              exitCode: 0,
              isError: false,
            });
          }
        }
        const checks =
          evidenceCase === "all" ||
          evidenceCase === "failed" ||
          evidenceCase === "scope-unavailable" ||
          evidenceCase === "scope-truncated"
            ? ["npm test", "tsc --noEmit"]
            : evidenceCase === "partial"
              ? ["npm test"]
              : [];
        checks.forEach((command, index) => {
          const isError = evidenceCase === "failed" && index === 1;
          mocks.emitPiEvent({
            type: "tool_execution_start",
            toolCallId: `current-check-${index}`,
            toolName: "terminal_run",
            args: { command },
          });
          mocks.emitPiEvent({
            type: "tool_execution_end",
            toolCallId: `current-check-${index}`,
            toolName: "terminal_run",
            isError,
            result: { details: { exitCode: isError ? 1 : 0 } },
          });
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Spec Build finished." },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Build this plan",
      sessionId,
      planId: plan.id,
    });

    const persistedState = getLatestHarnessTaskState(sessionId, runId);
    expect(persistedState?.phase).toBe("terminal");
    expect(persistedState?.verificationStatus).toBe(expectedVerification);
    expect(persistedState?.criteria).toContainEqual(
      expect.objectContaining({
        source: "plan",
        status: expectedVerification,
        requiredCheckKinds: ["tests", "typecheck"],
      }),
    );
  });

  it("derives Spec Build checks and updates linked criteria only from current QA evidence", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "Spec build");
    await initGitRepoWithKnownEmptyScope();
    const plansRoot = join(userData, "plans");
    const plan = writePlan(plansRoot, {
      workspaceId,
      sessionId,
      title: "Spec",
      overview: "Build from acceptance criteria.",
      content: "# Spec plan",
      todos: [
        { id: "todo-pass", content: "Pass tests", acceptanceCriterionIds: ["ac-pass"] },
        { id: "todo-fail", content: "Fail typecheck", acceptanceCriterionIds: ["ac-fail"] },
        { id: "todo-skip", content: "Skip lint", acceptanceCriterionIds: ["ac-skip"] },
        { id: "todo-block", content: "Require build", acceptanceCriterionIds: ["ac-block"] },
        {
          id: "todo-manual",
          content: "Keep manual criterion pending",
          acceptanceCriterionIds: ["ac-manual"],
        },
      ],
      spec: {
        requirements: [{ id: "req", text: "Implement and verify the behavior." }],
        acceptanceCriteria: [
          {
            id: "ac-pass",
            requirementId: "req",
            description: "Tests pass.",
            todoIds: ["todo-pass"],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
          {
            id: "ac-fail",
            requirementId: "req",
            description: "Typecheck passes.",
            todoIds: ["todo-fail"],
            requiredCheckKinds: ["typecheck"],
            status: "pending",
          },
          {
            id: "ac-skip",
            requirementId: "req",
            description: "Lint passes.",
            todoIds: ["todo-skip"],
            requiredCheckKinds: ["lint"],
            status: "pending",
          },
          {
            id: "ac-block",
            requirementId: "req",
            description: "Build passes.",
            todoIds: ["todo-block"],
            requiredCheckKinds: ["build"],
            status: "pending",
          },
          {
            id: "ac-manual",
            requirementId: "req",
            description: "Manual behavior is reviewed.",
            todoIds: ["todo-manual"],
            status: "pending",
          },
          {
            id: "ac-unlinked",
            requirementId: "req",
            description: "Unlinked check stays pending.",
            todoIds: [],
            requiredCheckKinds: ["tests"],
            status: "pending",
          },
        ],
        assumptions: [],
        openQuestions: [],
      },
    });
    const checkCalls = [
      ["vitest run", false, { exitCode: 0 }],
      ["tsc --noEmit", true, { exitCode: 1 }],
      ["eslint .", false, { skipped: true }],
    ] as const;
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        checkCalls.forEach(([command, isError, details], index) => {
          mocks.emitPiEvent({
            type: "tool_execution_start",
            toolCallId: `spec-check-${index}`,
            toolName: "terminal_run",
            args: { command },
          });
          mocks.emitPiEvent({
            type: "tool_execution_end",
            toolCallId: `spec-check-${index}`,
            toolName: "terminal_run",
            isError,
            result: { details },
          });
        });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: "Spec Build finished." },
        });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));

    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "Build the approved plan.",
      sessionId,
      planId: plan.id,
    });

    const updated = readPlanById(plansRoot, plan.id);
    expect(updated?.spec?.acceptanceCriteria.map(({ id, status }) => [id, status])).toEqual([
      ["ac-pass", "passed"],
      ["ac-fail", "failed"],
      ["ac-skip", "skipped"],
      ["ac-block", "blocked"],
      ["ac-manual", "pending"],
      ["ac-unlinked", "pending"],
    ]);
    expect(updated?.spec?.evidence.map(({ criterionId }) => criterionId)).toEqual([
      "ac-pass",
      "ac-fail",
      "ac-skip",
      "ac-block",
    ]);
  });

  it("reverts a plan to not_built when the build turn fails", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    const plansRoot = join(userData, "plans");
    const plan = writePlan(plansRoot, {
      workspaceId,
      sessionId,
      title: "Feat",
      overview: "o",
      content: "# Feat\n",
      todos: [{ content: "Step one" }],
    });

    // The build turn ends in error (last assistant stopReason = error).
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        state: { messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom" }] },
        prompt: vi.fn(async () => {
          mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
          mocks.emitPiEvent({
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "partial" },
          });
          mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
        }),
      }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "build",
      sessionId,
      userMessageId: "local-user-build-fail",
      planId: plan.id,
    });

    // A failed build turn re-opens the plan for building.
    expect(readPlanById(plansRoot, plan.id)?.buildStatus).toBe("not_built");
  });

  it.each([
    "wrong mode",
    "missing plan",
    "foreign session",
    "foreign workspace",
  ])("rejects a plan build with %s before recording or emitting a message or creating a run", async (invalidCase) => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    const ownerSessionId =
      invalidCase === "foreign session" ? `owner-${crypto.randomUUID()}` : sessionId;
    const ownerWorkspaceId =
      invalidCase === "foreign workspace" ? `foreign-${workspaceId}` : workspaceId;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "Build session");
    const plan =
      invalidCase === "missing plan"
        ? undefined
        : writePlan(join(userData, "plans"), {
            workspaceId: ownerWorkspaceId,
            sessionId: ownerSessionId,
            title: "Owned plan",
            overview: "Plan belongs to its persisted owner.",
            content: "# Plan",
            todos: [{ content: "Step" }],
          });
    const planId = plan?.id ?? "missing-plan";
    const window = createWindowStub();

    await expect(
      new PiSdkRuntime().prompt(window, {
        context: [],
        delivery: "normal",
        message: "Build this plan",
        mode: invalidCase === "wrong mode" ? "plan" : "build",
        sessionId,
        planId,
      }),
    ).rejects.toThrow();

    const messageCount = (
      getDatabase()
        .prepare(
          "select count(*) as count from agent_events where session_id = ? and type = 'message.started'",
        )
        .get(sessionId) as { count: number }
    ).count;
    const runCount = (
      getDatabase()
        .prepare("select count(*) as count from agent_runs where session_id = ?")
        .get(sessionId) as { count: number }
    ).count;
    const session = getAgentSession(sessionId);
    const emittedTypes = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, event]) => (event as { type?: string }).type,
    );

    expect(messageCount).toBe(0);
    expect(runCount).toBe(0);
    expect(emittedTypes).not.toContain("message.started");
    expect(emittedTypes).not.toContain("run.started");
    expect(emittedTypes).not.toContain("plan.updated");
    expect(session?.status).toBe("idle");
    if (plan) {
      expect(readPlanById(join(userData, "plans"), plan.id)?.buildStatus).toBe("not_built");
    }
  });

  it("keeps an aborted in-flight run cancelled instead of failed", async () => {
    await initGitRepo();
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceId = `workspace-${crypto.randomUUID()}`;
    insertSession(sessionId, workspaceId, join(userData, "missing.jsonl"), "New chat");
    let cancelledAttemptMemoryId: string | undefined;
    let cancelledSolutionMemoryId: string | undefined;
    let rejectPrompt: ((error: Error) => void) | undefined;
    const abort = vi.fn(async () => {
      rejectPrompt?.(new Error("Aborted"));
    });
    const prompt = vi.fn(() => {
      const activeRun = getActiveAgentRun(sessionId);
      if (!activeRun) throw new Error("expected active run");
      cancelledAttemptMemoryId = proposeMemoryForRun({
        sessionId,
        workspaceId,
        runId: activeRun.id,
        cwd,
        title: "Cancelled attempt memory",
        claim: "The cancelled attempt did not complete the remote sync.",
        category: "failed_attempt",
      }).id;
      cancelledSolutionMemoryId = proposeMemoryForRun({
        sessionId,
        workspaceId,
        runId: activeRun.id,
        cwd,
        title: "Cancelled solution memory",
        claim: "The proposed sync solution needs another verification run.",
        category: "solution",
      }).id;
      return new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({
        abort,
        prompt,
      }),
    }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    const promptTask = runtime.prompt(window, {
      context: [],
      delivery: "normal",
      message: "stop me",
      sessionId,
      userMessageId: "local-user-abort",
    });

    await vi.waitFor(() => {
      expect(
        getDatabase()
          .prepare("select count(*) as count from agent_runs where session_id = ?")
          .get(sessionId),
      ).toEqual({ count: 1 });
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await runtime.abort(sessionId);
    await promptTask;

    const run = getDatabase()
      .prepare(
        "select status, error from agent_runs where session_id = ? order by started_at desc limit 1",
      )
      .get(sessionId) as { status: string; error: string | null };
    const events = getDatabase()
      .prepare(
        "select type from agent_events where session_id = ? order by created_at asc, rowid asc",
      )
      .all(sessionId) as Array<{ type: string }>;

    expect(abort).toHaveBeenCalledOnce();
    expect(run).toEqual({ status: "cancelled", error: null });
    expect(events.map((event) => event.type)).toContain("run.cancelled");
    expect(events.map((event) => event.type)).not.toContain("run.failed");
    expect(events.map((event) => event.type)).not.toContain("runtime.error");
    const memories = projectMemory.getProjectMemorySnapshot(workspaceId).memories;
    expect(memories.find((memory) => memory.id === cancelledAttemptMemoryId)?.status).toBe(
      "active",
    );
    expect(memories.find((memory) => memory.id === cancelledSolutionMemoryId)?.status).toBe(
      "candidate",
    );
    expect(
      getDatabase()
        .prepare(
          "select count(*) as count from agent_checkpoints where run_id = (select id from agent_runs where session_id = ?) and kind = 'turn-end'",
        )
        .get(sessionId),
    ).toEqual({ count: 1 });
  });
});

describe("L2: run branch snapshot + context line", () => {
  it("each run gets 'Branch atual: X'; an idle switch is logged and reaches the next run", async () => {
    await initGitRepoWithKnownEmptyScope();
    await execFileAsync("git", ["branch", "feat/l2"], { cwd, windowsHide: true });
    const current = (
      await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], { cwd })
    ).stdout.trim();
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const seen: Array<{ text: string; runBranch: string | undefined }> = [];
    const { getAgentRunBranch } = await import("./agent-run-store");
    const session = createMockPiSession({
      prompt: vi.fn(async (text: string) => {
        const run = getActiveAgentRun(sessionId);
        seen.push({ text, runBranch: run ? getAgentRunBranch(run.id) : undefined });
      }),
    });
    mocks.createAgentSession.mockImplementation(async () => ({ session }));
    const runtime = new PiSdkRuntime();
    const window = createWindowStub();

    await runtime.prompt(window, { context: [], delivery: "normal", message: "one", sessionId });
    expect(
      seen[0]?.text.startsWith(`<session_context>Branch atual: ${current}</session_context>`),
    ).toBe(true);
    expect(seen[0]?.runBranch).toBe(current);

    const { switchSessionBranch } = await import("./session-branch");
    const { createSessionBranchDeps } = await import("./session-branch-deps");
    const emitted: AgentEvent[] = [];
    await switchSessionBranch(
      createSessionBranchDeps({
        emit: (event) => {
          recordAgentEvent(event);
          emitted.push(event);
        },
      }),
      sessionId,
      "feat/l2",
    );
    expect(emitted).toEqual([{ type: "session.branch_changed", sessionId, branch: "feat/l2" }]);
    expect(
      listAgentEvents(sessionId).some((row) => row.event.type === "session.branch_changed"),
    ).toBe(true);

    await runtime.prompt(window, { context: [], delivery: "normal", message: "two", sessionId });
    expect(
      seen[1]?.text.startsWith("<session_context>Branch atual: feat/l2</session_context>"),
    ).toBe(true);
    expect(seen[1]?.runBranch).toBe("feat/l2");
    // The visible user message never carries the line.
    const userDeltas = listAgentEvents(sessionId)
      .map((row) => JSON.stringify(row.event))
      .filter((json) => json.includes('"type":"message.delta"') && json.includes('"two"'));
    expect(userDeltas.length).toBeGreaterThan(0);
    expect(userDeltas.join("\n")).not.toContain("Branch atual");
    mocks.createAgentSession.mockReset();
  });

  it("a saved branch that no longer exists refuses the send", async () => {
    await initGitRepo();
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const { setAgentSessionBranch } = await import("./agent-store");
    setAgentSessionBranch(sessionId, "deleted-branch");
    const prompt = vi.fn(async () => undefined);
    mocks.createAgentSession.mockImplementationOnce(async () => ({
      session: createMockPiSession({ prompt }),
    }));
    await expect(
      new PiSdkRuntime().prompt(createWindowStub(), {
        context: [],
        delivery: "normal",
        message: "hi",
        sessionId,
      }),
    ).rejects.toThrow('A branch "deleted-branch" não existe mais');
    expect(prompt).not.toHaveBeenCalled();
    expect(getActiveAgentRun(sessionId)).toBeUndefined();
  });
});

describe("PiSdkRuntime Phase 7 response policy wiring", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    ResponsePolicyRegistry.resetInstance();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    ResponsePolicyRegistry.resetInstance();
  });

  async function runTurnWithAssistantText(text: string): Promise<string> {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: text },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "hello",
      sessionId,
    });
    return (
      mocks.resourceLoaderOptions.at(-1) as { appendSystemPrompt: string[] }
    ).appendSystemPrompt.join("\n");
  }

  it("appends the response policy directive and evaluates the settled response when enabled", async () => {
    setFeatureFlagOverrides({ MODUS_RESPONSE_POLICY: true });

    const systemPrompt = await runTurnWithAssistantText("P1\n\nP2\n\nP3\n\nP4\n\nP5\n\nP6");

    expect(systemPrompt).toContain('<response_policy level="standard">');
    expect(ResponsePolicyRegistry.getInstance().getMetrics().totalEvaluated).toBeGreaterThan(0);
  });

  it("omits the directive and skips evaluation when the flag is disabled", async () => {
    setFeatureFlagOverrides({ MODUS_RESPONSE_POLICY: false });

    const systemPrompt = await runTurnWithAssistantText("done");

    expect(systemPrompt).not.toContain("<response_policy");
    expect(ResponsePolicyRegistry.getInstance().getMetrics().totalEvaluated).toBe(0);
  });
});

describe("PiSdkRuntime Phase 8 observability wiring", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    ResponsePolicyRegistry.resetInstance();
    HarnessObserver.resetInstance();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    ResponsePolicyRegistry.resetInstance();
    HarnessObserver.resetInstance();
  });

  async function runTurnWithAssistantText(text: string): Promise<string> {
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const session = createMockPiSession({
      prompt: vi.fn(async () => {
        mocks.emitPiEvent({ type: "message_start", message: { role: "assistant" } });
        mocks.emitPiEvent({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_delta", delta: text },
        });
        mocks.emitPiEvent({ type: "message_end", message: { role: "assistant" } });
      }),
    });
    mocks.createAgentSession.mockImplementationOnce(async () => ({ session }));
    await new PiSdkRuntime().prompt(createWindowStub(), {
      context: [],
      delivery: "normal",
      message: "hello",
      sessionId,
    });
    return sessionId;
  }

  it("records a session turn with a real duration when enabled", async () => {
    setFeatureFlagOverrides({ MODUS_OBSERVABILITY: true });

    const sessionId = await runTurnWithAssistantText("done");

    const metrics = HarnessObserver.getInstance().getSessionMetrics(sessionId);
    expect(metrics).toBeDefined();
    expect(metrics?.turnCount).toBeGreaterThan(0);
    expect(metrics?.totalDurationMs).toBeGreaterThan(0);
  });

  it("records nothing when the flag is disabled", async () => {
    setFeatureFlagOverrides({ MODUS_OBSERVABILITY: false });

    const sessionId = await runTurnWithAssistantText("done");

    expect(HarnessObserver.getInstance().getSessionMetrics(sessionId)).toBeUndefined();
  });

  it("mirrors response evaluations into the observer end to end", async () => {
    setFeatureFlagOverrides({ MODUS_OBSERVABILITY: true, MODUS_RESPONSE_POLICY: true });

    await runTurnWithAssistantText("P1\n\nP2\n\nP3\n\nP4\n\nP5\n\nP6");

    expect(ResponsePolicyRegistry.getInstance().getMetrics().totalEvaluated).toBeGreaterThan(0);
    expect(HarnessObserver.getInstance().snapshot().response.violationsDetected).toBeGreaterThan(0);
  });
});

describe("PiSdkRuntime Phase 9 subagent provider delegation", () => {
  /**
   * Offline PI sessions whose mocked model stream pushes a real text delta
   * (the shared helper only pushes `done`, which yields no assistant text
   * and would make every child fail with "no assistant output").
   */
  async function useOfflineDeltaSessions(): Promise<void> {
    const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    const authStorage = sdk.AuthStorage.inMemory({
      mock: { type: "api_key", key: "offline-test-only" },
    });
    const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
    mocks.sessionManagerCreate.mockImplementation(() => sdk.SessionManager.inMemory(cwd) as never);
    mocks.settingsManagerInMemory.mockImplementation((settings) =>
      sdk.SettingsManager.inMemory(settings),
    );
    mocks.createAgentSession.mockImplementation(async (options) => {
      const loaderOptions = mocks.resourceLoaderOptions.at(-1) as ConstructorParameters<
        typeof sdk.DefaultResourceLoader
      >[0];
      const resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
      await resourceLoader.reload();
      const { session } = await sdk.createAgentSession({
        ...options,
        authStorage,
        modelRegistry,
        resourceLoader,
        model: {
          api: "openai-completions",
          baseUrl: "https://offline.invalid",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 1000,
          ...options.model,
        },
      });
      session.agent.streamFn = (model, context) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Done.", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream as unknown as ReturnType<AgentSession["agent"]["streamFn"]>;
      };
      return { session };
    });
  }

  it("spawns a real headless child through the provider and harvests output via wait", async () => {
    await useOfflineDeltaSessions();
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const provider = runtime.getSubagentRegistry().getDefaultProvider();
    const spawnRes = await provider.spawn({ role: "researcher", task: "say hi", sessionId });
    expect(spawnRes.status).toBe("spawned");
    const waitRes = await provider.wait(spawnRes.subagentId, 30000);
    expect(waitRes.success).toBe(true);
    expect(waitRes.output).toContain("Done.");
  });

  it("honors worktree isolation requested through the provider", async () => {
    await useOfflineDeltaSessions();
    await initGitRepo();
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const provider = runtime.getSubagentRegistry().getDefaultProvider();
    const spawnRes = await provider.spawn({
      role: "builder",
      task: "build it",
      sessionId,
      isolation: "worktree",
    });
    expect(spawnRes.status).toBe("spawned");
    const { getAgentSession: getSession } = await import("./agent-store");
    expect(getSession(spawnRes.subagentId)?.subagentWorktree).toBeDefined();
    const waitRes = await provider.wait(spawnRes.subagentId, 30000);
    expect(waitRes.success).toBe(true);
  });

  it("returns failed (does not throw) when the parent session does not exist", async () => {
    await useOfflinePiToolSessions();
    const runtime = new PiSdkRuntime();
    const provider = runtime.getSubagentRegistry().getDefaultProvider();
    const spawnRes = await provider.spawn({ role: "researcher", task: "say hi" });
    expect(spawnRes.status).toBe("failed");
    expect(spawnRes.errorMessage).toContain("sessionId");
  });

  it("reports harvested child status from the session instead of failed", async () => {
    await useOfflineDeltaSessions();
    const sessionId = `session-${crypto.randomUUID()}`;
    insertSession(sessionId, `workspace-${crypto.randomUUID()}`, join(userData, "missing.jsonl"));
    const runtime = new PiSdkRuntime();
    const provider = runtime.getSubagentRegistry().getDefaultProvider();
    const spawnRes = await provider.spawn({ role: "researcher", task: "say hi", sessionId });
    expect(spawnRes.status).toBe("spawned");
    const waitRes = await provider.wait(spawnRes.subagentId, 30000);
    expect(waitRes.success).toBe(true);
    const status = await provider.status(spawnRes.subagentId);
    expect(status.state).toBe("completed");
  });
});
