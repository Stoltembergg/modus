import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposioMcpBridge } from "../mcp/mcp-service";
import type {
  ComposioAccountRecord,
  ComposioApi,
  ComposioSession,
  ComposioToolkitRecord,
  ComposioToolRecord,
} from "./composio-api";
import type { ComposioProfileConfig } from "./composio-profile-store";
import { buildComposioSessionConfig, reconcileComposioSession } from "./composio-session-sync";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_MCP = {
  url: "https://mcp.composio.dev/session/session-path-secret",
  headers: { "x-session-key": "session-header-secret" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeProfile(overrides: Partial<ComposioProfileConfig> = {}): ComposioProfileConfig {
  return {
    version: 1,
    profileId: PROFILE_ID,
    toolkits: {
      github: {
        enabled: true,
        selectedAccountId: "github-account-1",
        selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES", "GITHUB_CREATE_ISSUE"],
        aliases: { "github-account-1": "Work" },
      },
    },
    ...overrides,
  };
}

function makeSession(
  options: {
    id?: string;
    configVersion?: number;
    update?: (...args: unknown[]) => Promise<void>;
  } = {},
) {
  return {
    id: options.id ?? "session-1",
    configVersion: options.configVersion ?? 7,
    mcp: SESSION_MCP,
    update: vi.fn(options.update ?? (async () => {})),
  } as unknown as ComposioSession & { update: ReturnType<typeof vi.fn> };
}

function makeHarness(
  options: {
    profile?: ComposioProfileConfig;
    toolkitRecords?: ComposioToolkitRecord[];
    accounts?: ComposioAccountRecord[];
    tools?: ComposioToolRecord[];
    createSession?: ComposioApi["createSession"];
    useSession?: ComposioApi["useSession"];
    updateTools?: ComposioMcpBridge["registerComposioMcpSession"];
  } = {},
) {
  const session = makeSession();
  const sequence: string[] = [];
  const api = {
    validateProjectReadAccess: vi.fn(async () => {}),
    listToolkits: vi.fn(async () => options.toolkitRecords ?? [{ slug: "github", name: "GitHub" }]),
    listTools: vi.fn(
      async () =>
        options.tools ?? [
          { slug: "GITHUB_LIST_REPOSITORIES", name: "List repositories" },
          { slug: "GITHUB_CREATE_ISSUE", name: "Create issue" },
        ],
    ),
    listAuthConfigs: vi.fn(async () => []),
    createManagedAuthConfig: vi.fn(async () => ({
      id: "auth",
      isComposioManaged: true,
      authScheme: "OAUTH2",
    })),
    listAccounts: vi.fn(
      async () =>
        options.accounts ?? [
          { id: "github-account-1", toolkitSlug: "github", alias: "Work", status: "ACTIVE" },
        ],
    ),
    linkAccount: vi.fn(),
    deleteAccount: vi.fn(async () => {}),
    createSession: vi.fn(options.createSession ?? (async () => session)),
    useSession: vi.fn(options.useSession ?? (async () => session)),
    deleteSession: vi.fn(async () => {
      sequence.push("delete-session");
    }),
  } as unknown as ComposioApi & Record<string, ReturnType<typeof vi.fn>>;
  const mcp: ComposioMcpBridge = {
    unregisterComposioMcpSession: vi.fn(async () => {
      sequence.push("unregister");
    }),
    registerComposioMcpSession: vi.fn(
      async (input: Parameters<ComposioMcpBridge["registerComposioMcpSession"]>[0]) => {
        sequence.push("register");
        return input.allowedToolSlugs.map((slug) => ({
          name: slug,
          registeredName: `registered_${slug}`,
        }));
      },
    ),
  };
  if (options.updateTools) mcp.registerComposioMcpSession = options.updateTools;
  const profile = options.profile ?? makeProfile();
  const persistedSessionIds: Array<string | undefined> = [];
  const input = {
    profile,
    api,
    mcp,
    persistSessionId: (sessionId: string | undefined) => {
      persistedSessionIds.push(sessionId);
    },
  };
  return { api, mcp, session, sequence, profile, input, persistedSessionIds };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildComposioSessionConfig", () => {
  it("uses only enabled toolkit policies with one selected account and selected operations", () => {
    const profile = makeProfile({
      toolkits: {
        github: {
          enabled: true,
          selectedAccountId: "github-account-1",
          selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES", "GITHUB_CREATE_ISSUE"],
          aliases: {},
        },
        slack: {
          enabled: false,
          selectedAccountId: "slack-account-1",
          selectedToolSlugs: ["SLACK_SEND_MESSAGE"],
          aliases: {},
        },
        empty: { enabled: true, selectedToolSlugs: [], aliases: {} },
      },
    });

    const config = buildComposioSessionConfig(PROFILE_ID, profile);

    expect(config).toEqual({
      toolkits: { enable: ["github"] },
      tools: {
        github: { enable: ["GITHUB_LIST_REPOSITORIES", "GITHUB_CREATE_ISSUE"] },
      },
      connectedAccounts: { github: ["github-account-1"] },
      sessionPreset: "direct_tools",
      mcp: true,
      sandbox: { enable: false },
      manageConnections: { enable: false },
      multiAccount: { enable: false, requireExplicitSelection: false },
    });
  });
});

describe("reconcileComposioSession", () => {
  it("validates selected toolkit, active account, and known tool IDs before building the session allowlist", async () => {
    const harness = makeHarness({
      profile: makeProfile({
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "expired-account",
            selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
            aliases: {},
          },
          slack: {
            enabled: true,
            selectedAccountId: "foreign-account",
            selectedToolSlugs: ["SLACK_SEND_MESSAGE"],
            aliases: {},
          },
          unknown: {
            enabled: true,
            selectedAccountId: "unknown-account",
            selectedToolSlugs: ["UNKNOWN_TOOL"],
            aliases: {},
          },
        },
      }),
      accounts: [
        { id: "expired-account", toolkitSlug: "github", status: "EXPIRED" },
        { id: "foreign-account", toolkitSlug: "slack", status: "ACTIVE" },
      ],
    });

    await reconcileComposioSession(harness.input);

    expect(harness.api.listAccounts).toHaveBeenCalledWith(PROFILE_ID);
    expect(harness.api.createSession).not.toHaveBeenCalled();
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
  });

  it("does not create a session when the saved policy has no selected operations", async () => {
    const harness = makeHarness({
      profile: makeProfile({
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "github-account-1",
            selectedToolSlugs: [],
            aliases: {},
          },
        },
      }),
    });

    const state = await reconcileComposioSession(harness.input);

    expect(harness.api.createSession).not.toHaveBeenCalled();
    expect(harness.api.useSession).not.toHaveBeenCalled();
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(state.status).toBe("ready");
  });

  it("unregisters locally and deletes the remote session when the final selected operation is removed", async () => {
    const harness = makeHarness({
      profile: makeProfile({
        sessionId: "session-1",
        toolkits: {
          github: {
            enabled: true,
            selectedAccountId: "github-account-1",
            selectedToolSlugs: [],
            aliases: {},
          },
        },
      }),
    });

    await reconcileComposioSession(harness.input);

    expect(harness.sequence).toEqual(["unregister", "delete-session"]);
    expect(harness.api.deleteSession).toHaveBeenCalledWith("session-1");
    expect(harness.persistedSessionIds).toEqual([undefined]);
  });

  it("sends complete replacement maps and the current config version on every non-empty update", async () => {
    const session = makeSession({ configVersion: 12 });
    const harness = makeHarness({
      profile: makeProfile({ sessionId: "session-1" }),
      useSession: vi.fn(async () => session),
    });

    await reconcileComposioSession(harness.input);

    expect(session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        toolkits: { enable: ["github"] },
        tools: {
          github: { enable: ["GITHUB_LIST_REPOSITORIES", "GITHUB_CREATE_ISSUE"] },
        },
        connectedAccounts: { github: ["github-account-1"] },
      }),
      12,
    );
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenCalledWith({
      url: SESSION_MCP.url,
      headers: SESSION_MCP.headers,
      allowedToolSlugs: ["GITHUB_LIST_REPOSITORIES", "GITHUB_CREATE_ISSUE"],
    });
    expect(harness.persistedSessionIds).toEqual(["session-1"]);
  });

  it("removes local tools before a remote update and leaves them hidden if that update fails", async () => {
    const session = makeSession({
      update: async () => {
        throw Object.assign(
          new Error(`remote ${SESSION_MCP.url} ${SESSION_MCP.headers["x-session-key"]}`),
          {
            statusCode: 500,
          },
        );
      },
    });
    const harness = makeHarness({
      profile: makeProfile({ sessionId: "session-1" }),
      useSession: vi.fn(async () => session),
    });

    const state = await reconcileComposioSession(harness.input);

    expect(harness.sequence[0]).toBe("unregister");
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).not.toMatch(
      new RegExp(`${SESSION_MCP.url}|${SESSION_MCP.headers["x-session-key"]}`),
    );
  });

  it("maps a denied session update to an actionable write-scope error and keeps tools hidden", async () => {
    const session = makeSession({
      update: async () => {
        throw Object.assign(new Error("missing scope"), {
          statusCode: 403,
          code: "insufficient_scope",
        });
      },
    });
    const harness = makeHarness({
      profile: makeProfile({ sessionId: "session-1" }),
      useSession: vi.fn(async () => session),
    });

    const state = await reconcileComposioSession(harness.input);

    expect(state.status).toBe("error");
    expect(state.error).toMatchObject({ code: "missing_scope_write", retryable: false });
    expect(state.error?.message).toMatch(/permissão de escrita/i);
    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
  });

  it("keeps tools hidden and does not persist a new session if MCP refresh fails", async () => {
    const harness = makeHarness({
      profile: makeProfile(),
      updateTools: vi.fn(async () => {
        throw new Error(`bridge failed ${SESSION_MCP.url} ${SESSION_MCP.headers["x-session-key"]}`);
      }),
    });

    const state = await reconcileComposioSession(harness.input);

    expect(harness.api.createSession).toHaveBeenCalledOnce();
    expect(harness.mcp.unregisterComposioMcpSession).toHaveBeenCalledTimes(2);
    expect(harness.persistedSessionIds).toEqual([]);
    expect(harness.api.deleteSession).toHaveBeenCalledWith("session-1");
    expect(state.status).toBe("error");
    expect(JSON.stringify(state)).not.toMatch(
      new RegExp(`${SESSION_MCP.url}|${SESSION_MCP.headers["x-session-key"]}`),
    );
  });

  it("does not let a stale concurrent policy register tools after a newer disable", async () => {
    const updateDone = deferred<void>();
    const updateStarted = deferred<void>();
    const session = makeSession({
      update: async () => {
        updateStarted.resolve();
        await updateDone.promise;
      },
    });
    const harness = makeHarness({
      profile: makeProfile({ sessionId: "session-1" }),
      useSession: vi.fn(async () => session),
    });
    let latestProfile = harness.profile;
    const input = { ...harness.input, loadProfile: () => latestProfile };

    const staleSync = reconcileComposioSession(input);
    await updateStarted.promise;
    latestProfile = makeProfile({
      sessionId: "session-1",
      toolkits: {
        github: {
          enabled: false,
          selectedAccountId: "github-account-1",
          selectedToolSlugs: [],
          aliases: {},
        },
      },
    });
    const latestSync = reconcileComposioSession(input);
    updateDone.resolve();
    await Promise.all([staleSync, latestSync]);

    expect(harness.mcp.registerComposioMcpSession).not.toHaveBeenCalled();
    expect(harness.api.deleteSession).toHaveBeenCalledWith("session-1");
    expect(harness.persistedSessionIds).toEqual([undefined]);
  });

  it("refetches a 409 conflict and retries with only the latest local full policy", async () => {
    const firstSession = makeSession({
      configVersion: 2,
      update: async () => {
        throw Object.assign(new Error("version conflict"), { statusCode: 409 });
      },
    });
    const refreshedSession = makeSession({ id: "session-1", configVersion: 9 });
    const harness = makeHarness({
      profile: makeProfile({ sessionId: "session-1" }),
      useSession: vi
        .fn()
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(refreshedSession),
      tools: [
        { slug: "GITHUB_LIST_REPOSITORIES", name: "List repositories" },
        { slug: "GITHUB_CREATE_ISSUE", name: "Create issue" },
        { slug: "GITHUB_GET_ISSUE", name: "Get issue" },
      ],
    });
    const latestProfile = makeProfile({
      sessionId: "session-1",
      toolkits: {
        github: {
          enabled: true,
          selectedAccountId: "github-account-1",
          selectedToolSlugs: ["GITHUB_GET_ISSUE"],
          aliases: {},
        },
      },
    });

    await reconcileComposioSession({ ...harness.input, loadProfile: () => latestProfile });

    expect(harness.api.useSession).toHaveBeenNthCalledWith(1, "session-1");
    expect(harness.api.useSession).toHaveBeenNthCalledWith(2, "session-1");
    expect(refreshedSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        toolkits: { enable: ["github"] },
        tools: { github: { enable: ["GITHUB_GET_ISSUE"] } },
        connectedAccounts: { github: ["github-account-1"] },
      }),
      9,
    );
    expect(harness.mcp.registerComposioMcpSession).toHaveBeenCalledWith({
      url: SESSION_MCP.url,
      headers: SESSION_MCP.headers,
      allowedToolSlugs: ["GITHUB_GET_ISSUE"],
    });
  });
});
