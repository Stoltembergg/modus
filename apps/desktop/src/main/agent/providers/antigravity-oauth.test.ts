import { createHash } from "node:crypto";
import { Server as HttpServer } from "node:http";
import { connect as connectTcp, createServer } from "node:net";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_REDIRECT_URI,
  type AntigravityCallbackServer,
  createAntigravityOAuthProvider,
  createLoopbackCallbackServer,
  shutdownAntigravityAuth,
} from "./antigravity-oauth";

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 3600,
      ...overrides,
    }),
    { status: 200 },
  );

function mockCallbackServer(callback: URL | Error): AntigravityCallbackServer {
  return {
    waitForCallback: vi.fn(async () => {
      if (callback instanceof Error) throw callback;
      return callback;
    }),
    close: vi.fn(async () => undefined),
  };
}

function deps(
  fetch: typeof globalThis.fetch,
  callback = new URL(
    "http://localhost:51121/oauth-callback?code=auth-code&state=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  ),
) {
  const server = mockCallbackServer(callback);
  return {
    server,
    value: {
      clientId: "test-client",
      fetch,
      now: () => 1_700_000_000_000,
      createLoopbackCallbackServer: vi.fn(async () => server),
      openBrowser: vi.fn(async (_url: string) => undefined),
      createRandom: () => new Uint8Array(32).fill(7),
      timeoutMs: 5_000,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Antigravity OAuth provider", () => {
  it("accepts a real loopback HTTP callback and closes its listener", async () => {
    const server = await createLoopbackCallbackServer({
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      signal: new AbortController().signal,
    });
    const callback = server.waitForCallback(new AbortController().signal);
    const response = await fetch(
      `http://127.0.0.1:51121/oauth-callback?code=real-code&state=real-state`,
    );

    expect(response.ok).toBe(true);
    await expect(callback).resolves.toMatchObject({ searchParams: expect.objectContaining({}) });
    await server.close();
    const ipv6Server = await createLoopbackCallbackServer({
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      signal: new AbortController().signal,
    });
    const ipv6Callback = ipv6Server.waitForCallback(new AbortController().signal);
    try {
      const ipv6Response = await fetch(
        "http://[::1]:51121/oauth-callback?code=ipv6-code&state=ipv6-state",
      );
      expect(ipv6Response.ok).toBe(true);
      await expect(ipv6Callback).resolves.toBeInstanceOf(URL);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // IPv6 loopback can be unavailable on CI hosts; IPv4 remains mandatory.
      await ipv6Server.close();
    }
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(51121, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("closes both loopback listeners when authorization is cancelled", async () => {
    const controller = new AbortController();
    const server = await createLoopbackCallbackServer({
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      signal: controller.signal,
    });
    const waiting = server.waitForCallback(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancel/i);
    await server.close();
    const probes = ["127.0.0.1", "::1"].map(
      (host) =>
        new Promise<void>((resolve, reject) => {
          const probe = createServer();
          probe.once("error", (error) =>
            error && "code" in error && error.code === "EADDRNOTAVAIL" ? resolve() : reject(error),
          );
          probe.listen(51121, host, () =>
            probe.close((error) => (error ? reject(error) : resolve())),
          );
        }),
    );
    await Promise.all(probes);
  });

  it("force closes a stalled loopback socket so the redirect port can be rebound", async () => {
    const server = await createLoopbackCallbackServer({
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      signal: new AbortController().signal,
    });
    const socket = connectTcp(51121, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await server.close();
    socket.destroy();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(51121, "127.0.0.1", () =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
    });
  });

  it("stops accepting before force-closing loopback connections", async () => {
    const events: string[] = [];
    const originalClose = HttpServer.prototype.close;
    const originalCloseAllConnections = HttpServer.prototype.closeAllConnections;
    const close = vi.spyOn(HttpServer.prototype, "close").mockImplementation(function (
      this: HttpServer,
      ...args: Parameters<HttpServer["close"]>
    ) {
      events.push("close");
      return originalClose.apply(this, args);
    });
    const closeAllConnections = vi
      .spyOn(HttpServer.prototype, "closeAllConnections")
      .mockImplementation(function (this: HttpServer) {
        events.push("closeAllConnections");
        return originalCloseAllConnections.call(this);
      });
    const server = await createLoopbackCallbackServer({
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      signal: new AbortController().signal,
    });
    await server.close();

    expect(close).toHaveBeenCalled();
    expect(closeAllConnections).toHaveBeenCalled();
    expect(events.indexOf("close")).toBeLessThan(events.indexOf("closeAllConnections"));
  });

  it("uses the fixed loopback redirect and validates OAuth state before exchanging tokens", async () => {
    const responses = [
      tokenResponse(),
      new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider(setup.value);

    const connection = await provider.connect();

    expect(ANTIGRAVITY_REDIRECT_URI).toBe("http://localhost:51121/oauth-callback");
    expect(setup.value.openBrowser).toHaveBeenCalledOnce();
    const authUrl = new URL(setup.value.openBrowser.mock.calls[0]![0]);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(ANTIGRAVITY_REDIRECT_URI);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const tokenRequest = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const tokenForm = new URLSearchParams(String(tokenRequest[1].body));
    expect(tokenForm.has("client_secret")).toBe(false);
    expect(tokenForm.get("code_verifier")).toBe("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc");
    expect(authUrl.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(tokenForm.get("code_verifier")!).digest("base64url"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(connection).toMatchObject({ status: "connected", projectId: "project-1" });
    expect(JSON.stringify(connection)).not.toContain("access-secret");
    expect(JSON.stringify(connection)).not.toContain("refresh-secret");
    expect(setup.server.close).toHaveBeenCalledOnce();
  });

  it("rejects mismatched state without exchanging the authorization code", async () => {
    const fetch = vi.fn(async () => tokenResponse());
    const setup = deps(
      fetch,
      new URL("http://localhost:51121/oauth-callback?code=auth-code&state=wrong"),
    );
    const provider = createAntigravityOAuthProvider(setup.value);

    await expect(provider.connect()).rejects.toThrow(/state/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(setup.server.close).toHaveBeenCalledOnce();
  });

  it("sanitizes raw OAuth network errors before they can cross IPC", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("private access token echoed by service");
    });
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider(setup.value);

    await expect(provider.connect()).rejects.toMatchObject({
      message: "Antigravity OAuth network request failed",
    });
    expect(setup.server.close).toHaveBeenCalledOnce();
  });

  it("times out an unfinished loopback flow and shuts its callback server down", async () => {
    const fetch = vi.fn(async () => tokenResponse());
    const setup = deps(fetch);
    setup.value.timeoutMs = 1;
    setup.server.waitForCallback = vi.fn(() => new Promise<URL>(() => undefined));
    const provider = createAntigravityOAuthProvider(setup.value);

    await expect(provider.connect()).rejects.toMatchObject({ code: "timeout" });
    expect(setup.server.close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes callback listeners and invalidates pending authorization on shutdown", async () => {
    const fetch = vi.fn(async () => tokenResponse());
    const setup = deps(fetch);
    let callbackWaitStarted = false;
    setup.server.waitForCallback = (_signal: AbortSignal) =>
      new Promise<URL>((_resolve, reject) => {
        callbackWaitStarted = true;
        if (_signal.aborted) reject(new Error("aborted"));
        else _signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const provider = createAntigravityOAuthProvider(setup.value);
    const connecting = provider.connect();
    while (!callbackWaitStarted) await Promise.resolve();
    await shutdownAntigravityAuth();

    await expect(connecting).rejects.toThrow();
    expect(setup.server.close).toHaveBeenCalledOnce();
    expect(provider.getStatus()).toEqual({ status: "disconnected" });
  });

  it("cancels Pi AuthStorage login when its operation signal aborts", async () => {
    const setup = deps(vi.fn(async () => tokenResponse()));
    let callbackWaitStarted = false;
    setup.server.waitForCallback = (signal: AbortSignal) =>
      new Promise<URL>((_resolve, reject) => {
        callbackWaitStarted = true;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const provider = createAntigravityOAuthProvider(setup.value);
    const controller = new AbortController();
    const loggingIn = provider.oauth.login({
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(),
      onSelect: vi.fn(),
      signal: controller.signal,
    });
    while (!callbackWaitStarted) await Promise.resolve();
    controller.abort();

    await expect(loggingIn).rejects.toThrow();
    expect(setup.server.close).toHaveBeenCalledOnce();
  });

  it("distinguishes permanent invalid_grant refresh failure from transient failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 }),
      );
    const provider = createAntigravityOAuthProvider(deps(fetch).value);
    await provider.connect();

    await expect(provider.refresh()).rejects.toMatchObject({
      code: "invalid_grant",
      permanent: true,
    });
    await expect(provider.refresh()).rejects.toMatchObject({ permanent: false });
  });

  it("omits client_secret from refresh token exchange requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: "refreshed-access" }));
    const provider = createAntigravityOAuthProvider(deps(fetch).value);
    await provider.connect();

    await provider.refresh();

    const refreshRequest = fetch.mock.calls[2] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URLSearchParams(String(refreshRequest[1].body)).has("client_secret")).toBe(false);
  });

  it("returns Pi AuthStorage credentials and schedules rejected cleanup without awaiting it", async () => {
    let stored: { type: string; [key: string]: unknown } | undefined;
    let releaseCleanup!: () => void;
    const cleanup = vi.fn(() =>
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }).then(() => {
        stored = undefined;
      }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      );
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider({
      ...setup.value,
      removeRejectedCredential: cleanup,
    });
    const saved = await provider.oauth.login({
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(),
      onSelect: vi.fn(),
    });
    expect(saved).toMatchObject({
      access: "access-secret",
      refresh: "refresh-secret",
      projectId: "project-1",
    });
    stored = { type: "oauth", ...saved };
    await expect(provider.oauth.refreshToken(saved)).rejects.toMatchObject({
      code: "invalid_grant",
      permanent: true,
    });
    expect(cleanup).toHaveBeenCalledOnce();
    let shutdownDone = false;
    const shuttingDown = provider.shutdown().then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    expect(shutdownDone).toBe(false);
    releaseCleanup();
    await shuttingDown;
    expect(stored).toBeUndefined();
  });

  it("does not delete a newer credential while asynchronously cleaning a rejected one", async () => {
    const rejected = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 10 };
    const replacement = {
      type: "oauth",
      access: "new-access",
      refresh: "new-refresh",
      expires: 20,
    };
    let stored: { type: string; [key: string]: unknown } | undefined = rejected;
    const cleanup = vi.fn(async (rejectedCredential: OAuthCredentials) => {
      if (stored?.refresh === rejectedCredential.refresh) stored = undefined;
    });
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    const provider = createAntigravityOAuthProvider({
      ...deps(fetch).value,
      removeRejectedCredential: cleanup,
    });
    const refreshing = provider.oauth.refreshToken(rejected);
    await expect(refreshing).rejects.toMatchObject({ code: "invalid_grant", permanent: true });
    stored = replacement;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stored).toBe(replacement);
    expect(cleanup).toHaveBeenCalledOnce();
    await provider.shutdown();
    expect(stored).toBe(replacement);
  });

  it("does not schedule credential cleanup for transient refresh failures", async () => {
    const cleanup = vi.fn(async () => undefined);
    const provider = createAntigravityOAuthProvider({
      ...deps(
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 }),
        ),
      ).value,
      removeRejectedCredential: cleanup,
    });
    await expect(
      provider.oauth.refreshToken({ access: "a", refresh: "r", expires: 1 }),
    ).rejects.toMatchObject({ permanent: false });
    await provider.shutdown();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("drains a pending refresh and cleanup during shutdown while containing cleanup errors", async () => {
    let resolveResponse!: (response: Response) => void;
    let releaseCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          releaseCleanup = () => reject(new Error("private disk failure"));
        }),
    );
    const provider = createAntigravityOAuthProvider({
      ...deps(
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              resolveResponse = resolve;
            }),
        ),
      ).value,
      removeRejectedCredential: cleanup,
    });
    const refresh = provider.oauth.refreshToken({ access: "a", refresh: "r", expires: 1 });
    let shutdownDone = false;
    const shutdown = provider.shutdown().then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    expect(shutdownDone).toBe(false);
    resolveResponse(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(refresh).rejects.toMatchObject({ code: "invalid_grant" });
    while (!cleanup.mock.calls.length) await Promise.resolve();
    expect(shutdownDone).toBe(false);
    releaseCleanup();
    await expect(shutdown).resolves.toBeUndefined();
    expect(shutdownDone).toBe(true);
  });

  it("exposes missing project discovery without selecting a substitute project", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: null }), { status: 200 }),
      );
    const provider = createAntigravityOAuthProvider(deps(fetch).value);

    await expect(provider.connect()).resolves.toMatchObject({
      status: "missing-project",
      projectId: null,
    });
    expect(provider.getMissingProjectModelIds()).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(provider.getAvailableModels().map(({ id }) => id)).toEqual([
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3-flash",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-opus-4-6-thinking",
    ]);
  });

  it("keeps Antigravity models available when project discovery fails, but not Gemini CLI models", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new Error("private provider response"));
    const provider = createAntigravityOAuthProvider(deps(fetch).value);

    await expect(provider.connect()).resolves.toMatchObject({ status: "missing-project" });
    expect(provider.getAvailableModels().map(({ id }) => id)).toEqual([
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3-flash",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-opus-4-6-thinking",
    ]);
    expect(provider.getMissingProjectModelIds()).toHaveLength(6);
  });

  it("does not turn a cancelled project discovery into a successful missing-project login", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementationOnce(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider(setup.value);
    const connecting = provider.connect();
    while (fetch.mock.calls.length < 2) await Promise.resolve();
    await provider.cancel();

    await expect(connecting).rejects.toMatchObject({ code: "cancelled" });
    expect(provider.getStatus()).toEqual({ status: "disconnected" });
  });

  it("does not commit credentials when project discovery succeeds after cancel", async () => {
    let resolveProject!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      // Intentionally ignore AbortSignal: some fetch implementations may
      // still resolve successfully after cancellation.
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveProject = resolve;
          }),
      );
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider(setup.value);
    let loginSucceeded = false;
    const login = provider.oauth
      .login({
        onAuth: vi.fn(),
        onDeviceCode: vi.fn(),
        onPrompt: vi.fn(),
        onSelect: vi.fn(),
      })
      .then((credentials) => {
        loginSucceeded = true;
        return credentials;
      });
    while (fetch.mock.calls.length < 2) await Promise.resolve();

    await provider.cancel();
    resolveProject(
      new Response(JSON.stringify({ cloudaicompanionProject: "project-after-cancel" }), {
        status: 200,
      }),
    );

    await expect(login).rejects.toMatchObject({ code: "cancelled" });
    expect(loginSucceeded).toBe(false);
    expect(provider.getCredentials()).toBeNull();
    expect(provider.getStatus()).toEqual({ status: "disconnected" });
  });

  it("does not apply a refresh response after disconnect changes credential generation", async () => {
    let resolveRefresh!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const provider = createAntigravityOAuthProvider(deps(fetch).value);
    await provider.connect();
    const refreshing = provider.refresh();
    await provider.disconnect();
    resolveRefresh(tokenResponse({ access_token: "stale-access" }));

    await expect(refreshing).rejects.toThrow(/disconnect|credential/i);
    expect(provider.getStatus()).toMatchObject({ status: "disconnected" });
  });

  it("does not let a stale Pi refresh replace credentials from a newer login", async () => {
    let resolveRefresh!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "first-access", refresh_token: "first-refresh" }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "first-project" }), { status: 200 }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "new-project" }), { status: 200 }),
      );
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider(setup.value);
    const oldCredentials = await provider.oauth.login({
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(),
      onSelect: vi.fn(),
    });
    const staleRefresh = provider.oauth.refreshToken(oldCredentials);
    while (fetch.mock.calls.length < 3) await Promise.resolve();

    await provider.connect();
    resolveRefresh(tokenResponse({ access_token: "stale-access", refresh_token: "stale-refresh" }));
    await expect(staleRefresh).rejects.toThrow(/credential|refresh/i);
    expect(provider.getCredentials()).toMatchObject({
      accessToken: "new-access",
      projectId: "new-project",
    });
    await provider.shutdown();
  });

  it("rejects an older persisted Pi credential without returning or persisting a stale refresh result", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "new-project" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "stale-access", refresh_token: "stale-refresh" }),
      );
    const provider = createAntigravityOAuthProvider(deps(fetch).value);
    const newerCredentials = await provider.oauth.login({
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(),
      onSelect: vi.fn(),
    });
    const olderPersistedCredentials: OAuthCredentials = {
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
    };
    let persisted = olderPersistedCredentials;
    const refreshResult = provider.oauth
      .refreshToken(olderPersistedCredentials)
      .then((credentials) => {
        persisted = credentials;
        return credentials;
      });

    await expect(refreshResult).rejects.toThrow(/credential|refresh/i);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(persisted).toBe(olderPersistedCredentials);
    expect(provider.getCredentials()).toMatchObject({
      accessToken: newerCredentials.access,
      projectId: "new-project",
    });
    await provider.shutdown();
  });

  it("keeps newer in-memory credentials when an obsolete Pi refresh returns invalid_grant", async () => {
    let resolveRefresh!: (response: Response) => void;
    const cleanup = vi.fn(async () => undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "first-access", refresh_token: "first-refresh" }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "first-project" }), { status: 200 }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "new-project" }), { status: 200 }),
      );
    const setup = deps(fetch);
    const provider = createAntigravityOAuthProvider({
      ...setup.value,
      removeRejectedCredential: cleanup,
    });
    const oldCredentials = await provider.oauth.login({
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn(),
      onSelect: vi.fn(),
    });
    const staleRefresh = provider.oauth.refreshToken(oldCredentials);
    while (fetch.mock.calls.length < 3) await Promise.resolve();
    await provider.connect();
    resolveRefresh(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(staleRefresh).rejects.toMatchObject({ code: "invalid_grant", permanent: true });
    expect(provider.getCredentials()).toMatchObject({
      accessToken: "new-access",
      projectId: "new-project",
    });
    expect(cleanup).toHaveBeenCalledWith(oldCredentials);
    await provider.shutdown();
  });

  it("bounds shutdown by one deadline when refresh cleanup remains blocked", async () => {
    let resolveResponse!: (response: Response) => void;
    const cleanup = vi.fn(() => new Promise<void>(() => undefined));
    const provider = createAntigravityOAuthProvider({
      ...deps(
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              resolveResponse = resolve;
            }),
        ),
      ).value,
      removeRejectedCredential: cleanup,
      shutdownDrainTimeoutMs: 10,
    });
    const refreshing = provider.oauth.refreshToken({ access: "a", refresh: "r", expires: 1 });
    resolveResponse(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(refreshing).rejects.toMatchObject({ code: "invalid_grant" });
    while (!cleanup.mock.calls.length) await Promise.resolve();

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it("bounds shutdown when callback listener close never settles", async () => {
    const setup = deps(vi.fn(async () => tokenResponse()));
    setup.server.close = vi.fn(() => new Promise<void>(() => undefined));
    const provider = createAntigravityOAuthProvider({ ...setup.value, shutdownDrainTimeoutMs: 10 });
    let callbackStarted = false;
    setup.server.waitForCallback = (signal) =>
      new Promise<URL>((_resolve, reject) => {
        callbackStarted = true;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const connecting = provider.connect(vi.fn());
    while (!callbackStarted) await Promise.resolve();
    await expect(provider.shutdown()).resolves.toBeUndefined();
    await expect(connecting).rejects.toThrow();
  });

  it("closes a listener created after shutdown has already started", async () => {
    let finishCreation!: (server: AntigravityCallbackServer) => void;
    const server = mockCallbackServer(new Error("cancelled"));
    const setup = deps(vi.fn(async () => tokenResponse()));
    setup.value.createLoopbackCallbackServer = vi.fn(
      () =>
        new Promise((resolve) => {
          finishCreation = resolve;
        }),
    );
    const provider = createAntigravityOAuthProvider({ ...setup.value, shutdownDrainTimeoutMs: 10 });
    const connecting = provider.connect(vi.fn());
    while (!finishCreation) await Promise.resolve();
    await provider.shutdown();
    finishCreation(server);
    await expect(connecting).rejects.toThrow();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("does not start a connect flow if shutdown races a pending cancellation", async () => {
    let releaseClose!: () => void;
    const setup = deps(vi.fn(async () => tokenResponse()));
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    setup.server.close = close;
    let callbackStarted = false;
    setup.server.waitForCallback = (signal) =>
      new Promise<URL>((_resolve, reject) => {
        callbackStarted = true;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const provider = createAntigravityOAuthProvider(setup.value);
    const firstConnect = provider.connect(vi.fn());
    while (!callbackStarted) await Promise.resolve();
    const secondConnect = provider.connect(vi.fn());
    while (!close.mock.calls.length) await Promise.resolve();
    const shutdown = provider.shutdown();
    releaseClose();

    await expect(secondConnect).rejects.toMatchObject({ code: "cancelled" });
    await expect(firstConnect).rejects.toThrow();
    await shutdown;
    expect(setup.value.createLoopbackCallbackServer).toHaveBeenCalledOnce();
    expect(setup.value.openBrowser).not.toHaveBeenCalled();
  });
});
