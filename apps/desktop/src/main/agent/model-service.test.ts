import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;
let getDatabase: typeof import("../db/database").getDatabase;
let configureProvider: typeof import("./model-service").configureProvider;
let disconnectProvider: typeof import("./model-service").disconnectProvider;
let findModel: typeof import("./model-service").findModel;
let getCustomProviderConfig: typeof import("./model-service").getCustomProviderConfig;
let getModelRegistry: typeof import("./model-service").getModelRegistry;
let getModelSettings: typeof import("./model-service").getModelSettings;
let getProviderDetail: typeof import("./model-service").getProviderDetail;
let getProviderAuthState: typeof import("./model-service").getProviderAuthState;
let listProviderConnectionMethods: typeof import("./model-service").listProviderConnectionMethods;
let listModels: typeof import("./model-service").listModels;
let resolveModelThinking: typeof import("./model-service").resolveModelThinking;
let startRemoteModelCatalog: typeof import("./model-service").startRemoteModelCatalog;
let stopRemoteModelCatalog: typeof import("./model-service").stopRemoteModelCatalog;
let updateModelConfig: typeof import("./model-service").updateModelConfig;
let upsertCustomProvider: typeof import("./model-service").upsertCustomProvider;
let removeRejectedAntigravityCredential: typeof import("./model-service").removeRejectedAntigravityCredential;
let startProviderAuth: typeof import("./model-service").startProviderAuth;
let shutdownProviderAuthOperations: typeof import("./model-service").shutdownProviderAuthOperations;
let cancelProviderAuth: typeof import("./model-service").cancelProviderAuth;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-model-service-test-"));
  ({ getDatabase } = await import("../db/database"));
  ({
    configureProvider,
    disconnectProvider,
    findModel,
    getCustomProviderConfig,
    getModelRegistry,
    getModelSettings,
    getProviderDetail,
    getProviderAuthState,
    listProviderConnectionMethods,
    listModels,
    resolveModelThinking,
    startRemoteModelCatalog,
    stopRemoteModelCatalog,
    updateModelConfig,
    upsertCustomProvider,
    removeRejectedAntigravityCredential,
    startProviderAuth,
    shutdownProviderAuthOperations,
    cancelProviderAuth,
  } = await import("./model-service"));
}, 60_000);

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("model-service custom provider config", () => {
  it("rejects Antigravity sign-in without risk acknowledgement before starting OAuth", () => {
    const registry = getModelRegistry();
    const oauth = registry.authStorage.getOAuthProviders().find(({ id }) => id === "antigravity")!;
    const login = vi.spyOn(oauth, "login");
    const openExternal = vi.fn(async () => undefined);

    expect(() => startProviderAuth("antigravity", openExternal)).toThrow(/acknowledg/i);
    expect(login).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    login.mockRestore();
  });

  it("starts Antigravity OAuth after acknowledgement", () => {
    getModelRegistry();
    const openExternal = vi.fn(async () => undefined);

    const state = startProviderAuth("antigravity", openExternal, { riskAcknowledged: true });

    expect(state).toMatchObject({ provider: "antigravity", status: "pending" });
    expect(state).not.toHaveProperty("access");
    expect(state).not.toHaveProperty("refresh");
    expect(state).not.toHaveProperty("credential");
    expect(JSON.stringify(state)).not.toMatch(
      /access[_ -]?token|refresh[_ -]?token|authorization code/i,
    );
    cancelProviderAuth(state.id);
  });

  it("does not persist an Antigravity login that finishes after disconnect", async () => {
    const registry = getModelRegistry();
    let resolveLogin!: (credentials: { access: string; refresh: string; expires: number }) => void;
    const register = registry.registerProvider.bind(registry);
    vi.spyOn(registry, "registerProvider").mockImplementation((provider, config) => {
      if (provider === "antigravity" && config.oauth) {
        vi.spyOn(config.oauth, "login").mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveLogin = resolve;
            }),
        );
      }
      return register(provider, config);
    });
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: 1,
    });
    const operation = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });
    while (!resolveLogin) await Promise.resolve();
    await disconnectProvider("antigravity");
    resolveLogin({ access: "stale", refresh: "stale-refresh", expires: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registry.authStorage.get("antigravity")).toBeUndefined();
    expect(getProviderDetail("antigravity")?.configured).toBe(false);
    expect(operation.status).toBe("pending");
  });

  it("does not let a stale Antigravity login overwrite or erase a newer login", async () => {
    const registry = getModelRegistry();
    let resolveOld!: (credentials: { access: string; refresh: string; expires: number }) => void;
    let callCount = 0;
    const register = registry.registerProvider.bind(registry);
    vi.spyOn(registry, "registerProvider").mockImplementation((provider, config) => {
      if (provider === "antigravity" && config.oauth) {
        vi.spyOn(config.oauth, "login").mockImplementation(() =>
          ++callCount === 1
            ? new Promise((resolve) => {
                resolveOld = resolve;
              })
            : Promise.resolve({ access: "new", refresh: "new-refresh", expires: 3 }),
        );
      }
      return register(provider, config);
    });
    const first = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });
    while (!resolveOld) await Promise.resolve();
    cancelProviderAuth(first.id);
    const second = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });
    await vi.waitFor(() => expect(getProviderAuthState(second.id).status).toBe("complete"));
    resolveOld({ access: "old", refresh: "old-refresh", expires: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registry.authStorage.get("antigravity")).toMatchObject({
      type: "oauth",
      access: "new",
      refresh: "new-refresh",
    });
    expect(getProviderDetail("antigravity")?.configured).toBe(true);
  });

  it("shutdown aborts every pending provider auth operation", async () => {
    const registry = getModelRegistry();
    let signal: AbortSignal | undefined;
    let promptCompletion: Promise<unknown> | undefined;
    const register = registry.registerProvider.bind(registry);
    vi.spyOn(registry, "registerProvider").mockImplementation((provider, config) => {
      if (provider === "antigravity" && config.oauth) {
        vi.spyOn(config.oauth, "login").mockImplementation((callbacks) => {
          signal = callbacks.signal;
          promptCompletion = callbacks.onPrompt({
            message: "Consent",
            placeholder: "",
            allowEmpty: true,
          });
          return promptCompletion.then(() => ({
            access: "test-access",
            refresh: "test-refresh",
            expires: Number.MAX_SAFE_INTEGER,
          }));
        });
      }
      return register(provider, config);
    });
    const state = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });

    await shutdownProviderAuthOperations();

    expect(signal?.aborted).toBe(true);
    await expect(promptCompletion).rejects.toThrow("Sign-in cancelled.");
    expect(() => cancelProviderAuth(state.id)).toThrow("no longer active");
  });

  it("registers Antigravity OAuth hooks with the persistent Pi model registry", () => {
    const registry = getModelRegistry();
    const provider = registry.authStorage
      .getOAuthProviders()
      .find(({ id }) => id === "antigravity");

    expect(provider).toBeDefined();
    expect(provider?.usesCallbackServer).toBe(true);
    expect(provider?.refreshToken).toEqual(expect.any(Function));
    expect(provider?.getApiKey).toEqual(expect.any(Function));
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "persisted-access",
      refresh: "persisted-refresh",
      expires: 1_700_000_000_000,
      projectId: "persisted-project",
    });
    registry.authStorage.reload();
    expect(registry.authStorage.get("antigravity")).toMatchObject({
      type: "oauth",
      access: "persisted-access",
      refresh: "persisted-refresh",
      projectId: "persisted-project",
    });
  });

  it("removes a rejected credential under the shared async file lock and preserves other providers", async () => {
    const registry = getModelRegistry();
    const rejected = {
      type: "oauth" as const,
      access: "rejected-access",
      refresh: "rejected-refresh",
      expires: 10,
      projectId: "old-project",
    };
    registry.authStorage.set("antigravity", rejected);
    registry.authStorage.set("other-provider", { type: "api_key", key: "other-key" });

    await removeRejectedAntigravityCredential(rejected, registry.authStorage);

    expect(registry.authStorage.get("antigravity")).toBeUndefined();
    expect(registry.authStorage.get("other-provider")).toEqual({
      type: "api_key",
      key: "other-key",
    });
    const persisted = JSON.parse(await readFile(join(userData, "pi-agent", "auth.json"), "utf8"));
    expect(persisted).toEqual({ "other-provider": { type: "api_key", key: "other-key" } });
  });

  it("preserves a replacement credential when rejected cleanup finds a mismatch", async () => {
    const registry = getModelRegistry();
    const rejected = { access: "stale", refresh: "stale-refresh", expires: 10, projectId: "old" };
    const replacement = {
      type: "oauth" as const,
      access: "new",
      refresh: "new-refresh",
      expires: 20,
      projectId: "new",
    };
    registry.authStorage.set("antigravity", replacement);

    await removeRejectedAntigravityCredential(rejected, registry.authStorage);

    expect(registry.authStorage.get("antigravity")).toEqual(replacement);
  });

  it("refreshes the model registry once when assembling first-screen settings", () => {
    const refresh = vi.spyOn(getModelRegistry(), "refresh");

    getModelSettings();

    expect(refresh).toHaveBeenCalledOnce();
    refresh.mockRestore();
  });

  it("writes PI custom provider metadata without leaking the stored API key", async () => {
    const provider = `relay-${crypto.randomUUID().slice(0, 8)}`;

    const detail = await upsertCustomProvider({
      provider,
      name: "Relay Test",
      baseUrl: "https://relay.example.test/v1",
      apiKey: "sk-test-secret",
      api: "openai-completions",
      authHeader: true,
      headers: { "X-Relay-App": "modus" },
      compatibility: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [
        {
          id: "qwen3-coder",
          name: "Qwen3 Coder",
          api: "openai-completions",
          baseUrl: "https://model.example.test/v1",
          headers: { "X-Model-Route": "premium" },
          contextWindow: 262_144,
          maxTokens: 65_536,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
          compatibility: { thinkingFormat: "qwen-chat-template", supportsUsageInStreaming: true },
          thinkingLevelMap: { minimal: null, high: "high", xhigh: "max" },
        },
      ],
    });

    expect(detail.configured).toBe(true);
    expect(detail.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qwen3-coder",
          enabled: true,
          contextWindow: 262_144,
          maxTokens: 65_536,
          reasoning: true,
          thinkingOptions: expect.arrayContaining([
            expect.objectContaining({ value: "high", level: "high" }),
            expect.objectContaining({ value: "max", level: "xhigh" }),
          ]),
        }),
      ]),
    );
    expect(
      listModels()
        .find((model) => model.id === `${provider}/qwen3-coder`)
        ?.thinkingOptions?.map((option) => option.value),
    ).toContain("max");

    const modelsJson = await readFile(join(userData, "pi-agent", "models.json"), "utf-8");
    const parsedModelsJson = JSON.parse(modelsJson);
    expect(modelsJson).not.toContain("sk-test-secret");
    expect(parsedModelsJson).toMatchObject({
      providers: {
        [provider]: {
          name: "Relay Test",
          baseUrl: "https://relay.example.test/v1",
          api: "openai-completions",
          apiKey: `$MODUS_RELAY_${provider.split("-")[1]?.toUpperCase()}_API_KEY`,
          authHeader: true,
          headers: { "X-Relay-App": "modus" },
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
          models: [
            {
              id: "qwen3-coder",
              name: "Qwen3 Coder",
              api: "openai-completions",
              baseUrl: "https://model.example.test/v1",
              headers: { "X-Model-Route": "premium" },
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 262_144,
              maxTokens: 65_536,
              cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
              compat: { thinkingFormat: "qwen-chat-template", supportsUsageInStreaming: true },
              thinkingLevelMap: { minimal: null, high: "high", xhigh: "max" },
            },
          ],
        },
      },
    });
    expect(parsedModelsJson.providers[provider].headers).toMatchObject({
      "User-Agent": "Modus/0.1.0",
      "X-Relay-App": "modus",
      "X-Stainless-Lang": "",
      "X-Stainless-Package-Version": "",
    });
  });

  it("preserves custom provider connection fields when editing a model", async () => {
    const provider = `relay-${crypto.randomUUID().slice(0, 8)}`;
    await upsertCustomProvider({
      provider,
      name: "Relay Stable",
      baseUrl: "https://relay-stable.example.test/v1",
      apiKey: "sk-stable-secret",
      api: "openai-completions",
      authHeader: true,
      headers: { "X-Relay-App": "modus" },
      models: [
        {
          id: "stable-model",
          name: "Stable Model",
          contextWindow: 128_000,
          maxTokens: 16_384,
          reasoning: true,
          thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
        },
      ],
    });

    updateModelConfig({ model: `${provider}/stable-model`, thinkingLevel: "high" });

    const row = getDatabase()
      .prepare(
        `select display_name, source, base_url, api, auth_header, headers_json
         from model_provider_configs
         where provider_id = ?`,
      )
      .get(provider) as {
      display_name: string;
      source: string;
      base_url: string;
      api: string;
      auth_header: number;
      headers_json: string;
    };

    expect(row).toEqual({
      display_name: "Relay Stable",
      source: "custom",
      base_url: "https://relay-stable.example.test/v1",
      api: "openai-completions",
      auth_header: 1,
      headers_json: JSON.stringify({ "X-Relay-App": "modus" }),
    });
  });

  it("persists anthropic thinking compat switches and round-trips them for editing", async () => {
    const provider = `relay-${crypto.randomUUID().slice(0, 8)}`;

    const detail = await upsertCustomProvider({
      provider,
      name: "Claude Relay",
      baseUrl: "https://claude-relay.example.test",
      apiKey: "sk-claude-secret",
      api: "anthropic-messages",
      authHeader: false,
      models: [
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
          reasoning: true,
          compatibility: {
            thinkingFormat: "none",
            supportsUsageInStreaming: false,
            forceAdaptiveThinking: true,
            allowEmptySignature: true,
          },
          thinkingLevelMap: {
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        },
      ],
    });

    const modelsJson = JSON.parse(
      await readFile(join(userData, "pi-agent", "models.json"), "utf-8"),
    );
    const stored = modelsJson.providers[provider].models[0];
    expect(stored.compat).toEqual({
      supportsUsageInStreaming: false,
      forceAdaptiveThinking: true,
      allowEmptySignature: true,
    });
    expect(stored.compat).not.toHaveProperty("thinkingFormat");
    expect(stored.thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(detail.models[0]?.thinkingOptions?.map((option) => option.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const roundTrip = getCustomProviderConfig(provider);
    expect(roundTrip?.api).toBe("anthropic-messages");
    expect(roundTrip?.models[0]?.compat).toMatchObject({
      forceAdaptiveThinking: true,
      allowEmptySignature: true,
    });
    expect(roundTrip?.models[0]?.thinkingLevelMap).toMatchObject({
      xhigh: "xhigh",
      max: "max",
    });
    const modelId = `${provider}/claude-opus-4-7`;
    const updated = updateModelConfig({ model: modelId, thinkingVariant: "max" });
    expect(updated.thinkingVariant).toBe("max");
    expect(updated.thinkingLevel).toBe("max");

    const model = findModel(modelId);
    if (!model) {
      throw new Error(`expected model ${modelId}`);
    }
    const resolved = resolveModelThinking(model, "max");
    expect(resolved.variant).toBe("max");
    expect(resolved.thinkingLevel).toBe("max");
    expect(resolved.model.thinkingLevelMap?.max).toBe("max");
  });

  it("accepts the string-thinking format for OpenAI-compatible relays", async () => {
    const provider = `relay-${crypto.randomUUID().slice(0, 8)}`;

    await upsertCustomProvider({
      provider,
      name: "String Thinking Relay",
      baseUrl: "https://string-relay.example.test/v1",
      apiKey: "sk-string-secret",
      api: "openai-completions",
      models: [
        {
          id: "kimi-k3",
          reasoning: true,
          compatibility: { thinkingFormat: "string-thinking", supportsUsageInStreaming: true },
        },
      ],
    });

    const modelsJson = JSON.parse(
      await readFile(join(userData, "pi-agent", "models.json"), "utf-8"),
    );
    expect(modelsJson.providers[provider].models[0].compat).toEqual({
      thinkingFormat: "string-thinking",
      supportsUsageInStreaming: true,
    });
  });

  it("migrates runtime defaults for custom OpenAI-compatible models", async () => {
    const provider = `relay-${crypto.randomUUID().slice(0, 8)}`;

    await upsertCustomProvider({
      provider,
      name: "Relay Reasoning",
      baseUrl: "https://relay-reasoning.example.test/v1",
      apiKey: "sk-reasoning-secret",
      api: "openai-completions",
      models: [
        {
          id: "gpt-5.5",
          name: "GPT 5.5",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: "minimal",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
          },
        },
      ],
    });

    const modelsJson = await readFile(join(userData, "pi-agent", "models.json"), "utf-8");
    const parsedModelsJson = JSON.parse(modelsJson);
    expect(parsedModelsJson).toMatchObject({
      providers: {
        [provider]: {
          headers: {
            "User-Agent": "Modus/0.1.0",
            "X-Stainless-Lang": "",
          },
          models: [
            {
              id: "gpt-5.5",
              thinkingLevelMap: {
                minimal: null,
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: "xhigh",
              },
            },
          ],
        },
      },
    });
    expect(parsedModelsJson.providers[provider].models[0].thinkingLevelMap).not.toHaveProperty(
      "off",
    );
  });
});

