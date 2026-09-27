import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  ANTIGRAVITY_REDIRECT_URI,
  createAntigravityOAuthProvider,
  shutdownAntigravityAuth,
  type AntigravityCallbackServer,
} from "./antigravity-oauth";

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, ...overrides }), { status: 200 });

function mockCallbackServer(callback: URL | Error): AntigravityCallbackServer {
  return {
    waitForCallback: vi.fn(async () => {
      if (callback instanceof Error) throw callback;
      return callback;
    }),
    close: vi.fn(async () => undefined),
  };
}

function deps(fetch: typeof globalThis.fetch, callback = new URL("http://localhost:51121/oauth-callback?code=auth-code&state=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc")) {
  const server = mockCallbackServer(callback);
  return {
    server,
    value: {
      clientId: "test-client",
      clientSecret: "test-client-secret",
      fetch,
      now: () => 1_700_000_000_000,
      createLoopbackCallbackServer: vi.fn(async () => server),
      openBrowser: vi.fn(async () => undefined),
      createRandom: () => new Uint8Array(32).fill(7),
      timeoutMs: 5_000,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Antigravity OAuth provider", () => {
  it("uses the fixed loopback redirect and validates OAuth state before exchanging tokens", async () => {
    const responses = [tokenResponse(), new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 })];
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
    const setup = deps(fetch, new URL("http://localhost:51121/oauth-callback?code=auth-code&state=wrong"));
    const provider = createAntigravityOAuthProvider(setup.value);

    await expect(provider.connect()).rejects.toThrow(/state/i);
    expect(fetch).not.toHaveBeenCalled();
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
    setup.server.waitForCallback = vi.fn((_signal: AbortSignal) => new Promise<URL>((_resolve, reject) => {
      if (_signal.aborted) reject(new Error("aborted"));
      else _signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const provider = createAntigravityOAuthProvider(setup.value);
    const connecting = provider.connect();
    while (!setup.server.waitForCallback.mock.calls.length) await Promise.resolve();
    await shutdownAntigravityAuth();

    await expect(connecting).rejects.toThrow();
    expect(setup.server.close).toHaveBeenCalledOnce();
    expect(provider.getStatus()).toEqual({ status: "disconnected" });
  });

  it("distinguishes permanent invalid_grant refresh failure from transient failure", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 }));
    const provider = createAntigravityOAuthProvider(deps(fetch).value);
    await provider.connect();

    await expect(provider.refresh()).rejects.toMatchObject({ code: "invalid_grant", permanent: true });
    await expect(provider.refresh()).rejects.toMatchObject({ permanent: false });
  });

  it("exposes missing project discovery without selecting a substitute project", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: null }), { status: 200 }));
    const provider = createAntigravityOAuthProvider(deps(fetch).value);

    await expect(provider.connect()).resolves.toMatchObject({ status: "missing-project", projectId: null });
    expect(provider.getMissingProjectModelIds()).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not apply a refresh response after disconnect changes credential generation", async () => {
    let resolveRefresh!: (response: Response) => void;
    const fetch = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
    const provider = createAntigravityOAuthProvider(deps(fetch).value);
    await provider.connect();
    const refreshing = provider.refresh();
    await provider.disconnect();
    resolveRefresh(tokenResponse({ access_token: "stale-access" }));

    await expect(refreshing).rejects.toThrow(/disconnect|credential/i);
    expect(provider.getStatus()).toMatchObject({ status: "disconnected" });
  });
});
