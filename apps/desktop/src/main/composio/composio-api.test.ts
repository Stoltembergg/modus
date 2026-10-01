import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { client, composioConstructor } = vi.hoisted(() => {
  const client = {
    toolkits: { get: vi.fn() },
    tools: { getRawComposioTools: vi.fn() },
    connectedAccounts: {
      list: vi.fn(),
      link: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    },
    authConfigs: { list: vi.fn(), create: vi.fn() },
    sessions: { create: vi.fn(), use: vi.fn(), delete: vi.fn() },
  };
  return {
    client,
    composioConstructor: vi.fn(function MockComposio() {
      return client;
    }),
  };
});

vi.mock("@composio/core", () => ({
  Composio: composioConstructor,
  SessionPreset: { DIRECT_TOOLS: "direct_tools" },
}));

import { SessionPreset } from "@composio/core";
import { createComposioApi } from "./composio-api";

function makeSdkAccount(id: string, status = "ACTIVE") {
  return {
    id,
    alias: `Alias ${id}`,
    status,
    isDisabled: false,
    toolkit: { slug: "github" },
    authConfig: {
      id: "auth-config-1",
      authScheme: "OAUTH2",
      isComposioManaged: true,
      credentials: { access_token: "provider-token" },
    },
    state: { access_token: "provider-token" },
    data: { refresh_token: "refresh-token" },
    params: { secret: "private-param" },
  };
}

function makeSessionConfig() {
  return {
    toolkits: { enable: ["github"] },
    tools: { github: { enable: ["GITHUB_LIST_REPOSITORIES"] } },
    connectedAccounts: { github: ["account-1"] },
    sessionPreset: SessionPreset.DIRECT_TOOLS,
    mcp: true as const,
    sandbox: { enable: false as const },
    manageConnections: { enable: false as const },
    multiAccount: { enable: false as const, requireExplicitSelection: false as const },
  };
}