describe("model-service built-in provider base URL override", () => {
  async function readProviders(): Promise<Record<string, Record<string, unknown>>> {
    const json = await readFile(join(userData, "pi-agent", "models.json"), "utf-8");
    return (JSON.parse(json).providers ?? {}) as Record<string, Record<string, unknown>>;
  }

  it("relays a built-in provider through a custom base URL without dropping its models", async () => {
    const detail = await configureProvider({
      provider: "anthropic",
      apiKey: "sk-builtin-secret",
      baseUrl: "https://relay.example.test/anthropic",
    });

    // Built-in models are preserved — this is an override, not a replacement.
    expect(detail.source).toBe("builtin");
    expect(detail.baseUrl).toBe("https://relay.example.test/anthropic");
    expect(detail.modelCount).toBeGreaterThan(0);

    const providers = await readProviders();
    const entry = providers.anthropic;
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("expected an anthropic override entry");
    }
    expect(entry).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://relay.example.test/anthropic",
    });
    // Override-only: no custom model list is written for a built-in relay.
    expect(entry).not.toHaveProperty("models");
    // Fingerprint headers are blanked so the relay gets a clean request.
    expect(entry.headers).toMatchObject({
      "User-Agent": "Modus/0.1.0",
      "X-Stainless-Lang": "",
    });

    // The key lives in auth.json (AuthStorage), never the models.json.
    const modelsJson = await readFile(join(userData, "pi-agent", "models.json"), "utf-8");
    expect(modelsJson).not.toContain("sk-builtin-secret");
  });

  it("reverts to the official endpoint when the base URL is cleared", async () => {
    await configureProvider({
      provider: "google",
      apiKey: "sk-google",
      baseUrl: "https://relay.example.test/google",
    });
    expect((await readProviders()).google).toBeDefined();

    const detail = await configureProvider({ provider: "google", baseUrl: "" });

    expect(detail.baseUrl).toBeUndefined();
    expect(detail.modelCount).toBeGreaterThan(0);
    expect((await readProviders()).google).toBeUndefined();
  });

  it("leaves an existing override untouched when the base URL is omitted", async () => {
    await configureProvider({
      provider: "openai",
      apiKey: "sk-openai",
      baseUrl: "https://relay.example.test/openai",
    });

    // A later call that only refreshes the key (no baseUrl field) must not wipe
    // the relay — `undefined` means "leave untouched".
    const detail = await configureProvider({ provider: "openai", apiKey: "sk-openai-2" });

    expect(detail.baseUrl).toBe("https://relay.example.test/openai");
    expect((await readProviders()).openai).toMatchObject({
      baseUrl: "https://relay.example.test/openai",
    });
  });

  it("rejects a base URL that is not an http(s) endpoint", async () => {
    await expect(
      configureProvider({ provider: "anthropic", baseUrl: "ftp://nope.example.test" }),
    ).rejects.toThrow(/base URL/i);
  });
});

