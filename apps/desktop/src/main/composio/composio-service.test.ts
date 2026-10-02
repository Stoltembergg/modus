import { ComposioToolkitFetchError } from "@composio/core";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposioMcpBridge } from "../mcp/mcp-service";
import type { ComposioApi, ComposioConnectionRequest, ComposioSession } from "./composio-api";
import type { ComposioProfileConfig, ComposioProfileStore } from "./composio-profile-store";
import type { ComposioSecretStore } from "./composio-secret-store";
import { createComposioService } from "./composio-service";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const OLD_KEY = "composio_project_key_old_secret";
const NEW_KEY = "composio_project_key_new_secret";
const CONSUMER_KEY = "ck_consumer_test_secret";
const CONSUMER_TOOLS = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"] as const;
const RAW_CONNECT_URL = "https://connect.composio.dev/link/short-lived-secret";

type ServiceHarness = ReturnType<typeof createServiceHarness>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeAccount(
  id: string,
  status = "ACTIVE",
  toolkitSlug = "github",
  alias = `Provider ${id}`,
) {
  return {
    id,
    toolkitSlug,
    status,
    alias,
    authConfig: { credentials: { access_token: "provider-access-secret" } },
    data: { refresh_token: "provider-refresh-secret" },
  };
}

function makeApi(overrides: Partial<ComposioApi> = {}) {
  const accounts: Array<ReturnType<typeof makeAccount>> = [];
  const waitForConnection = vi.fn(async (_timeoutMs: number, _signal?: AbortSignal) =>
    makeAccount("account-new"),
  );
  const connectionRequest: ComposioConnectionRequest = {
    id: "request-1",
    redirectUrl: RAW_CONNECT_URL,
    waitForConnection,
  };
  const session = {
    id: "session-1",
    configVersion: 1,
    mcp: {
      url: "https://mcp.composio.dev/session/session-path",
      headers: { "x-session-key": "session-key" },
    },
    update: vi.fn(async () => {}),
  } as unknown as ComposioSession;
  const api = {
    validateProjectReadAccess: vi.fn(async () => {}),
    validateMcpConnectivity: vi.fn(async () => ({ apiReachable: true, mcpSessionReady: true })),
    listToolkits: vi.fn(async () => [
      { slug: "github", name: "GitHub", description: "Source control" },
      { slug: "slack", name: "Slack" },
    ]),
    listTools: vi.fn(async () => [
      {
        slug: "GITHUB_LIST_REPOSITORIES",
        name: "List repositories",
        description: "List repositories",
      },
    ]),
    listAuthConfigs: vi.fn(async () => [
      { id: "auth-config-managed", isComposioManaged: true, authScheme: "OAUTH2" },
    ]),
    createManagedAuthConfig: vi.fn(async () => ({
      id: "auth-config-created",
      isComposioManaged: true,
      authScheme: "OAUTH2",
    })),
    listAccounts: vi.fn(async () => accounts),
    linkAccount: vi.fn(async () => connectionRequest),
    deleteAccount: vi.fn(async () => {}),
    createSession: vi.fn(async () => session),
    useSession: vi.fn(async () => session),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ComposioApi;
  return { api, accounts, connectionRequest, waitForConnection, session };
}

function createServiceHarness(
  options: {
    initialKey?: string;
    apiForKey?: (key: string) => ComposioApi;
    profile?: ComposioProfileConfig;
  } = {},
) {
  let savedKey = options.initialKey;
  let profileData: ComposioProfileConfig = options.profile ?? {
    version: 1,
    profileId: PROFILE_ID,
    toolkits: {},
  };
  const secretStore: ComposioSecretStore = {
    load: vi.fn(async () => savedKey),
    save: vi.fn(async (key: string) => {
      savedKey = key;
    }),
    clear: vi.fn(async () => {
      savedKey = undefined;
    }),
  };
  const profileStore: ComposioProfileStore = {
    load: vi.fn(() => structuredClone(profileData)),
    save: vi.fn((profile: ComposioProfileConfig) => {
      profileData = structuredClone(profile);
    }),
    update: vi.fn((updater) => {
      profileData = updater(structuredClone(profileData));
      return structuredClone(profileData);
    }),
  };
  const defaultApi = makeApi();
  const createApi = vi.fn((key: string) => options.apiForKey?.(key) ?? defaultApi.api);
  const openExternal = vi.fn(async (_url: string) => {});
  const mcp: ComposioMcpBridge = {
    inspectComposioMcpSession: vi.fn(async () =>
      CONSUMER_TOOLS.map((name) => ({ name, registeredName: `composio_${name}` })),
    ),
    registerComposioMcpSession: vi.fn(
      async (input: Parameters<ComposioMcpBridge["registerComposioMcpSession"]>[0]) =>
        input.allowedToolSlugs.map((slug) => ({
          name: slug,
          registeredName: `composio_${slug}`,
        })),
    ),
    unregisterComposioMcpSession: vi.fn(async () => {}),
  };
  const service = createComposioService({
    secretStore,
    profileStore,
    createComposioApi: createApi,
    openExternal,
    mcp,
  });
  return {
    service,
    secretStore,
    profileStore,
    createApi,
    openExternal,
    mcp,
    defaultApi,
    getSavedKey: () => savedKey,
    getProfile: () => structuredClone(profileData),
  };
}

let harnesses: ServiceHarness[] = [];

function startHarness(options: Parameters<typeof createServiceHarness>[0] = {}): ServiceHarness {
  const harness = createServiceHarness(options);
  harnesses.push(harness);
  return harness;
}

async function waitForOperation(
  harness: ServiceHarness,
  operationId: string,
  status: "active" | "failed" | "expired" | "canceled",
) {
  await vi.waitFor(async () => {
    expect((await harness.service.getConnectionOperation(operationId)).status).toBe(status);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(harnesses.map(({ service }) => service.shutdown()));
  harnesses = [];
  vi.restoreAllMocks();
});

describe("Composio service", () => {
  it("validates and saves a For You key through personal MCP without calling the project API", async () => {
    const harness = startHarness();
    const state = await harness.service.setProjectApiKey(` ${CONSUMER_KEY} `);

    expect(state).toMatchObject({
      apiKeyConfigured: true,
      status: "ready",
      keyType: "consumer",
      toolkits: [],
      consumer: {
        enabled: false,
        selectedToolSlugs: [],
        tools: CONSUMER_TOOLS.map((slug) => ({ slug, toolkitSlug: "composio-for-you" })),
      },
    });
    expect(harness.mcp.inspectComposioMcpSession).toHaveBeenCalledWith({
      url: "https://connect.composio.dev/mcp",
      headers: { "x-consumer-api-key": CONSUMER_KEY },
    });
    expect(harness.createApi).not.toHaveBeenCalled();
    expect(harness.getSavedKey()).toBe(CONSUMER_KEY);
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain(CONSUMER_KEY);
    expect(JSON.stringify(harness.getProfile())).not.toContain(CONSUMER_KEY);
  });

  it("restores a For You policy independently of existing project account policies", async () => {
    const projectPolicy = {
      enabled: true,
      selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
      selectedAccountId: "account-1",
      aliases: {},
    };
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        toolkits: { github: projectPolicy },
        forYou: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
      },
    });
    const state = await harness.service.initialize();

    expect(state).toMatchObject({
      keyType: "consumer",
      status: "ready",
      consumer: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
    });
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenCalledWith({
      url: "https://connect.composio.dev/mcp",
      headers: { "x-consumer-api-key": CONSUMER_KEY },
      allowedToolSlugs: [CONSUMER_TOOLS[0]],
    });
    expect(harness.getProfile().toolkits.github).toEqual(projectPolicy);
    expect(harness.createApi).not.toHaveBeenCalled();
  });

  it("enables selected personal MCP tools without a project account and unregisters when disabled", async () => {
    const harness = startHarness({ initialKey: CONSUMER_KEY });
    await harness.service.initialize();
    const state = await harness.service.setToolkitPolicy({
      toolkitSlug: "composio-for-you",
      enabled: true,
      selectedToolSlugs: [CONSUMER_TOOLS[1]],
    });

    expect(state).toMatchObject({
      status: "ready",
      consumer: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[1]] },
    });
    expect(harness.getProfile().forYou).toEqual({
      enabled: true,
      selectedToolSlugs: [CONSUMER_TOOLS[1]],
    });
    expect(harness.getProfile().toolkits).toEqual({});
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedToolSlugs: [CONSUMER_TOOLS[1]] }),
    );
    vi.mocked(harness.mcp.unregisterComposioMcpSession).mockClear();
    const disabled = await harness.service.setToolkitPolicy({
      toolkitSlug: "composio-for-you",
      enabled: false,
      selectedToolSlugs: [],
    });
    expect(disabled).toMatchObject({
      status: "ready",
      consumer: { enabled: false, selectedToolSlugs: [] },
    });
    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalled();
    expect(harness.createApi).not.toHaveBeenCalled();
  });

  it("rejects unknown personal MCP tools and requires an explicit selection before enabling", async () => {
    const harness = startHarness({ initialKey: CONSUMER_KEY });
    await harness.service.initialize();
    for (const selectedToolSlugs of [[], ["COMPOSIO_NOT_IN_CATALOG"]]) {
      const state = await harness.service.setToolkitPolicy({
        toolkitSlug: "composio-for-you",
        enabled: true,
        selectedToolSlugs,
      });
      expect(state.status).toBe("error");
    }
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(harness.getProfile().forYou).toBeUndefined();
  });

  it("keeps the previous key when personal MCP authentication fails and hides the candidate", async () => {
    const harness = startHarness({ initialKey: OLD_KEY });
    await harness.service.initialize();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockRejectedValue(
      Object.assign(new Error(`invalid key ${CONSUMER_KEY}`), { status: 401 }),
    );
    const state = await harness.service.setProjectApiKey(CONSUMER_KEY);
    expect(state.error).toMatchObject({ code: "invalid_consumer_key", retryable: false });
    expect(state.error?.message).not.toContain(CONSUMER_KEY);
    expect(harness.getSavedKey()).toBe(OLD_KEY);
    expect(harness.secretStore.save).not.toHaveBeenCalled();
  });

  it.each([
    [new UnauthorizedError("No auth provider"), "invalid_consumer_key", false],
    [new StreamableHTTPError(401, "Error POSTing to endpoint"), "invalid_consumer_key", false],
    [new StreamableHTTPError(403, "Error POSTing to endpoint"), "consumer_access_denied", false],
    [new StreamableHTTPError(429, "Error POSTing to endpoint"), "rate_limited", true],
    [new StreamableHTTPError(503, "Error POSTing to endpoint"), "composio_unavailable", true],
  ])("classifies actual personal MCP transport errors: %s", async (error, code, retryable) => {
    const harness = startHarness();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockRejectedValue(error);
    const state = await harness.service.setProjectApiKey(CONSUMER_KEY);
    expect(state.error).toMatchObject({ code, retryable });
    expect(harness.getSavedKey()).toBeUndefined();
  });

  it("retries personal MCP discovery on refresh after a startup network failure", async () => {
    const harness = startHarness({ initialKey: CONSUMER_KEY });
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockRejectedValueOnce(
      new Error(`fetch failed x-consumer-api-key ${CONSUMER_KEY}`),
    );
    const initial = await harness.service.initialize();
    expect(initial.status).toBe("error");
    expect(initial.error?.message).not.toContain(CONSUMER_KEY);
    const state = await harness.service.refreshCatalog();
    expect(state).toMatchObject({ keyType: "consumer", status: "ready" });
    expect(harness.mcp.inspectComposioMcpSession).toHaveBeenCalledTimes(2);
    expect(harness.createApi).not.toHaveBeenCalled();
  });

  it("diagnoses For You using a temporary MCP probe without exposing tools", async () => {
    const harness = startHarness({ initialKey: CONSUMER_KEY });
    expect(await harness.service.diagnose()).toEqual({ apiReachable: true, mcpSessionReady: true });
    expect(harness.mcp.inspectComposioMcpSession).toHaveBeenCalled();
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(harness.createApi).not.toHaveBeenCalled();
  });

  it("waits for personal MCP startup before reporting settings", async () => {
    const harness = startHarness({ initialKey: CONSUMER_KEY });
    const inspection = deferred<Array<{ name: string; registeredName: string }>>();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockImplementation(() => inspection.promise);
    const initialization = harness.service.initialize();
    const read = harness.service.getSettingsState();
    inspection.resolve(CONSUMER_TOOLS.map((name) => ({ name, registeredName: name })));
    const states = await Promise.all([initialization, read]);
    expect(states.map((state) => state.status)).toEqual(["ready", "ready"]);
  });

  it("removes an enabled For You key without touching project sessions or connected accounts", async () => {
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "project-session",
        toolkits: {},
        forYou: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
      },
    });
    await harness.service.initialize();
    const state = await harness.service.removeProjectApiKey();
    expect(state).toEqual({ apiKeyConfigured: false, status: "unconfigured", toolkits: [] });
    expect(harness.getSavedKey()).toBeUndefined();
    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalled();
    expect(harness.defaultApi.api.deleteSession).not.toHaveBeenCalled();
    expect(harness.defaultApi.api.deleteAccount).not.toHaveBeenCalled();
  });

  it("does not let pending personal startup restore tools after key removal", async () => {
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        toolkits: {},
        forYou: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
      },
    });
    const inspection = deferred<Array<{ name: string; registeredName: string }>>();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockImplementation(() => inspection.promise);
    const initialization = harness.service.initialize();
    await vi.waitFor(() => expect(harness.mcp.inspectComposioMcpSession).toHaveBeenCalled());
    const removal = harness.service.removeProjectApiKey();
    // Finish startup only after the concurrently requested removal had a chance to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    inspection.resolve(CONSUMER_TOOLS.map((name) => ({ name, registeredName: name })));
    await Promise.all([initialization, removal]);
    expect(await harness.service.getSettingsState()).toEqual({
      apiKeyConfigured: false,
      status: "unconfigured",
      toolkits: [],
    });
    expect(harness.getSavedKey()).toBeUndefined();
    expect(
      vi.mocked(harness.mcp.unregisterComposioMcpSession).mock.invocationCallOrder.at(-1),
    ).toBeGreaterThan(
      vi.mocked(harness.mcp.registerComposioMcpSession).mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it("shows project mode if switching from For You succeeds but project synchronization fails", async () => {
    const harness = startHarness({ initialKey: CONSUMER_KEY });
    await harness.service.initialize();
    vi.mocked(harness.profileStore.load)
      .mockReturnValueOnce(harness.getProfile())
      .mockImplementation(() => {
        throw new Error("profile unavailable during reconciliation");
      });
    const state = await harness.service.setProjectApiKey(NEW_KEY);
    expect(state).toMatchObject({
      apiKeyConfigured: true,
      keyType: "project",
      status: "error",
      toolkits: [],
    });
    expect(state.consumer).toBeUndefined();
    expect(harness.getSavedKey()).toBe(NEW_KEY);
  });

  it("does not start a new personal key probe if shutdown begins during initialization", async () => {
    const harness = startHarness();
    const loading = deferred<string | undefined>();
    vi.mocked(harness.secretStore.load).mockImplementation(() => loading.promise);
    const saving = harness.service.setProjectApiKey(CONSUMER_KEY);
    await vi.waitFor(() => expect(harness.secretStore.load).toHaveBeenCalled());
    const shutdown = harness.service.shutdown();
    loading.resolve(undefined);
    await Promise.all([saving, shutdown]);
    expect(harness.mcp.inspectComposioMcpSession).not.toHaveBeenCalled();
    expect(harness.getSavedKey()).toBeUndefined();
  });

  it("does not reuse a previous project's session when switching from For You to a new project key", async () => {
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "foreign-project-session",
        toolkits: {},
      },
    });
    await harness.service.initialize();
    vi.mocked(harness.defaultApi.api.deleteSession).mockRejectedValue(
      Object.assign(new Error("wrong project"), { status: 401 }),
    );
    const state = await harness.service.setProjectApiKey(NEW_KEY);
    expect(state).toMatchObject({ keyType: "project", status: "ready" });
    expect(harness.defaultApi.api.deleteSession).not.toHaveBeenCalled();
    expect(harness.defaultApi.api.useSession).not.toHaveBeenCalled();
    expect(harness.getProfile().sessionId).toBeUndefined();
  });

  it("fails closed if For You discovery fails while changing an enabled policy", async () => {
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        toolkits: {},
        forYou: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
      },
    });
    await harness.service.initialize();
    vi.mocked(harness.mcp.unregisterComposioMcpSession).mockClear();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockRejectedValue(new Error("fetch failed"));
    const state = await harness.service.setToolkitPolicy({
      toolkitSlug: "composio-for-you",
      enabled: true,
      selectedToolSlugs: [CONSUMER_TOOLS[1]],
    });
    expect(state).toMatchObject({ status: "error", consumer: { enabled: false } });
    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalled();
    expect(harness.getProfile().forYou?.selectedToolSlugs).toEqual([CONSUMER_TOOLS[0]]);
  });

  it("can disable personal tools even while Composio is offline", async () => {
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        toolkits: {},
        forYou: { enabled: true, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
      },
    });
    await harness.service.initialize();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockRejectedValue(new Error("fetch failed"));
    const state = await harness.service.setToolkitPolicy({
      toolkitSlug: "composio-for-you",
      enabled: false,
      selectedToolSlugs: [CONSUMER_TOOLS[0]],
    });
    expect(state).toMatchObject({ status: "ready", consumer: { enabled: false } });
    expect(harness.getProfile().forYou?.enabled).toBe(false);
  });

  it("deactivates an unavailable personal catalog without silently expanding the saved selection", async () => {
    const harness = startHarness({
      initialKey: CONSUMER_KEY,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        toolkits: {},
        forYou: { enabled: true, selectedToolSlugs: [...CONSUMER_TOOLS] },
      },
    });
    await harness.service.initialize();
    vi.mocked(harness.mcp.registerComposioMcpSession).mockClear();
    vi.mocked(harness.mcp.inspectComposioMcpSession).mockResolvedValue([
      { name: CONSUMER_TOOLS[0], registeredName: "search" },
    ]);
    const state = await harness.service.refreshCatalog();
    expect(state).toMatchObject({
      status: "ready",
      consumer: { enabled: false, selectedToolSlugs: [CONSUMER_TOOLS[0]] },
    });
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(harness.getProfile().forYou?.selectedToolSlugs).toEqual([...CONSUMER_TOOLS]);
  });

  it("cancels pending project authorization when switching to For You", async () => {
    const api = makeApi();
    const pending = deferred<ReturnType<typeof makeAccount>>();
    api.waitForConnection.mockImplementation(() => pending.promise);
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();
    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Work",
    });
    expect(operation.status).toBe("pending");
    const state = await harness.service.setProjectApiKey(CONSUMER_KEY);
    expect(state).toMatchObject({ status: "ready", keyType: "consumer", toolkits: [] });
    expect(await harness.service.getConnectionOperation(operation.id)).toMatchObject({
      status: "canceled",
    });
    expect(api.waitForConnection.mock.calls[0]?.[1]?.aborted).toBe(true);
    pending.resolve(makeAccount("late-account"));
    await Promise.resolve();
    expect(harness.getProfile().toolkits.github?.aliases["late-account"]).toBeUndefined();
  });

  it("shares one startup reconciliation between concurrent initialize callers", async () => {
    const api = makeApi();
    const validation = deferred<void>();
    vi.mocked(api.api.validateProjectReadAccess).mockImplementation(() => validation.promise);
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });

    const firstInitialization = harness.service.initialize();
    const secondInitialization = harness.service.initialize();
    await Promise.resolve();

    expect(harness.secretStore.load).toHaveBeenCalledTimes(1);
    expect(api.api.validateProjectReadAccess).toHaveBeenCalledTimes(1);
    validation.resolve();
    const states = await Promise.all([firstInitialization, secondInitialization]);

    expect(states.map((state) => state.status)).toEqual(["ready", "ready"]);
    expect(api.api.listToolkits).toHaveBeenCalledTimes(1);
  });

  it("fails closed on unavailable encrypted storage without registering any tools", async () => {
    const harness = startHarness();
    vi.mocked(harness.secretStore.load).mockRejectedValue(new Error("OS encryption unavailable"));

    const state = await harness.service.initialize();

    expect(state.status).toBe("error");
    expect(state.apiKeyConfigured).toBe(false);
    expect(harness.createApi).not.toHaveBeenCalled();
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid saved Project API Key", async () => {
    const api = makeApi();
    vi.mocked(api.api.validateProjectReadAccess).mockRejectedValue(
      Object.assign(new Error("invalid Project API Key"), { statusCode: 401 }),
    );
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });

    const state = await harness.service.initialize();

    expect(state.status).toBe("error");
    expect(state.error?.code).toBe("invalid_project_key");
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
  });

  it("surfaces scoped-key permissions needed for Composio MCP sessions", async () => {
    const api = makeApi();
    vi.mocked(api.api.validateProjectReadAccess).mockRejectedValue(
      Object.assign(new Error("session tool execution permission denied"), {
        statusCode: 403,
        code: "insufficient_scope",
      }),
    );
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });

    const state = await harness.service.initialize();

    expect(state.status).toBe("error");
    expect(state.error?.code).toBe("missing_scope_read");
    expect(state.error?.message).toMatch(/sessions.*MCP|MCP.*sessions/i);
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
  });

  it("reports MCP permission failures separately from API and safely cleans the probe session", async () => {
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    vi.mocked(api.api.validateMcpConnectivity).mockResolvedValue({
      apiReachable: true,
      mcpSessionReady: false,
      error: {
        code: "missing_scope_read",
        message: "MCP session permission denied",
        retryable: false,
      },
    });
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    const state = await harness.service.diagnose();

    expect(state).toMatchObject({
      apiReachable: true,
      mcpSessionReady: false,
      error: { code: "missing_scope_read" },
    });
    expect(api.api.validateMcpConnectivity).toHaveBeenCalledOnce();
  });

  it("keeps Composio HTTP 5xx errors distinct from network failures", async () => {
    const api = makeApi();
    vi.mocked(api.api.validateProjectReadAccess).mockRejectedValue(
      Object.assign(new Error("Composio server failure"), { statusCode: 503 }),
    );
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });

    const state = await harness.service.initialize();

    expect(state.error?.code).toBe("composio_unavailable");
  });

  it.each([
    [401, "Unauthorized", "invalid_project_key", false],
    [403, "Request rejected", "missing_scope_read", false],
    [429, "Request rejected", "rate_limited", true],
    [503, "Request rejected", "composio_unavailable", true],
  ] as const)(
    "reports HTTP %i from the SDK cause when saving a key, without storing the rejected key",
    async (status, message, code, retryable) => {
      const api = makeApi();
      vi.mocked(api.api.validateProjectReadAccess).mockRejectedValue(
        new ComposioToolkitFetchError("Failed to fetch toolkits", {
          cause: Object.assign(new Error(message), { status }),
        }),
      );
      const harness = startHarness({ apiForKey: () => api.api });

      const state = await harness.service.setProjectApiKey(NEW_KEY);

      expect(state).toMatchObject({
        apiKeyConfigured: false,
        status: "error",
        error: { code, retryable },
      });
      expect(harness.getSavedKey()).toBeUndefined();
      expect(state.error?.message).not.toContain(NEW_KEY);
    },
  );

  it.each([["uak_user_test_secret", "user API key"]])(
    "explains the unsupported key type before sending %s to the project API",
    async (key, kind) => {
      const harness = startHarness();

      const state = await harness.service.setProjectApiKey(key);

      expect(state).toMatchObject({
        apiKeyConfigured: false,
        status: "error",
        error: { code: "unsupported_key_type", retryable: false },
      });
      expect(state.error?.message).toContain(kind);
      expect(state.error?.message).toContain("Platform");
      expect(state.error?.message).not.toContain(key);
      expect(harness.createApi).not.toHaveBeenCalled();
      expect(harness.getSavedKey()).toBeUndefined();
    },
  );

  it("keeps the exact Composio endpoint, TCP, DNS, TLS, or proxy diagnostic for support", async () => {
    const api = makeApi();
    vi.mocked(api.api.validateProjectReadAccess).mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND backend.composio.dev"), {
          code: "ENOTFOUND",
        }),
      }),
    );
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });

    const state = await harness.service.initialize();

    expect(state.error?.code).toBe("network_unavailable");
    expect(state.error?.message).toMatch(/ENOTFOUND.*backend\.composio\.dev/);
    expect(state.error?.message).not.toContain(OLD_KEY);
  });

  it("reconciles a saved allowlist at startup before exposing selected operations", async () => {
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: () => api.api,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "session-1",
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "account-1",
            selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
            aliases: {},
          },
        },
      },
    });

    const state = await harness.service.initialize();

    expect(api.api.useSession).toHaveBeenCalledWith("session-1");
    expect(api.api.createSession).not.toHaveBeenCalled();
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
      }),
    );
    expect(vi.mocked(api.session.update).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.mcp.registerComposioMcpSession).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(state.status).toBe("ready");
  });

  it("aborts pending authorization and clears runtime credentials on shutdown while preserving the remote session", async () => {
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    let connectionSignal: AbortSignal | undefined;
    api.waitForConnection.mockImplementation((_timeoutMs, signal) => {
      connectionSignal = signal;
      return new Promise(() => {});
    });
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: () => api.api,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "session-1",
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "account-1",
            selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
            aliases: {},
          },
        },
      },
    });
    await harness.service.initialize();
    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Pending",
    });
    await vi.waitFor(() => expect(api.waitForConnection).toHaveBeenCalledTimes(1));
    const reusableSessionId = harness.getProfile().sessionId;

    await harness.service.shutdown();

    expect(connectionSignal?.aborted).toBe(true);
    expect((await harness.service.getConnectionOperation(operation.id)).status).toBe("canceled");
    expect(await harness.service.getSettingsState()).toMatchObject({
      apiKeyConfigured: false,
      status: "unconfigured",
      toolkits: [],
    });
    expect(harness.getProfile().sessionId).toBe(reusableSessionId);
    expect(reusableSessionId).toBe("session-1");
    expect(api.api.deleteSession).not.toHaveBeenCalled();
    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalled();
  });

  it("persists and synchronizes only a validated explicit toolkit policy", async () => {
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    const state = await harness.service.setToolkitPolicy({
      toolkitSlug: "github",
      enabled: true,
      selectedAccountId: "account-1",
      selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
    });

    expect(harness.getProfile().toolkits.github).toMatchObject({
      enabled: true,
      selectedAccountId: "account-1",
      selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
    });
    expect(api.api.createSession).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({
        toolkits: { enable: ["github"] },
        tools: { github: { enable: ["GITHUB_LIST_REPOSITORIES"] } },
        connectedAccounts: { github: ["account-1"] },
      }),
    );
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
      }),
    );
    expect(state.status).toBe("ready");
  });

  it("rejects unknown tools and excessive selections without persisting or registering them", async () => {
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    const unknown = await harness.service.setToolkitPolicy({
      toolkitSlug: "github",
      enabled: true,
      selectedAccountId: "account-1",
      selectedToolSlugs: ["GITHUB_UNKNOWN_TOOL"],
    });
    const tooMany = await harness.service.setToolkitPolicy({
      toolkitSlug: "github",
      enabled: true,
      selectedAccountId: "account-1",
      selectedToolSlugs: Array.from({ length: 501 }, (_, index) => `TOOL_${index}`),
    });

    expect(unknown.error?.code).toBe("toolkit_unavailable");
    expect(tooMany.error?.code).toBe("toolkit_unavailable");
    expect(harness.getProfile().toolkits.github).toBeUndefined();
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
  });

  it("serializes concurrent toolkit selections and leaves only the latest allowlist active", async () => {
    const api = makeApi({
      listTools: vi.fn(async () => [
        { slug: "GITHUB_LIST_REPOSITORIES", name: "List repositories" },
        { slug: "GITHUB_CREATE_ISSUE", name: "Create issue" },
      ]),
    });
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    await Promise.all([
      harness.service.setToolkitPolicy({
        toolkitSlug: "github",
        enabled: true,
        selectedAccountId: "account-1",
        selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
      }),
      harness.service.setToolkitPolicy({
        toolkitSlug: "github",
        enabled: true,
        selectedAccountId: "account-1",
        selectedToolSlugs: ["GITHUB_CREATE_ISSUE"],
      }),
    ]);

    expect(harness.getProfile().toolkits.github?.selectedToolSlugs).toEqual([
      "GITHUB_CREATE_ISSUE",
    ]);
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedToolSlugs: ["GITHUB_CREATE_ISSUE"],
      }),
    );
  });

  it("allows disabling a policy whose saved account and operation are stale", async () => {
    const api = makeApi();
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();
    harness.profileStore.update((current) => ({
      ...current,
      sessionId: "session-1",
      toolkits: {
        github: {
          enabled: true,
          selectedAccountId: "disconnected-account",
          selectedToolSlugs: ["GITHUB_REMOVED_TOOL"],
          aliases: {},
        },
      },
    }));
    vi.mocked(api.api.listTools).mockClear();
    vi.mocked(api.api.deleteSession).mockClear();

    const state = await harness.service.setToolkitPolicy({
      toolkitSlug: "github",
      enabled: false,
      selectedToolSlugs: [],
    });

    expect(api.api.listTools).not.toHaveBeenCalled();
    expect(api.api.deleteSession).toHaveBeenCalledWith("session-1");
    expect(harness.getProfile().toolkits.github).toMatchObject({
      enabled: false,
      selectedToolSlugs: [],
    });
    expect(harness.getProfile().toolkits.github?.selectedAccountId).toBeUndefined();
    expect(state.status).toBe("ready");
  });

  it("deletes the narrowed remote session before revoking its selected account", async () => {
    const sequence: string[] = [];
    const api = makeApi({
      deleteSession: vi.fn(async () => {
        sequence.push("delete-session");
      }),
      deleteAccount: vi.fn(async () => {
        sequence.push("delete-account");
      }),
    });
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: () => api.api,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "session-1",
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "account-1",
            selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
            aliases: { "account-1": "Work" },
          },
        },
      },
    });
    await harness.service.initialize();
    vi.mocked(api.api.deleteSession).mockClear();
    sequence.length = 0;

    await harness.service.disconnectAccount({ toolkitSlug: "github", accountId: "account-1" });

    expect(sequence).toEqual(["delete-session", "delete-account"]);
    expect(harness.getProfile().sessionId).toBeUndefined();
    expect(harness.getProfile().toolkits.github?.selectedAccountId).toBeUndefined();
  });

  it("removes the local session and key but keeps the remote account and local alias", async () => {
    const sequence: string[] = [];
    const api = makeApi({
      deleteSession: vi.fn(async () => {
        sequence.push("delete-session");
      }),
    });
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: () => api.api,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "session-1",
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "account-1",
            selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
            aliases: { "account-1": "Personal" },
          },
        },
      },
    });
    await harness.service.initialize();
    vi.mocked(api.api.deleteSession).mockClear();
    sequence.length = 0;

    const state = await harness.service.removeProjectApiKey();

    expect(sequence).toEqual(["delete-session"]);
    expect(api.api.deleteAccount).not.toHaveBeenCalled();
    expect(harness.getSavedKey()).toBeUndefined();
    expect(harness.getProfile().sessionId).toBeUndefined();
    expect(harness.getProfile().toolkits.github?.aliases).toEqual({ "account-1": "Personal" });
    expect(state).toMatchObject({ apiKeyConfigured: false, status: "unconfigured" });
  });

  it("clears the local key and retains connected accounts if remote session deletion fails", async () => {
    const api = makeApi({
      deleteSession: vi.fn(async () => {
        throw Object.assign(new Error("temporary Composio outage"), { statusCode: 503 });
      }),
    });
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: () => api.api,
      profile: {
        version: 1,
        profileId: PROFILE_ID,
        sessionId: "session-1",
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "account-1",
            selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
            aliases: { "account-1": "Personal" },
          },
        },
      },
    });
    await harness.service.initialize();

    const state = await harness.service.removeProjectApiKey();

    expect(harness.getSavedKey()).toBeUndefined();
    expect(harness.getProfile().sessionId).toBeUndefined();
    expect(harness.getProfile().toolkits.github?.aliases).toEqual({ "account-1": "Personal" });
    expect(api.api.deleteAccount).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      apiKeyConfigured: false,
      status: "error",
      error: { code: "session_sync_failed", retryable: true },
    });
  });

  it("preserves the existing encrypted key when replacement read-access validation fails", async () => {
    const oldApi = makeApi();
    const newApi = makeApi({
      validateProjectReadAccess: vi.fn(async () => {
        throw Object.assign(new Error(`unauthorized ${NEW_KEY} ${RAW_CONNECT_URL}`), {
          statusCode: 401,
          code: "invalid_api_key",
        });
      }),
    });
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: (key) => (key === OLD_KEY ? oldApi.api : newApi.api),
    });
    await harness.service.initialize();

    const state = await harness.service.setProjectApiKey(NEW_KEY);

    expect(harness.getSavedKey()).toBe(OLD_KEY);
    expect(harness.secretStore.save).not.toHaveBeenCalled();
    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalled();
    expect(state).toMatchObject({ status: "error", apiKeyConfigured: true });
    expect(JSON.stringify(state)).not.toMatch(
      new RegExp(`${NEW_KEY}|${RAW_CONNECT_URL}|${OLD_KEY}`),
    );
  });

  it("preserves the existing key when a candidate lacks scoped read access", async () => {
    const oldApi = makeApi();
    const restrictedApi = makeApi({
      validateProjectReadAccess: vi.fn(async () => {
        throw Object.assign(new Error(`missing account read scope for ${NEW_KEY}`), {
          statusCode: 403,
          code: "insufficient_scope",
        });
      }),
    });
    const harness = startHarness({
      initialKey: OLD_KEY,
      apiForKey: (key) => (key === OLD_KEY ? oldApi.api : restrictedApi.api),
    });
    await harness.service.initialize();

    const state = await harness.service.setProjectApiKey(NEW_KEY);

    expect(harness.getSavedKey()).toBe(OLD_KEY);
    expect(harness.secretStore.save).not.toHaveBeenCalled();
    expect(state.error).toMatchObject({ code: "missing_scope_read", retryable: false });
    expect(state.error?.message).toMatch(/read/i);
    expect(JSON.stringify(state)).not.toMatch(new RegExp(`${NEW_KEY}|${OLD_KEY}`));
  });

  it("does not validate or save a replacement if the existing tools cannot be hidden first", async () => {
    const harness = startHarness({ initialKey: OLD_KEY });
    await harness.service.initialize();
    vi.mocked(harness.mcp.unregisterComposioMcpSession).mockRejectedValueOnce(
      new Error(`bridge teardown failed ${NEW_KEY} ${RAW_CONNECT_URL}`),
    );

    const state = await harness.service.setProjectApiKey(NEW_KEY);

    expect(harness.createApi).toHaveBeenCalledOnce();
    expect(harness.secretStore.save).not.toHaveBeenCalled();
    expect(harness.getSavedKey()).toBe(OLD_KEY);
    expect(state.error?.code).toBe("session_sync_failed");
    expect(JSON.stringify(state)).not.toMatch(new RegExp(`${NEW_KEY}|${RAW_CONNECT_URL}`));
  });

  it("surfaces a redacted and actionable write-scope error only when the explicit write is attempted", async () => {
    const writeDenied = makeApi({
      listAuthConfigs: vi.fn(async () => []),
      createManagedAuthConfig: vi.fn(async () => {
        throw Object.assign(
          new Error(`scope denied for ${NEW_KEY}; authorization=${RAW_CONNECT_URL}`),
          { statusCode: 403, code: "insufficient_scope" },
        );
      }),
    });
    const harness = startHarness({ initialKey: NEW_KEY, apiForKey: () => writeDenied.api });
    await harness.service.initialize();

    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Work",
    });

    expect(operation.status).toBe("failed");
    expect(operation.error).toMatchObject({ code: "missing_scope_write", retryable: false });
    expect(operation.error?.message).toMatch(/Auth Config|authentication configuration/i);
    expect(operation.error?.message).toMatch(/permission|enable|key/i);
    expect(operation.error?.message).toMatch(/restore the previous key/i);
    expect(JSON.stringify(operation)).not.toMatch(new RegExp(`${NEW_KEY}|${RAW_CONNECT_URL}`));
  });

  it("queries accounts only for the opaque local profile ID and maps account status and aliases safely", async () => {
    const profile: ComposioProfileConfig = {
      version: 1,
      profileId: PROFILE_ID,
      toolkits: {
        github: {
          enabled: false,
          selectedToolSlugs: [],
          aliases: { "account-1": "Work GitHub" },
        },
      },
    };
    const api = makeApi();
    api.accounts.push(
      makeAccount("account-1", "ACTIVE"),
      makeAccount("account-2", "EXPIRED"),
      makeAccount("account-3", "DISABLED"),
    );
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api, profile });

    const state = await harness.service.initialize();

    expect(api.api.listAccounts).toHaveBeenCalledWith(PROFILE_ID);
    expect(state.toolkits.find((toolkit) => toolkit.slug === "github")?.accounts).toEqual([
      { id: "account-2", toolkitSlug: "github", alias: "Provider account-2", status: "expired" },
      { id: "account-3", toolkitSlug: "github", alias: "Provider account-3", status: "disabled" },
      { id: "account-1", toolkitSlug: "github", alias: "Work GitHub", status: "active" },
    ]);
    expect(JSON.stringify(state)).not.toMatch(/provider-access-secret|provider-refresh-secret/);
  });

  it("rejects a sixth account when five accounts already exist", async () => {
    const api = makeApi();
    api.accounts.push(
      ...Array.from({ length: 5 }, (_, index) => makeAccount(`account-${index + 1}`)),
    );
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Sixth",
    });

    expect(operation.status).toBe("failed");
    expect(operation.error?.code).toBe("account_limit");
    expect(api.api.linkAccount).not.toHaveBeenCalled();
  });

  it("counts pending links atomically when concurrent requests approach the five-account cap", async () => {
    const api = makeApi();
    api.accounts.push(
      ...Array.from({ length: 4 }, (_, index) => makeAccount(`account-${index + 1}`)),
    );
    const wait = deferred<ReturnType<typeof makeAccount>>();
    api.waitForConnection.mockImplementation(() => wait.promise);
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    const operations = await Promise.all([
      harness.service.startConnection({ toolkitSlug: "github", alias: "Pending one" }),
      harness.service.startConnection({ toolkitSlug: "github", alias: "Pending two" }),
    ]);

    expect(operations.map((operation) => operation.status)).toEqual(["pending", "failed"]);
    expect(operations[1]?.error?.code).toBe("account_limit");
    expect(api.api.linkAccount).toHaveBeenCalledOnce();
    wait.resolve(makeAccount("account-new"));
    await waitForOperation(harness, operations[0]?.id, "active");
  });

  it("requests multiple-account creation with the chosen alias through a safe Connect Link", async () => {
    const api = makeApi();
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Work",
    });

    expect(api.api.linkAccount).toHaveBeenCalledWith({
      userId: PROFILE_ID,
      authConfigId: "auth-config-managed",
      alias: "Work",
      allowMultiple: true,
    });
    expect(harness.openExternal).toHaveBeenCalledWith(RAW_CONNECT_URL);
    expect(operation).toMatchObject({
      toolkitSlug: "github",
      alias: "Work",
      status: "pending",
    });
    expect(JSON.stringify(operation)).not.toContain(RAW_CONNECT_URL);
    await waitForOperation(harness, operation.id, "active");
    expect(harness.getProfile().toolkits.github).toMatchObject({
      enabled: false,
      selectedToolSlugs: [],
      aliases: { "account-new": "Work" },
    });
    expect(api.waitForConnection).toHaveBeenCalledWith(60_000, expect.any(AbortSignal));
  });

  it("creates a Composio-managed auth config when the project has no usable configuration", async () => {
    const api = makeApi({ listAuthConfigs: vi.fn(async () => []) });
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();

    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Work",
    });

    expect(api.api.createManagedAuthConfig).toHaveBeenCalledWith("github");
    expect(api.api.linkAccount).toHaveBeenCalledWith({
      userId: PROFILE_ID,
      authConfigId: "auth-config-created",
      alias: "Work",
      allowMultiple: true,
    });
    await waitForOperation(harness, operation.id, "active");
  });

  it("renames only an account owned by the local profile and persists the alias locally", async () => {
    const profile: ComposioProfileConfig = {
      version: 1,
      profileId: PROFILE_ID,
      toolkits: { github: { enabled: false, selectedToolSlugs: [], aliases: {} } },
    };
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api, profile });
    await harness.service.initialize();

    const state = await harness.service.renameAccount({
      toolkitSlug: "github",
      accountId: "account-1",
      alias: "  Company GitHub  ",
    });

    expect(api.api.listAccounts).toHaveBeenCalledWith(PROFILE_ID, "github");
    expect(harness.getProfile().toolkits.github?.aliases).toEqual({
      "account-1": "Company GitHub",
    });
    expect(state.toolkits.find((toolkit) => toolkit.slug === "github")?.accounts[0]?.alias).toBe(
      "Company GitHub",
    );
  });

  it("hides a selected account before revoking it and clears its local selection and alias", async () => {
    const profile: ComposioProfileConfig = {
      version: 1,
      profileId: PROFILE_ID,
      toolkits: {
        github: {
          enabled: true,
          selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
          selectedAccountId: "account-1",
          aliases: { "account-1": "Work GitHub" },
        },
      },
    };
    const api = makeApi();
    api.accounts.push(makeAccount("account-1"));
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api, profile });
    await harness.service.initialize();

    await harness.service.disconnectAccount({ toolkitSlug: "github", accountId: "account-1" });

    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalledTimes(3);
    const unregisterOrder =
      vi.mocked(harness.mcp.unregisterComposioMcpSession).mock.invocationCallOrder[0] ?? Infinity;
    const deleteOrder = vi.mocked(api.api.deleteAccount).mock.invocationCallOrder[0] ?? -Infinity;
    expect(unregisterOrder).toBeLessThan(deleteOrder);
    expect(api.api.deleteAccount).toHaveBeenCalledWith("account-1");
    expect(harness.getProfile().toolkits.github).toMatchObject({
      enabled: true,
      selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
      aliases: {},
    });
    expect(harness.getProfile().toolkits.github?.selectedAccountId).toBeUndefined();
  });

  it("never opens an insecure or foreign Connect Link and never returns the raw URL", async () => {
    for (const redirectUrl of [
      "http://connect.composio.dev/link/insecure-secret",
      "https://evil.example/link/foreign-secret",
    ]) {
      const api = makeApi();
      api.connectionRequest.redirectUrl = redirectUrl;
      const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
      await harness.service.initialize();

      const operation = await harness.service.startConnection({
        toolkitSlug: "github",
        alias: "Work",
      });

      expect(harness.openExternal).not.toHaveBeenCalled();
      expect(operation.status).toBe("failed");
      expect(JSON.stringify(operation)).not.toContain(redirectUrl);
      await harness.service.shutdown();
    }
  });

  it("marks canceled and expired authorizations without enabling the toolkit", async () => {
    const canceledApi = makeApi();
    canceledApi.waitForConnection.mockImplementation(async () => {
      throw Object.assign(new Error("user canceled authorization"), {
        code: "CONNECTION_CANCELED",
      });
    });
    const canceledHarness = startHarness({ initialKey: OLD_KEY, apiForKey: () => canceledApi.api });
    await canceledHarness.service.initialize();
    const canceled = await canceledHarness.service.startConnection({
      toolkitSlug: "github",
      alias: "Canceled",
    });
    await waitForOperation(canceledHarness, canceled.id, "canceled");
    expect(canceledHarness.getProfile().toolkits.github).toBeUndefined();

    const expiredApi = makeApi();
    expiredApi.waitForConnection.mockResolvedValue(makeAccount("account-expired", "EXPIRED"));
    const expiredHarness = startHarness({ initialKey: OLD_KEY, apiForKey: () => expiredApi.api });
    await expiredHarness.service.initialize();
    const expired = await expiredHarness.service.startConnection({
      toolkitSlug: "github",
      alias: "Expired",
    });
    await waitForOperation(expiredHarness, expired.id, "expired");
    expect(expiredHarness.getProfile().toolkits.github).toBeUndefined();
  });

  it("ignores a late account result after the 60-second connection timeout", async () => {
    vi.useFakeTimers();
    const api = makeApi();
    const wait = deferred<ReturnType<typeof makeAccount>>();
    api.waitForConnection.mockImplementation(() => wait.promise);
    const harness = startHarness({ initialKey: OLD_KEY, apiForKey: () => api.api });
    await harness.service.initialize();
    const operation = await harness.service.startConnection({
      toolkitSlug: "github",
      alias: "Late",
    });

    await vi.advanceTimersByTimeAsync(60_001);
    await expect(harness.service.getConnectionOperation(operation.id)).resolves.toMatchObject({
      status: "expired",
    });
    wait.resolve(makeAccount("late-account"));
    await Promise.resolve();

    expect(harness.getProfile().toolkits.github).toBeUndefined();
    expect((await harness.service.getConnectionOperation(operation.id)).status).toBe("expired");
  });
});
