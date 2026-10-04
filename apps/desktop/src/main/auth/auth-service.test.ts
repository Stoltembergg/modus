import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../shared/auth";
import {
  createFakeBackend,
  createFakeSafeStorage,
  SECRET_CODE,
  SECRET_REFRESH_TOKEN,
} from "./auth.test-helpers";
import type { AuthConfig } from "./auth-config";
import { createAuthService } from "./auth-service";
import { createAuthSessionStore } from "./auth-session-store";
import { startLoopbackListener } from "./loopback-server";
import { createOAuthFlowRegistry } from "./oauth-flow";
import { createSupabaseAuthBackend } from "./supabase-auth-backend";

const CONFIG: AuthConfig = {
  supabaseUrl: "https://crdgtmyvwdnswuggpjco.supabase.co",
  anonKey: "sb_publishable_test",
  oauthProviders: ["github", "google"],
};

const CREDENTIALS = { email: "ana@example.com", password: "correct horse" };

describe("auth service", () => {
  let userDataPath: string;
  const tokenFile = () => join(userDataPath, "auth", "supabase-refresh-token.enc");

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "modus-auth-service-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  function setup({
    backendKind = "gnome_libsecret",
    callback,
  }: {
    backendKind?: string;
    /** What the "browser" sends to the loopback redirect, given the redirect URL. */
    callback?: (redirectTo: string) => string | undefined;
  } = {}) {
    const fake = createFakeBackend();
    const safeStorage = createFakeSafeStorage({ backend: backendKind });
    const store = createAuthSessionStore({ userDataPath, safeStorage, platform: "linux" });
    const openExternal = vi.fn(async (_url: string) => {
      const redirectTo = fake.redirects.at(-1) ?? "";
      const target = callback?.(redirectTo);
      if (target) void fetch(target).catch(() => undefined);
    });
    const service = createAuthService({
      config: CONFIG,
      backend: fake.backend,
      store,
      flows: createOAuthFlowRegistry(),
      startLoopback: startLoopbackListener,
      openExternal,
      oauthTimeoutMs: 2_000,
    });
    const events: AuthState[] = [];
    service.onStateChange((state) => events.push(state));
    return { service, fake, store, safeStorage, openExternal, events };
  }

  it("reports unconfigured without Supabase settings", async () => {
    const service = createAuthService({
      config: undefined,
      backend: undefined,
      store: createAuthSessionStore({ userDataPath, safeStorage: createFakeSafeStorage() }),
      flows: createOAuthFlowRegistry(),
      startLoopback: startLoopbackListener,
      openExternal: vi.fn(),
    });
    expect((await service.initialize()).status).toBe("unconfigured");
    expect((await service.signInWithPassword(CREDENTIALS)).error).toMatch(/Something went wrong/);
  });

  it("signs in with a password, persists the encrypted refresh token and loads the profile", async () => {
    const { service, fake } = setup();
    await service.initialize();
    const state = await service.signInWithPassword(CREDENTIALS);
    expect(fake.backend.signInWithPassword).toHaveBeenCalledWith(
      CREDENTIALS.email,
      CREDENTIALS.password,
    );
    expect(state).toMatchObject({
      status: "signed-in",
      persistence: "encrypted",
      user: { email: "ana@example.com", displayName: "Ana Profile", provider: "email" },
    });
    const bytes = await readFile(tokenFile());
    expect(bytes.includes(Buffer.from(SECRET_REFRESH_TOKEN))).toBe(false);
  });

  it("keeps the session in memory only when safeStorage uses basic_text", async () => {
    const { service, safeStorage } = setup({ backendKind: "basic_text" });
    await service.initialize();
    const state = await service.signInWithPassword(CREDENTIALS);
    expect(state).toMatchObject({ status: "signed-in", persistence: "memory-only" });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    await expect(readFile(tokenFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a stored session at startup and rotates the stored token", async () => {
    const first = setup();
    await first.service.initialize();
    await first.service.signInWithPassword(CREDENTIALS);
    const second = setup();
    const state = await second.service.initialize();
    expect(second.fake.backend.restore).toHaveBeenCalledWith(SECRET_REFRESH_TOKEN);
    expect(state.status).toBe("signed-in");
    await expect(second.store.load()).resolves.toBe("refresh-token-SECRET-r2");
  });

  it("drops a stored token the server rejects", async () => {
    const first = setup();
    await first.service.initialize();
    await first.service.signInWithPassword(CREDENTIALS);
    const second = setup();
    const { AuthBackendError } = await import("./auth-backend");
    second.fake.backend.restore.mockRejectedValueOnce(new AuthBackendError("rejected", "invalid"));
    expect((await second.service.initialize()).status).toBe("signed-out");
    await expect(readFile(tokenFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sign-out clears the stored session even if the server call fails", async () => {
    const { service, fake } = setup();
    await service.initialize();
    await service.signInWithPassword(CREDENTIALS);
    await expect(readFile(tokenFile())).resolves.toBeInstanceOf(Buffer);
    fake.backend.signOut.mockRejectedValueOnce(new Error("offline"));
    const state = await service.signOut();
    expect(state).toMatchObject({ status: "signed-out", user: null });
    await expect(readFile(tokenFile())).rejects.toMatchObject({ code: "ENOENT" });
    expect(fake.backend.signOut).toHaveBeenCalledTimes(1);
  });

  it("asks for email confirmation after sign-up without a session", async () => {
    const { service } = setup();
    await service.initialize();
    const state = await service.signUp(CREDENTIALS);
    expect(state).toMatchObject({ status: "signed-out", notice: "confirm-email" });
    await expect(readFile(tokenFile())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes OAuth through the 127.0.0.1 loopback with the matching state", async () => {
    const { service, fake, openExternal } = setup({
      callback: (redirectTo) => `${redirectTo}&code=${SECRET_CODE}`,
    });
    await service.initialize();
    const state = await service.signInWithOAuth("github");
    const redirectTo = new URL(fake.redirects[0] ?? "");
    expect(redirectTo.protocol).toBe("http:");
    expect(redirectTo.hostname).toBe("127.0.0.1");
    expect(redirectTo.pathname).toBe("/auth/callback");
    expect(redirectTo.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(openExternal).toHaveBeenCalledWith(
      "https://crdgtmyvwdnswuggpjco.supabase.co/auth/v1/authorize?provider=github",
    );
    expect(fake.backend.exchangeCode).toHaveBeenCalledWith(SECRET_CODE);
    expect(state).toMatchObject({ status: "signed-in", pendingProvider: null });
    // The listener is gone after the first callback.
    await expect(fetch(redirectTo.href)).rejects.toThrow();
  });

  it("rejects an OAuth callback whose state does not match and never exchanges its code", async () => {
    const { service, fake } = setup({
      callback: (redirectTo) => {
        const url = new URL(redirectTo);
        url.searchParams.set("state", "forged-state");
        url.searchParams.set("code", SECRET_CODE);
        return url.href;
      },
    });
    await service.initialize();
    const state = await service.signInWithOAuth("github");
    expect(state).toMatchObject({
      status: "signed-out",
      error: expect.stringMatching(/not accepted/),
    });
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects a callback that arrives after the sign-in was cancelled", async () => {
    const { service, fake } = setup();
    await service.initialize();
    const started = service.signInWithOAuth("github");
    await vi.waitFor(() => expect(fake.redirects).toHaveLength(1));
    service.cancelOAuth();
    const redirectTo = fake.redirects[0] ?? "";
    await expect(fetch(`${redirectTo}&code=${SECRET_CODE}`)).rejects.toThrow();
    expect((await started).status).toBe("signed-out");
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });

  it("times out an OAuth sign-in that never returns", async () => {
    const fake = createFakeBackend();
    const service = createAuthService({
      config: CONFIG,
      backend: fake.backend,
      store: createAuthSessionStore({ userDataPath, safeStorage: createFakeSafeStorage() }),
      flows: createOAuthFlowRegistry(),
      startLoopback: startLoopbackListener,
      openExternal: vi.fn(async () => undefined),
      oauthTimeoutMs: 30,
    });
    await service.initialize();
    const state = await service.signInWithOAuth("google");
    expect(state).toMatchObject({
      status: "signed-out",
      error: expect.stringMatching(/timed out/),
    });
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses OAuth providers that this build has not enabled", async () => {
    const fake = createFakeBackend();
    const service = createAuthService({
      config: { ...CONFIG, oauthProviders: [] },
      backend: fake.backend,
      store: createAuthSessionStore({ userDataPath, safeStorage: createFakeSafeStorage() }),
      flows: createOAuthFlowRegistry(),
      startLoopback: startLoopbackListener,
      openExternal: vi.fn(),
    });
    await service.initialize();
    expect((await service.signInWithOAuth("github")).status).toBe("signed-out");
    expect(fake.backend.createOAuthUrl).not.toHaveBeenCalled();
  });

  it("signs out locally when Supabase reports the session ended", async () => {
    const { service, fake } = setup();
    await service.initialize();
    await service.signInWithPassword(CREDENTIALS);
    fake.emitSession(null);
    await vi.waitFor(() => expect(service.getState().status).toBe("signed-out"));
    await expect(readFile(tokenFile())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// Against the real Supabase project (public URL; no key or secret involved). A full round trip
// needs a person to log in at GitHub, so this checks the part the app depends on: the PKCE
// authorize URL built by supabase-js is accepted and Supabase redirects to GitHub's OAuth app.
const REAL_PROJECT_URL = "https://crdgtmyvwdnswuggpjco.supabase.co";

const OAUTH_EXPECTATIONS = [
  { provider: "github", authorize: "https://github.com/login/oauth/authorize" },
  { provider: "google", authorize: "https://accounts.google.com/o/oauth2/v2/auth" },
] as const;

describe("OAuth providers against the real project", () => {
  it.each(
    OAUTH_EXPECTATIONS,
  )("$provider is enabled: the authorize URL redirects to the provider", async ({
    provider,
    authorize,
  }) => {
    const backend = createSupabaseAuthBackend({
      supabaseUrl: REAL_PROJECT_URL,
      anonKey: "sb_publishable_test_unused",
      oauthProviders: [provider],
    });
    try {
      const authorizeUrl = await backend.createOAuthUrl(
        provider,
        "http://127.0.0.1:49152/auth/callback?state=test",
      );
      expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("s256");
      const response = await fetch(authorizeUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe(authorize);
      expect(location.searchParams.get("client_id")).toBeTruthy();
      expect(location.searchParams.get("redirect_uri")).toBe(
        `${REAL_PROJECT_URL}/auth/v1/callback`,
      );
    } finally {
      backend.dispose();
    }
  }, 15_000);
});