describe("Composio API adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates catalog and local-profile account read access before a key can replace the saved key", async () => {
    client.toolkits.get.mockResolvedValue([]);
    client.connectedAccounts.list.mockResolvedValue({ items: [], nextCursor: null, totalPages: 1 });
    const api = createComposioApi("project-key");

    await api.validateProjectReadAccess("local-profile-7");

    expect(client.toolkits.get).toHaveBeenCalledWith({ managedBy: "all", limit: 1 });
    expect(client.connectedAccounts.list).toHaveBeenCalledWith({
      userIds: ["local-profile-7"],
      limit: 1,
    });
  });

  it("lists every account scoped to the supplied local profile ID", async () => {
    client.connectedAccounts.list
      .mockResolvedValueOnce({
        items: [makeSdkAccount("account-1")],
        nextCursor: "page-2",
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        items: [makeSdkAccount("account-2", "EXPIRED")],
        nextCursor: null,
        totalPages: 2,
      });
    const api = createComposioApi("project-key");

    const accounts = await api.listAccounts("local-profile-7", "github");

    expect(client.connectedAccounts.list).toHaveBeenNthCalledWith(1, {
      userIds: ["local-profile-7"],
      toolkitSlugs: ["github"],
      limit: 100,
    });
    expect(client.connectedAccounts.list).toHaveBeenNthCalledWith(2, {
      userIds: ["local-profile-7"],
      toolkitSlugs: ["github"],
      limit: 100,
      cursor: "page-2",
    });
    expect(accounts).toEqual([
      { id: "account-1", toolkitSlug: "github", alias: "Alias account-1", status: "ACTIVE" },
      { id: "account-2", toolkitSlug: "github", alias: "Alias account-2", status: "EXPIRED" },
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(/provider-token|refresh-token|private-param/);
  });

  it("passes the requested alias and allowMultiple flag to Composio Connect Link", async () => {
    const waitForConnection = vi.fn().mockResolvedValue(makeSdkAccount("account-new"));
    client.connectedAccounts.link.mockResolvedValue({
      id: "connection-request-1",
      redirectUrl: "https://connect.composio.dev/link/short-lived-token",
      waitForConnection,
    });
    client.connectedAccounts.get.mockResolvedValue(makeSdkAccount("account-new"));
    const api = createComposioApi("project-key");

    const request = await api.linkAccount({
      userId: "local-profile-7",
      authConfigId: "auth-config-1",
      alias: "Work GitHub",
      allowMultiple: true,
    });

    expect(client.connectedAccounts.link).toHaveBeenCalledWith("local-profile-7", "auth-config-1", {
      alias: "Work GitHub",
      allowMultiple: true,
    });
    expect(request).toMatchObject({
      id: "connection-request-1",
      redirectUrl: "https://connect.composio.dev/link/short-lived-token",
    });
    await expect(request.waitForConnection(1000)).resolves.toMatchObject({
      id: "account-new",
      toolkitSlug: "github",
    });
    expect(client.connectedAccounts.get).toHaveBeenCalledWith(
      "connection-request-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(waitForConnection).not.toHaveBeenCalled();
  });

  it("bounds connection polling by the requested timeout", async () => {
    vi.useFakeTimers();
    client.connectedAccounts.link.mockResolvedValue({
      id: "connection-request-2",
      redirectUrl: "https://connect.composio.dev/link/short-lived-token",
      waitForConnection: vi.fn(),
    });
    client.connectedAccounts.get.mockResolvedValue(makeSdkAccount("account-2", "INITIATED"));
    const api = createComposioApi("project-key");
    const request = await api.linkAccount({
      userId: "local-profile-7",
      authConfigId: "auth-config-1",
      alias: "Second account",
      allowMultiple: true,
    });

    const rejection = expect(request.waitForConnection(1_500)).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1_500);
    await rejection;
    vi.useRealTimers();
  });

  it("aborts an in-flight connection status request on shutdown", async () => {
    client.connectedAccounts.link.mockResolvedValue({
      id: "connection-request-abort",
      redirectUrl: "https://connect.composio.dev/link/short-lived-token",
      waitForConnection: vi.fn(),
    });
    client.connectedAccounts.get.mockImplementation(
      (_id, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const api = createComposioApi("project-key");
    const request = await api.linkAccount({
      userId: "local-profile-7",
      authConfigId: "auth-config-1",
      alias: "Abortable account",
      allowMultiple: true,
    });
    const controller = new AbortController();
    const waiting = request.waitForConnection(60_000, controller.signal);
    controller.abort(new Error("Modus is shutting down."));

    await expect(waiting).rejects.toThrow(/shutting down/i);
    expect(client.connectedAccounts.get).toHaveBeenCalledWith(
      "connection-request-abort",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts a stalled status request when its connection wait reaches the deadline", async () => {
    vi.useFakeTimers();
    client.connectedAccounts.link.mockResolvedValue({
      id: "connection-request-timeout",
      redirectUrl: "https://connect.composio.dev/link/short-lived-token",
      waitForConnection: vi.fn(),
    });
    let requestSignal: AbortSignal | undefined;
    client.connectedAccounts.get.mockImplementation((_id, options) => {
      requestSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
          once: true,
        });
      });
    });
    const api = createComposioApi("project-key");
    const request = await api.linkAccount({
      userId: "local-profile-7",
      authConfigId: "auth-config-1",
      alias: "Timed account",
      allowMultiple: true,
    });
    const rejection = expect(request.waitForConnection(1_000)).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(requestSignal?.aborted).toBe(true);
  });

  it("maps toolkit and tool metadata without returning auth or execution state", async () => {
    client.toolkits.get.mockResolvedValue([
      {
        slug: "github",
        name: "GitHub",
        meta: { description: "Source control", logo: "https://assets.example/github.svg" },
        authConfigDetails: [{ credentials: { client_secret: "should-not-leak" } }],
      },
    ]);
    client.tools.getRawComposioTools.mockResolvedValue([
      {
        slug: "GITHUB_LIST_REPOSITORIES",
        name: "List repositories",
        description: "List repositories for the authenticated user.",
        toolkit: { slug: "github", name: "GitHub" },
        inputParameters: { properties: { access_token: { type: "string" } } },
      },
    ]);
    const api = createComposioApi("project-key");

    const toolkits = await api.listToolkits();
    const tools = await api.listTools("github");

    expect(toolkits).toEqual([{ slug: "github", name: "GitHub", description: "Source control" }]);
    expect(tools).toEqual([
      {
        slug: "GITHUB_LIST_REPOSITORIES",
        name: "List repositories",
        description: "List repositories for the authenticated user.",
      },
    ]);
    expect(JSON.stringify({ toolkits, tools })).not.toMatch(
      /should-not-leak|access_token|client_secret/,
    );
  });

  it("passes config versions through the SDK update config and keeps MCP fields in the main process", async () => {
    const sdkUpdate = vi.fn().mockResolvedValue(undefined);
    client.sessions.use.mockResolvedValue({
      sessionId: "session-1",
      configVersion: 12,
      mcp: {
        url: "https://mcp.composio.dev/session",
        headers: { "x-session-key": "secret-header" },
      },
      update: sdkUpdate,
    });
    const api = createComposioApi("project-key");
    const config = makeSessionConfig();

    const session = await api.useSession("session-1");
    await session.update(config, 12);

    expect(client.sessions.use).toHaveBeenCalledWith("session-1", { mcp: true });
    const { mcp: _mcp, sessionPreset: _sessionPreset, ...mutableConfig } = config;
    expect(sdkUpdate).toHaveBeenCalledWith({ ...mutableConfig, expectedConfigVersion: 12 });
    expect(session).toEqual({
      id: "session-1",
      configVersion: 12,
      mcp: {
        url: "https://mcp.composio.dev/session",
        headers: { "x-session-key": "secret-header" },
      },
      update: expect.any(Function),
    });
  });

  it("refuses a session without SDK-issued MCP headers", async () => {
    client.sessions.use.mockResolvedValue({
      sessionId: "session-without-headers",
      configVersion: 1,
      mcp: { url: "https://mcp.composio.dev/session", headers: {} },
      update: vi.fn(),
    });
    const api = createComposioApi("project-key");

    await expect(api.useSession("session-without-headers")).rejects.toThrow(/MCP credentials/i);
  });
});
