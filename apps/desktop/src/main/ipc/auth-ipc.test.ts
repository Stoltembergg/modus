import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeBackend,
  createFakeSafeStorage,
  SECRET_ACCESS_TOKEN,
  SECRET_CODE,
  SECRET_REFRESH_TOKEN,
} from "../auth/auth.test-helpers";
import { createAuthService } from "../auth/auth-service";
import { createAuthSessionStore } from "../auth/auth-session-store";
import { startLoopbackListener } from "../auth/loopback-server";
import { createOAuthFlowRegistry } from "../auth/oauth-flow";
import { registerAuthIpcHandlers } from "./auth-ipc";
import {
  assertTrustedSender,
  registerTrustedSender,
  type TrustedSenderEvent,
} from "./trusted-sender";

const AUTH_CHANNELS = [
  "auth:get-state",
  "auth:sign-up",
  "auth:sign-in-password",
  "auth:sign-in-oauth",
  "auth:cancel-oauth",
  "auth:sign-out",
];

const SECRETS = [
  SECRET_ACCESS_TOKEN,
  SECRET_REFRESH_TOKEN,
  "refresh-token-SECRET-r2",
  SECRET_CODE,
  "metadata-SECRET",
  "correct horse",
];

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

describe("auth IPC", () => {
  let userDataPath: string;
  let unregister: (() => void) | undefined;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "modus-auth-ipc-"));
  });

  afterEach(async () => {
    unregister?.();
    await rm(userDataPath, { recursive: true, force: true });
  });

  function setup() {
    const fake = createFakeBackend();
    const broadcasts: unknown[] = [];
    const service = createAuthService({
      config: {
        supabaseUrl: "https://crdgtmyvwdnswuggpjco.supabase.co",
        anonKey: "sb_publishable_test",
        oauthProviders: ["github"],
      },
      backend: fake.backend,
      store: createAuthSessionStore({
        userDataPath,
        safeStorage: createFakeSafeStorage(),
        platform: "linux",
      }),
      flows: createOAuthFlowRegistry(),
      startLoopback: startLoopbackListener,
      openExternal: async () => {
        void fetch(`${fake.redirects.at(-1)}&code=${SECRET_CODE}`).catch(() => undefined);
      },
      oauthTimeoutMs: 2_000,
    });
    // Same structured-clone path the real broadcast uses.
    service.onStateChange((state) => broadcasts.push(structuredClone(state)));
    const handlers = new Map<string, Handler>();
    registerAuthIpcHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      assertTrustedSender,
      service,
    );
    const sender = { mainFrame: { url: "file:///index.html" } };
    unregister = registerTrustedSender(sender, "file:///index.html");
    const trusted = { sender, senderFrame: sender.mainFrame };
    const call = async (channel: string, input?: unknown) =>
      structuredClone(await handlers.get(channel)?.(trusted, input));
    return { service, fake, handlers, broadcasts, call };
  }

  it("registers every auth command", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...AUTH_CHANNELS].sort());
  });

  it("rejects untrusted senders before calling the service", () => {
    const { handlers, fake } = setup();
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of AUTH_CHANNELS) {
      expect(() => handlers.get(channel)?.(event, undefined)).toThrow(/untrusted/);
    }
    expect(fake.backend.signInWithPassword).not.toHaveBeenCalled();
  });

  it("validates inputs and never echoes the password in errors", async () => {
    const { call, fake } = setup();
    await expect(
      call("auth:sign-in-password", { email: "nope", password: "correct horse" }),
    ).rejects.toThrow(/Invalid IPC payload/);
    await expect(
      call("auth:sign-in-password", { email: "a@b.co", password: "short" }),
    ).rejects.toThrow();
    await expect(
      call("auth:sign-in-password", { email: "a@b.co", password: "correct horse", extra: 1 }),
    ).rejects.toThrow();
    await expect(call("auth:sign-in-oauth", { provider: "facebook" })).rejects.toThrow();
    await expect(call("auth:sign-out", { all: true })).rejects.toThrow();
    try {
      await call("auth:sign-in-password", { email: "nope", password: "correct horse" });
    } catch (error) {
      expect(String(error)).not.toContain("correct horse");
    }
    expect(fake.backend.signInWithPassword).not.toHaveBeenCalled();
  });

  it("never sends tokens or the OAuth code to the renderer", async () => {
    const { service, call, broadcasts, fake } = setup();
    await service.initialize();
    const replies = [
      await call("auth:get-state"),
      await call("auth:sign-in-password", { email: "Ana@Example.com ", password: "correct horse" }),
      await call("auth:sign-out"),
      await call("auth:sign-in-oauth", { provider: "github" }),
      await call("auth:get-state"),
      await call("auth:cancel-oauth"),
      await call("auth:sign-out"),
    ];
    expect(fake.backend.signInWithPassword).toHaveBeenCalledWith(
      "ana@example.com",
      "correct horse",
    );
    expect(fake.backend.exchangeCode).toHaveBeenCalledWith(SECRET_CODE);
    expect(replies[3]).toMatchObject({ status: "signed-in" });
    const payload = JSON.stringify({ replies, broadcasts });
    for (const secret of SECRETS) expect(payload).not.toContain(secret);
    expect(payload).not.toMatch(
      /"(code|accessToken|refreshToken|access_token|refresh_token|state)"/,
    );
    for (const reply of [...replies, ...broadcasts]) {
      expect(Object.keys(reply as object).sort()).toEqual(
        [
          "error",
          "notice",
          "oauthProviders",
          "pendingProvider",
          "persistence",
          "status",
          "user",
        ].sort(),
      );
    }
  });
});
