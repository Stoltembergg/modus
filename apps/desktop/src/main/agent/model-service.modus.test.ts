import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../shared/auth";
import type { ModusProvider } from "./modus-provider";
import type { ModusModelsResult } from "./providers/modus-router-models";

/**
 * B4b with the real model-service (pi registry, auth.json, models.json, SQLite):
 * - BYOK intact: adding / removing Modus leaves other providers' config and keys unchanged;
 * - BYOK calls never reach the router nor refresh credits;
 * - "modus" is reserved; locked models and the unavailable state reach ModelSettingsState.
 */
let userData: string;
let ms: typeof import("./model-service");
let createModusProvider: typeof import("./modus-provider").createModusProvider;
let createModusRouterStream: typeof import("./providers/modus-router-adapter").createModusRouterStream;
let getDatabase: typeof import("../db/database").getDatabase;

vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const ROUTER = "https://crdgtmyvwdnswuggpjco.supabase.co/functions/v1/model-router";
const BYOK_KEY = "sk-BYOK-SECRET-openai";
const RELAY_KEY = "sk-BYOK-SECRET-relay";
const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@example.com",
  displayName: null,
  avatarUrl: null,
  emailConfirmed: true,
  provider: "email",
};

function authSource(initial: AuthState["status"]) {
  let state = {
    status: initial,
    user: initial === "signed-in" ? USER : null,
    persistence: "encrypted",
    oauthProviders: [],
    pendingProvider: null,
    notice: null,
    error: null,
  } as AuthState;
  const listeners = new Set<(next: AuthState) => void>();
  return {
    getState: () => state,
    onStateChange(listener: (next: AuthState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(status: AuthState["status"]) {
      state = { ...state, status, user: status === "signed-in" ? USER : null };
      for (const listener of listeners) listener(state);
    },
  };
}

const READY: ModusModelsResult = {
  ok: true,
  plan: "free",
  models: [
    { id: "deepseek/deepseek-flash", name: "DeepSeek Flash", ownedBy: "deepseek", allowed: true },
    { id: "zai/glm-4.6", name: "GLM 4.6", ownedBy: "zai", allowed: false },
  ],
};

function sse(text: string): Response {
  const chunks = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function snapshotOthers() {
  const dir = join(userData, "pi-agent");
  const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => "<missing>");
  const db = getDatabase();
  const registry = ms.getModelRegistry();
  return {
    authJson: await read("auth.json"),
    modelsJson: await read("models.json"),
    providerConfigs: db
      .prepare("select * from model_provider_configs where provider_id <> 'modus' order by 1")
      .all(),
    modelConfigs: db
      .prepare("select * from model_configs where provider_id <> 'modus' order by 1")
      .all(),
    registryModels: registry
      .getAll()
      .filter((model) => model.provider !== "modus")
      .map((model) => `${model.provider}/${model.id}@${model.api}@${model.baseUrl}`)
      .sort(),
    keys: {
      openai: registry.authStorage.get("openai"),
      relay: await registry.getApiKeyForProvider("byok-relay"),
    },
  };
}

let provider: ModusProvider | undefined;
const routerFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
  sse("from-modus"),
);
const onCallSettled = vi.fn();

function installModus(auth: ReturnType<typeof authSource>, result: () => ModusModelsResult) {
  const stream = createModusRouterStream({
    routerUrl: () => ROUTER,
    session: {
      getAccessToken: async () => "jwt-SECRET",
      refreshAccessToken: async () => "jwt-SECRET-2",
      expireSession: async () => undefined,
    },
    fetch: routerFetch as unknown as typeof fetch,
    onCallSettled,
  });
  provider = createModusProvider({
    auth,
    fetchModels: async () => result(),
    stream,
    routerUrl: () => ROUTER,
    onChanged: () => ms.setModusProvider(provider),
  });
  ms.setModusProvider(provider);
  return provider;
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-b4b-model-service-"));
  ({ getDatabase } = await import("../db/database"));
  ms = await import("./model-service");
  ({ createModusProvider } = await import("./modus-provider"));
  ({ createModusRouterStream } = await import("./providers/modus-router-adapter"));
  // BYOK: a built-in provider key and a custom OpenAI-compatible relay.
  await ms.configureProvider({ provider: "openai", apiKey: BYOK_KEY });
  await ms.upsertCustomProvider({
    provider: "byok-relay",
    name: "BYOK Relay",
    baseUrl: "https://relay.example.test/v1",
    apiKey: RELAY_KEY,
    api: "openai-completions",
    models: [{ id: "relay-model", name: "Relay Model" }],
  });
}, 60_000);