describe("provider disconnection", () => {
  it("clears the disconnect guard if login invalidation throws", async () => {
    const registry = getModelRegistry();
    const oauth = registry.authStorage.getOAuthProviders().find(({ id }) => id === "antigravity")!;
    vi.spyOn(oauth, "login").mockImplementation(() => new Promise(() => undefined));
    const NativeAbortController = globalThis.AbortController;
    let shouldThrow = true;
    class FailingAbortController extends NativeAbortController {
      override abort(): void {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("abort failed");
        }
        super.abort();
      }
    }
    vi.stubGlobal("AbortController", FailingAbortController);
    const state = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });

    await expect(disconnectProvider("antigravity")).rejects.toThrow("abort failed");
    vi.unstubAllGlobals();
    const recovered = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });
    expect(recovered.status).toBe("pending");
    cancelProviderAuth(state.id);
    cancelProviderAuth(recovered.id);
  });

  it("waits for Pi's OAuth refresh lock before removing Antigravity credentials", async () => {
    const registry = getModelRegistry();
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "expired-access",
      refresh: "refresh-for-lock",
      expires: 1,
      projectId: "project-lock",
    });
    registry.authStorage.set("unrelated", { type: "api_key", key: "preserve-me" });
    let releaseRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          await new Promise<Response>((resolve) => {
            releaseRefresh = resolve;
          }),
      ),
    );
    const oauth = registry.authStorage.getOAuthProviders().find(({ id }) => id === "antigravity")!;
    vi.spyOn(oauth, "refreshToken").mockImplementation(async () => {
      refreshStarted();
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST" });
      const payload = (await response.json()) as { access_token: string; expires_in: number };
      return {
        access: payload.access_token,
        refresh: "refresh-for-lock",
        expires: Date.now() + payload.expires_in * 1000,
        projectId: "project-lock",
      };
    });
    const refresh = registry.authStorage.getApiKey("antigravity");
    await started;

    const disconnect = disconnectProvider("antigravity");
    let disconnected = false;
    void disconnect.then(() => {
      disconnected = true;
    });
    expect(disconnected).toBe(false);
    expect(() =>
      startProviderAuth("antigravity", async () => undefined, { riskAcknowledged: true }),
    ).toThrow(/disconnect/i);
    releaseRefresh(
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
      }),
    );
    await refresh.catch(() => undefined);
    await disconnect;

    expect(registry.authStorage.get("antigravity")).toBeUndefined();
    expect(registry.authStorage.get("unrelated")).toEqual({ type: "api_key", key: "preserve-me" });
    const persisted = JSON.parse(await readFile(join(userData, "pi-agent", "auth.json"), "utf8"));
    expect(persisted.antigravity).toBeUndefined();
    expect(persisted.unrelated).toEqual({ type: "api_key", key: "preserve-me" });
    expect(getProviderDetail("antigravity")?.authLabel).toBe("OAuth sign-in required");

    const login = vi.spyOn(oauth, "login").mockImplementation(() => new Promise(() => undefined));
    const next = startProviderAuth("antigravity", async () => undefined, {
      riskAcknowledged: true,
    });
    expect(next.status).toBe("pending");
    cancelProviderAuth(next.id);
    login.mockRestore();
    vi.unstubAllGlobals();
  });

  it("discovers native sign-in methods from the runtime provider registry", () => {
    const oauthProvider = getModelRegistry().authStorage.getOAuthProviders()[0];
    if (!oauthProvider) {
      throw new Error("expected a native OAuth provider");
    }

    expect(listProviderConnectionMethods(oauthProvider.id)).toEqual(
      expect.arrayContaining([
        { kind: "api-key", label: "API key" },
        { kind: "oauth", label: oauthProvider.name },
      ]),
    );
  });

  it("clears a built-in provider's local credential, models, and relay override", async () => {
    const provider = "deepseek";
    await configureProvider({
      provider,
      apiKey: "sk-disconnect-builtin",
      baseUrl: "https://relay.example.test/deepseek",
    });

    await disconnectProvider(provider);

    expect(getModelRegistry().authStorage.get(provider)).toBeUndefined();
    expect(getModelSettings().providers.find((item) => item.id === provider)).toMatchObject({
      configured: false,
      enabledModelCount: 0,
    });
    expect(
      getDatabase()
        .prepare("select provider_id from model_provider_configs where provider_id = ?")
        .get(provider),
    ).toBeUndefined();

    const modelsJson = JSON.parse(
      await readFile(join(userData, "pi-agent", "models.json"), "utf-8"),
    ) as { providers?: Record<string, unknown> };
    expect(modelsJson.providers?.[provider]).toBeUndefined();
  });

  it("keeps a custom provider definition after disconnecting its stored key", async () => {
    const provider = `disconnect-${crypto.randomUUID().slice(0, 8)}`;
    await upsertCustomProvider({
      provider,
      name: "Reconnectable relay",
      baseUrl: "https://relay.example.test/v1",
      apiKey: "sk-disconnect-custom",
      models: [{ id: "relay-model", name: "Relay model" }],
    });

    await disconnectProvider(provider);

    expect(getModelRegistry().authStorage.get(provider)).toBeUndefined();
    expect(getCustomProviderConfig(provider)).toMatchObject({
      provider,
      baseUrl: "https://relay.example.test/v1",
      models: [{ id: "relay-model" }],
    });
    expect(getModelSettings().providers.find((item) => item.id === provider)).toMatchObject({
      source: "custom",
      configured: false,
      enabledModelCount: 0,
    });
  });
});

