import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../shared/auth";
import { createDeepLinkRouter } from "../deep-link/deep-link";
import { createFakeBackend, createFakeSafeStorage, SECRET_CODE } from "./auth.test-helpers";
import type { AuthConfig } from "./auth-config";
import { createAuthService } from "./auth-service";
import { createAuthSessionStore } from "./auth-session-store";
import { startLoopbackListener } from "./loopback-server";
import { createDeepLinkCallbackHub } from "./oauth-callback";
import { createOAuthFlowRegistry } from "./oauth-flow";

const CONFIG: AuthConfig = {
  supabaseUrl: "https://crdgtmyvwdnswuggpjco.supabase.co",
  anonKey: "sb_publishable_test",
  oauthProviders: ["github", "google"],
  oauthTransport: "deep-link",
};

describe("OAuth over modus://auth/callback", () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "modus-auth-deep-link-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  function setup({
    timeoutMs = 2_000,
    now,
    browser,
  }: {
    timeoutMs?: number;
    now?: () => number;
    /** What the OS hands to the app after the browser redirect, given redirect_to. */
    browser?: (redirectTo: string) => string | undefined;
  } = {}) {
    const fake = createFakeBackend();
    const hub = createDeepLinkCallbackHub();
    const focus = vi.fn();
    const router = createDeepLinkRouter({
      onAuthCallback: (link) => hub.deliver(link),
      onBillingReturn: vi.fn(),
      focus,
    });
    router.markReady();
    const service = createAuthService({
      config: CONFIG,
      backend: fake.backend,
      store: createAuthSessionStore({ userDataPath, safeStorage: createFakeSafeStorage() }),
      flows: createOAuthFlowRegistry(now ? { now } : {}),
      startLoopback: startLoopbackListener,
      startDeepLinkCallback: (options) => hub.start(options),
      openExternal: vi.fn(async () => {
        const target = browser?.(fake.redirects.at(-1) ?? "");
        if (target) setTimeout(() => router.handle(target), 0);
      }),
      oauthTimeoutMs: timeoutMs,
    });
    const events: AuthState[] = [];
    service.onStateChange((state) => events.push(state));
    return { service, fake, hub, router, focus, events };
  }

  /** GoTrue's PKCE redirect: `?code=` added to redirect_to, fragment kept. */
  function gotrueRedirect(redirectTo: string, code = SECRET_CODE): string {
    const [base, fragment] = redirectTo.split("#");
    return `${base}?code=${code}#${fragment}`;
  }

  it("uses the exact allow-list URL with the state in the fragment and signs in", async () => {
    const { service, fake, focus, events } = setup({ browser: (r) => gotrueRedirect(r) });
    await service.initialize();
    const state = await service.signInWithOAuth("github");
    const redirectTo = fake.redirects[0] ?? "";
    const [base, fragment] = redirectTo.split("#");
    expect(base).toBe("modus://auth/callback");
    expect(new URLSearchParams(fragment).get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.backend.exchangeCode).toHaveBeenCalledWith(SECRET_CODE);
    expect(state.status).toBe("signed-in");
    expect(focus).toHaveBeenCalled();
    // The OAuth code never appears in anything sent to the renderer.
    expect(JSON.stringify(events)).not.toContain(SECRET_CODE);
  });

  it("ignores a state carried in the query (only the fragment counts)", async () => {
    const { service, fake } = setup({
      browser: (r) => {
        const state = new URLSearchParams(r.split("#")[1]).get("state") ?? "";
        return `modus://auth/callback?code=${SECRET_CODE}&state=${state}`;
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

  it("rejects a mismatched state and never exchanges the code", async () => {
    const { service, fake } = setup({
      browser: () => `modus://auth/callback?code=${SECRET_CODE}#state=forged`,
    });
    await service.initialize();
    expect((await service.signInWithOAuth("google")).status).toBe("signed-out");
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects an expired state", async () => {
    let clock = 1_000;
    const { service, fake } = setup({
      now: () => clock,
      browser: (r) => {
        clock += 10 * 60 * 1000;
        return gotrueRedirect(r);
      },
    });
    await service.initialize();
    expect((await service.signInWithOAuth("github")).status).toBe("signed-out");
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });

  it("drops a replayed callback and links that arrive with no sign-in pending", async () => {
    let first = "";
    const { service, fake, hub, router } = setup({
      browser: (r) => {
        first = gotrueRedirect(r);
        return first;
      },
    });
    await service.initialize();
    expect((await service.signInWithOAuth("github")).status).toBe("signed-in");
    const deliver = vi.spyOn(hub, "deliver");
    expect(router.handle(first)).toBe(true);
    expect(deliver).toHaveReturnedWith(false);
    expect(fake.backend.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("times out when the deep link never comes back", async () => {
    const { service, fake } = setup({ timeoutMs: 30 });
    await service.initialize();
    const state = await service.signInWithOAuth("github");
    expect(state).toMatchObject({
      status: "signed-out",
      error: expect.stringMatching(/timed out/),
    });
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });

  it("cancelling the sign-in drops a later deep link", async () => {
    const { service, fake, router } = setup();
    await service.initialize();
    const started = service.signInWithOAuth("github");
    await vi.waitFor(() => expect(fake.redirects).toHaveLength(1));
    service.cancelOAuth();
    expect((await started).status).toBe("signed-out");
    router.handle(gotrueRedirect(fake.redirects[0] ?? ""));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.backend.exchangeCode).not.toHaveBeenCalled();
  });
});