afterEach(() => {
  provider?.dispose();
  ms.setModusProvider(undefined);
  provider = undefined;
  routerFetch.mockClear();
  onCallSettled.mockClear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("Modus provider in the model service", () => {
  it("BYOK intact: adding and removing Modus leaves other providers' config and keys unchanged", async () => {
    const before = await snapshotOthers();
    expect(before.keys.openai).toEqual({ type: "api_key", key: BYOK_KEY });
    expect(before.keys.relay).toBe(RELAY_KEY);

    const auth = authSource("signed-in");
    const modus = installModus(auth, () => READY);
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    expect(ms.listModels().some((model) => model.provider === "modus")).toBe(true);
    expect(await snapshotOthers()).toEqual(before);

    auth.set("signed-out");
    expect(modus.status()).toBe("off");
    expect(ms.listModels().some((model) => model.provider === "modus")).toBe(false);
    expect(await snapshotOthers()).toEqual(before);

    auth.set("signed-in");
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    ms.setModusProvider(undefined);
    expect(
      ms
        .getModelRegistry()
        .getAll()
        .some((model) => model.provider === "modus"),
    ).toBe(false);
    expect(await snapshotOthers()).toEqual(before);
    // Modus never writes a credential of its own.
    expect(JSON.parse(before.authJson)).not.toHaveProperty("modus");
    expect(JSON.parse((await snapshotOthers()).authJson)).not.toHaveProperty("modus");
  });

  it("BYOK calls never reach the router nor refresh credits (fetch spy)", async () => {
    const auth = authSource("signed-in");
    const modus = installModus(auth, () => READY);
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sse("from-relay"));
    const text = await ms.completeWithModel({
      modelId: "byok-relay/relay-model",
      systemPrompt: "s",
      prompt: "hello relay",
    });
    expect(text).toBe("from-relay");
    expect(globalFetch).toHaveBeenCalled();
    for (const [input] of globalFetch.mock.calls) {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).not.toContain("/functions/v1/model-router");
      expect(url.startsWith("https://relay.example.test/v1")).toBe(true);
    }
    const sentAuth = JSON.stringify(globalFetch.mock.calls.map(([, init]) => init?.headers ?? {}));
    expect(sentAuth).not.toContain("jwt-SECRET");
    expect(routerFetch).not.toHaveBeenCalled();
    expect(onCallSettled).not.toHaveBeenCalled();
  });

  it("Modus calls go to the router with the stripped model id and refresh credits", async () => {
    const auth = authSource("signed-in");
    const modus = installModus(auth, () => READY);
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const text = await ms.completeWithModel({
      modelId: "modus/deepseek/deepseek-flash",
      systemPrompt: "s",
      prompt: "hello modus",
    });
    expect(text).toBe("from-modus");
    expect(globalFetch).not.toHaveBeenCalled();
    expect(routerFetch).toHaveBeenCalledTimes(1);
    const [url, init] = routerFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${ROUTER}/v1/chat/completions`);
    expect(JSON.parse(String(init?.body)).model).toBe("deepseek/deepseek-flash");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer jwt-SECRET");
    expect(headers.authorization).not.toContain("modus-session");
    expect(onCallSettled).toHaveBeenCalledTimes(1);
  });

  it("lists Modus first, on by default, locked models flagged and last; never a locked default", async () => {
    const auth = authSource("signed-in");
    const modus = installModus(auth, () => READY);
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    const settings = ms.getModelSettings();
    expect(settings.modus).toBe("ready");
    const modusModels = settings.models.filter((model) => model.provider === "modus");
    expect(modusModels.map((model) => [model.id, model.locked ?? null, model.enabled])).toEqual([
      ["modus/deepseek/deepseek-flash", null, true],
      ["modus/zai/glm-4.6", "upgrade", true],
    ]);
    expect(modusModels[0]?.providerName).toBe("Modus");
    expect(settings.models[0]?.provider).toBe("modus");
    expect(ms.getDefaultModelId(settings.models)).not.toBe("modus/zai/glm-4.6");
  });

  it("an unavailable router registers Modus with no models; the next catalog load retries once", async () => {
    let result: ModusModelsResult = { ok: false, reason: "unavailable" };
    const fetchModels = vi.fn(async () => result);
    const auth = authSource("signed-in");
    provider = createModusProvider({
      auth,
      fetchModels,
      stream: createModusRouterStream({
        routerUrl: () => ROUTER,
        session: {
          getAccessToken: async () => "jwt-SECRET",
          refreshAccessToken: async () => "jwt-SECRET-2",
          expireSession: async () => undefined,
        },
        fetch: routerFetch as unknown as typeof fetch,
      }),
      routerUrl: () => ROUTER,
      onChanged: () => ms.setModusProvider(provider),
    });
    ms.setModusProvider(provider);
    await vi.waitFor(() => expect(provider?.status()).toBe("unavailable"));
    expect(ms.getModelSettings().modus).toBe("unavailable");
    expect(ms.listModels().some((model) => model.provider === "modus")).toBe(false);
    // Reading the settings again (refreshRegistry → applyModelCatalog) never refetches.
    ms.getModelSettings();
    ms.listModels();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    result = READY;
    provider.retryIfUnavailable();
    await vi.waitFor(() => expect(provider?.status()).toBe("ready"));
    expect(fetchModels).toHaveBeenCalledTimes(2);
    provider.retryIfUnavailable();
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it("L3b0 fallback default: signed in with Modus ready → a usable (unlocked) Modus model", async () => {
    ms.setDefaultModel(undefined);
    const auth = authSource("signed-in");
    const modus = installModus(auth, () => READY);
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    expect(ms.getDefaultModelId()).toBe("modus/deepseek/deepseek-flash");
    expect(ms.getModelSettings().defaultModel).toBe("modus/deepseek/deepseek-flash");
    // A locked model can never become the Settings default, nor be cycled onto.
    expect(() => ms.setDefaultModel("modus/zai/glm-4.6")).toThrow(/not in your plan/);
    for (let i = 0; i < 6; i += 1) expect(ms.cycleDefaultModel().locked).toBeUndefined();
    ms.setDefaultModel(undefined);
  });

  it("L3b0 fallback default: signed out, or Modus unavailable → the user's own provider", async () => {
    ms.setDefaultModel(undefined);
    const auth = authSource("signed-out");
    let result: ModusModelsResult = READY;
    const modus = installModus(auth, () => result);
    expect(modus.status()).toBe("off");
    const signedOut = ms.getDefaultModelId();
    expect(signedOut).toBeDefined();
    expect(signedOut?.startsWith("modus/")).toBe(false);

    result = { ok: false, reason: "unavailable" };
    auth.set("signed-in");
    await vi.waitFor(() => expect(modus.status()).toBe("unavailable"));
    const unavailable = ms.getDefaultModelId();
    expect(unavailable).toBeDefined();
    expect(unavailable?.startsWith("modus/")).toBe(false);

    // A Settings default that is no longer usable (Modus went away) falls back the same way.
    result = READY;
    modus.retryIfUnavailable();
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    ms.setDefaultModel("modus/deepseek/deepseek-flash");
    auth.set("signed-out");
    expect(ms.getDefaultModelId()?.startsWith("modus/")).toBe(false);
    ms.setDefaultModel(undefined);
  });

  it("L3b: Modus turn model = an allowed Settings pick, else the plan default; unlock_pack reaches ModelInfo", async () => {
    ms.setDefaultModel(undefined);
    const STARTER: ModusModelsResult = {
      ok: true,
      plan: "starter",
      defaultModel: "zai/glm-4.6",
      models: [
        { id: "deepseek/deepseek-flash", name: "Flash", ownedBy: "deepseek", allowed: true },
        { id: "zai/glm-4.6", name: "GLM 4.6", ownedBy: "zai", allowed: true },
        { id: "anthropic/claude-opus-5-5", name: "Opus", ownedBy: "anthropic", allowed: true },
        {
          id: "anthropic/claude-fable-5-1",
          name: "Fable",
          ownedBy: "anthropic",
          allowed: false,
          unlockPack: { id: "credits_25k", credits: 25000 },
        },
      ],
    };
    const auth = authSource("signed-in");
    const modus = installModus(auth, () => STARTER);
    await vi.waitFor(() => expect(modus.status()).toBe("ready"));
    // Unset Settings default: the plan default (not the first Modus model).
    expect(ms.getModusTurnModelId()).toBe("modus/zai/glm-4.6");
    expect(ms.getDefaultModelId()).toBe("modus/zai/glm-4.6");
    expect(ms.getModelSettings().modusDefaultModel).toBe("modus/zai/glm-4.6");
    // Starter picks Opus in Settings: Modus turns run on it.
    ms.setDefaultModel("modus/anthropic/claude-opus-5-5");
    expect(ms.getModusTurnModelId()).toBe("modus/anthropic/claude-opus-5-5");
    // An own-provider Settings default does not change the Modus turn model.
    ms.setDefaultModel("byok-relay/relay-model");
    expect(ms.getModusTurnModelId()).toBe("modus/zai/glm-4.6");
    // Locked Fable can't be picked; it carries its unlock pack for the UI.
    expect(() => ms.setDefaultModel("modus/anthropic/claude-fable-5-1")).toThrow(
      /not in your plan/,
    );
    const fable = ms.listModels().find((model) => model.id === "modus/anthropic/claude-fable-5-1");
    expect(fable?.locked).toBe("upgrade");
    expect(fable?.unlockPack).toEqual({ id: "credits_25k", credits: 25000 });
    expect(ms.isUsableModelId("modus/anthropic/claude-fable-5-1")).toBe(false);
    expect(ms.isUsableModelId("modus/anthropic/claude-opus-5-5")).toBe(true);
    auth.set("signed-out");
    expect(ms.getModusTurnModelId()).toBeUndefined();
    ms.setDefaultModel(undefined);
  });

  it('"modus" is reserved: no BYOK key, custom provider, sign-in or disconnect', async () => {
    await expect(ms.configureProvider({ provider: "modus", apiKey: "x" })).rejects.toThrow(
      /Modus account/,
    );
    await expect(
      ms.upsertCustomProvider({
        provider: "modus",
        name: "Fake",
        baseUrl: "https://evil.example.com/v1",
        apiKey: "x",
        api: "openai-completions",
        models: [{ id: "m", name: "M" }],
      }),
    ).rejects.toThrow(/Modus account/);
    await expect(ms.disconnectProvider("modus")).rejects.toThrow(/Modus account/);
    expect(() => ms.startProviderAuth("modus", async () => undefined)).toThrow(/Modus account/);
  });
});