describe("runtime model catalog", () => {
  it("registers packaged Antigravity OAuth without environment configuration", () => {
    const clientId = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    try {
      expect(
        getModelRegistry()
          .authStorage.getOAuthProviders()
          .find(({ id }) => id === "antigravity"),
      ).toBeDefined();
    } finally {
      if (clientId === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
      else process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = clientId;
      if (clientSecret === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
      else process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = clientSecret;
    }
  });

  it("projects Antigravity reasoning variants and exact Opus token budgets", () => {
    const registry = getModelRegistry();
    const detail = getProviderDetail("antigravity")!;
    const options = (id: string) => detail.models.find((model) => model.id === id)?.thinkingOptions;
    expect(options("antigravity-gemini-3-pro")?.map(({ value, level }) => [value, level])).toEqual([
      ["low", "low"],
      ["high", "high"],
    ]);
    expect(options("antigravity-gemini-3-flash")?.map(({ value }) => value)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(options("antigravity-claude-sonnet-4-6")?.map(({ value }) => value)).toEqual(["off"]);
    expect(
      options("antigravity-claude-opus-4-6-thinking")?.map(({ value, level }) => [value, level]),
    ).toEqual([
      ["8192", "high"],
      ["32768", "high"],
    ]);
    expect(options("antigravity-gemini-3-pro")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "off" })]),
    );
    const opus = registry.find("antigravity", "antigravity-claude-opus-4-6-thinking")!;
    expect(opus.thinkingLevelMap).toBeUndefined();
    expect(resolveModelThinking(opus, "8192")).toMatchObject({
      thinkingLevel: "high",
      variant: "8192",
      thinkingBudget: 8192,
    });
    expect(resolveModelThinking(opus, "32768")).toMatchObject({
      thinkingLevel: "high",
      variant: "32768",
      thinkingBudget: 32768,
    });
    expect(resolveModelThinking(opus)).toMatchObject({
      thinkingLevel: "high",
      variant: "32768",
      thinkingBudget: 32768,
    });
    expect(
      updateModelConfig({
        model: "antigravity/antigravity-claude-opus-4-6-thinking",
        thinkingVariant: "8192",
      }).thinkingVariant,
    ).toBe("8192");
    expect(
      getProviderDetail("antigravity")?.models.find(
        (model) => model.id === "antigravity-claude-opus-4-6-thinking",
      )?.thinkingVariant,
    ).toBe("8192");
    expect(resolveModelThinking(opus).thinkingBudget).toBe(8192);
  });

  it("shows provider-default options for Gemini CLI without adding manifest variants", () => {
    const registry = getModelRegistry();
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: Number.MAX_SAFE_INTEGER,
      projectId: "cli-project",
    });
    getModelSettings();
    const ids = [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ];
    for (const id of ids) {
      const model = registry.find("antigravity", id)!;
      expect(model.thinkingLevelMap).toBeUndefined();
      const config = getProviderDetail("antigravity")?.models.find((item) => item.id === id);
      expect(config?.thinkingOptions).toHaveLength(1);
      expect(config?.thinkingOptions?.[0]?.label).toMatch(/^Provider default/);
      expect(config?.thinkingOptions?.[0]?.label).toContain(
        id.startsWith("gemini-3") ? "low" : "default",
      );
      expect(resolveModelThinking(model)).toMatchObject({
        variant: "default",
        thinkingLevel: "off",
      });
      expect(resolveModelThinking(model)).not.toHaveProperty("thinkingBudget");
    }
  });

  it("registers native providers separately with exact IDs and unknown pricing across refreshes", () => {
    const registry = getModelRegistry();
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: 1_900_000_000_000,
    });
    getModelSettings();
    const command = registry.getAll().filter((model) => model.provider === "commandcode");
    const antigravity = registry.getAll().filter((model) => model.provider === "antigravity");

    expect(command.map(({ id }) => id)).toContain("claude-haiku-4-5");
    expect(command.every(({ api }) => api === "commandcode-alpha-generate")).toBe(true);
    expect(antigravity).toHaveLength(5);
    expect(antigravity.map(({ id }) => id)).not.toContain("gemini-2.5-flash");
    expect(antigravity.every(({ api }) => api === "antigravity-cloud-code-assist")).toBe(true);
    expect(registry.find("openai", "gpt-4o")?.api).not.toBe("commandcode-alpha-generate");
    expect(getProviderDetail("commandcode")).toMatchObject({
      pricingAvailability: "unknown",
      modelCount: command.length,
    });
    expect(getProviderDetail("antigravity")).toMatchObject({ modelCount: 11 });

    getModelSettings();
    expect(
      getModelRegistry()
        .getAll()
        .filter(({ provider }) => provider === "commandcode"),
    ).toHaveLength(command.length);
    expect(
      getModelRegistry()
        .getAll()
        .filter(({ provider }) => provider === "antigravity"),
    ).toHaveLength(antigravity.length);
    return readFile(join(userData, "pi-agent", "model-catalog.json"), "utf8")
      .then((contents) => expect(contents).not.toContain("claude-haiku-4-5"))
      .catch(() => undefined);
  });

  it("uses current Antigravity AuthStorage credentials without re-registering", async () => {
    const registry = getModelRegistry();
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "first-access",
      refresh: "refresh",
      expires: 1_900_000_000_000,
      projectId: "first-project",
    });
    getModelSettings();
    const model = registry.find("antigravity", "antigravity-gemini-3-pro");
    if (!model) throw new Error("expected an Antigravity model");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const providerConfig = (
      registry as unknown as {
        registeredProviders: Map<
          string,
          { streamSimple?: (model: Model<Api>, context: Context) => AsyncIterable<unknown> }
        >;
      }
    ).registeredProviders.get("antigravity");
    if (!providerConfig?.streamSimple) throw new Error("expected Antigravity stream registration");
    const invoke = async () => {
      const events = providerConfig.streamSimple?.(model, {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        tools: [],
      });
      if (!events) throw new Error("expected Antigravity stream");
      for await (const _event of events) {
        /* consume */
      }
    };

    await invoke();
    registry.authStorage.set("antigravity", {
      type: "oauth",
      access: "second-access",
      refresh: "refresh-2",
      expires: 1_900_000_000_000,
      projectId: "second-project",
    });
    await invoke();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1];
    const second = fetchMock.mock.calls[1]?.[1];
    expect(first?.headers).toMatchObject({ authorization: "Bearer first-access" });
    expect(JSON.parse(String(first?.body))).toMatchObject({ project: "first-project" });
    expect(second?.headers).toMatchObject({ authorization: "Bearer second-access" });
    expect(JSON.parse(String(second?.body))).toMatchObject({ project: "second-project" });
    vi.unstubAllGlobals();
  });

  it("rejects Command Code blank keys and exposes provider-specific connection methods", async () => {
    await expect(configureProvider({ provider: "commandcode", apiKey: "   " })).rejects.toThrow(
      /key/i,
    );
    expect(listProviderConnectionMethods("commandcode")).toEqual([
      { kind: "api-key", label: "API key" },
    ]);
    expect(listProviderConnectionMethods("antigravity")).toEqual([
      { kind: "oauth", label: "Antigravity" },
    ]);
  });

  it("stores Command Code keys only in AuthStorage without remotely validating them", async () => {
    const key = `  cc-${crypto.randomUUID()}  `;
    const detail = await configureProvider({ provider: "commandcode", apiKey: key });
    expect(getModelRegistry().authStorage.get("commandcode")).toEqual({
      type: "api_key",
      key: key.trim(),
    });
    expect(detail.authLabel).toBe("API key (not remotely validated)");
    expect(JSON.stringify(detail)).not.toContain(key.trim());
    const modelsJson = await readFile(join(userData, "pi-agent", "models.json"), "utf8");
    expect(modelsJson).not.toContain(key.trim());
  });

  it("projects added and retired catalog models from the runtime registry", async () => {
    const shippedPath = fileURLToPath(
      new URL("../../../../../catalog/models.json", import.meta.url),
    );
    const catalog = JSON.parse(await readFile(shippedPath, "utf8")) as {
      providers: Record<string, Array<Record<string, unknown>>>;
    };
    const anthropicModels = catalog.providers.anthropic;
    const anthropicModel = anthropicModels?.[0];
    if (!anthropicModel || typeof anthropicModel.id !== "string")
      throw new Error("expected an Anthropic model in the shipped catalog");
    catalog.providers.anthropic = [
      ...anthropicModels.slice(1),
      {
        ...anthropicModel,
        id: "future-model",
        name: "Future Model",
        reasoningCapability: {
          type: "options",
          source: "models.dev",
          options: [
            { value: "low", label: "Low", level: "low", wireValue: "low" },
            { value: "high", label: "High", level: "high", wireValue: "high" },
          ],
        },
      },
      {
        ...anthropicModel,
        id: "budget-model",
        name: "Budget Model",
        reasoningCapability: {
          type: "budget",
          source: "models.dev",
          min: 128,
          max: 32_768,
        },
      },
    ];

    await upsertCustomProvider({
      provider: "openai",
      name: "Local OpenAI",
      baseUrl: "https://local.example.test/v1",
      apiKey: "sk-local",
      models: [{ id: "local-model", name: "Local Model" }],
    });
    await configureProvider({
      provider: "anthropic",
      apiKey: "sk-relay",
      baseUrl: "https://relay.example.test/anthropic",
    });
    const cachePath = join(userData, "pi-agent", "model-catalog.json");
    await writeFile(cachePath, JSON.stringify(catalog), "utf8");

    try {
      startRemoteModelCatalog(() => undefined);

      expect(findModel("anthropic/future-model")).toBeDefined();
      expect(findModel("anthropic/future-model")?.baseUrl).toBe(
        "https://relay.example.test/anthropic",
      );
      expect(getProviderDetail("anthropic")?.models).toContainEqual(
        expect.objectContaining({ id: "future-model", enabled: false }),
      );
      expect(
        getProviderDetail("anthropic")?.models.some((model) => model.id === anthropicModel.id),
      ).toBe(false);
      expect(listModels().some((model) => model.id === "anthropic/future-model")).toBe(false);
      updateModelConfig({ model: "anthropic/future-model", enabled: true });
      expect(listModels().some((model) => model.id === "anthropic/future-model")).toBe(true);
      expect(
        getProviderDetail("anthropic")?.models.find((model) => model.id === "future-model")
          ?.thinkingOptions,
      ).toEqual([
        { value: "low", label: "Low", level: "low", wireValue: "low" },
        { value: "high", label: "High", level: "high", wireValue: "high" },
      ]);
      const futureModel = findModel("anthropic/future-model");
      if (!futureModel) throw new Error("expected the catalog model to be registered");
      expect(resolveModelThinking(futureModel, "high").model.thinkingLevelMap?.high).toBe("high");
      expect(
        getProviderDetail("anthropic")?.models.find((model) => model.id === "budget-model")
          ?.thinkingBudget,
      ).toEqual({ min: 128, max: 32_768 });
      expect(findModel("openai/local-model")).toBeDefined();
    } finally {
      stopRemoteModelCatalog();
    }
  });
});
