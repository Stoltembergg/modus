import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AuthState } from "../../shared/auth";
import type { ModusModelsStatus } from "../../shared/contracts";
import {
  MODUS_API_ID,
  MODUS_API_KEY_PLACEHOLDER,
  MODUS_PROVIDER_ID,
  MODUS_PROVIDER_NAME,
} from "./providers/modus-router-adapter";
import type { ModusModelsResult, ModusRouterModel } from "./providers/modus-router-models";

/**
 * Modus provider lifecycle (B4b). Registered next to the native providers only while the app
 * account is signed in; models come from the router's /v1/models.
 * - signed out → "off": provider unregistered.
 * - /v1/models failed (503, offline) → "unavailable": provider registered with NO models and the
 *   picker says so. Retried on the next catalog load (`retryIfUnavailable`), never in a loop.
 * - `allowed: false` models are listed as locked (UI hint); the router's 403 is the barrier.
 * Nothing here touches pi's auth.json / models.json or another provider's registration.
 */
type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type AuthSource = {
  getState(): AuthState;
  onStateChange(listener: (state: AuthState) => void): () => void;
};

export type ModusProviderDeps = {
  auth: AuthSource;
  fetchModels(): Promise<ModusModelsResult>;
  stream: StreamFn;
  /** Shown as the provider baseUrl (never used for requests: the adapter has the fixed URL). */
  routerUrl(): string | undefined;
  /** Models changed: re-apply the registry and tell the renderer (model:catalog-changed). */
  onChanged(): void;
};

export type ModusProvider = {
  /**
   * The adapter stream. pi-coding-agent registers custom APIs in its own (nested) pi-ai copy,
   * so callers of the root pi-ai `completeSimple` (completeWithModel) use this directly.
   */
  stream: StreamFn;
  status(): ModusModelsStatus;
  models(): readonly ModusRouterModel[];
  /** App model ids (`modus/<provider>/<id>`) not in the user's plan. */
  lockedIds(): ReadonlySet<string>;
  /** Sync with the cached state; cheap and idempotent (applyModelCatalog runs it often). */
  register(modelRegistry: ModelRegistry): void;
  /** Catalog load hook: one new /v1/models attempt when the last one failed. */
  retryIfUnavailable(): void;
  reload(): Promise<void>;
  dispose(): void;
};

const PLACEHOLDER_BASE_URL = "https://modus.invalid/functions/v1/model-router";

export function createModusProvider(deps: ModusProviderDeps): ModusProvider {
  let status: ModusModelsStatus = "off";
  let models: ModusRouterModel[] = [];
  let locked = new Set<string>();
  let userId: string | null = null;
  let loading: Promise<void> | undefined;
  let generation = 0;
  const registered = new WeakMap<ModelRegistry, string>();

  function set(nextStatus: ModusModelsStatus, nextModels: ModusRouterModel[]): void {
    status = nextStatus;
    models = nextModels;
    locked = new Set(
      nextModels
        .filter((model) => !model.allowed)
        .map((model) => `${MODUS_PROVIDER_ID}/${model.id}`),
    );
    deps.onChanged();
  }

  function load(): Promise<void> {
    if (loading) return loading;
    const run = generation;
    if (status !== "ready") status = "loading";
    const current = (async () => {
      const result = await deps
        .fetchModels()
        .catch((): ModusModelsResult => ({ ok: false, reason: "unavailable" }));
      if (run !== generation) return;
      if (result.ok) set("ready", result.models);
      else if (result.reason === "signed-out") set("off", []);
      else set("unavailable", []);
    })();
    loading = current;
    void current.finally(() => {
      if (loading === current) loading = undefined;
    });
    return current;
  }

  function onAuth(state: AuthState): void {
    const nextUser = state.status === "signed-in" ? (state.user?.id ?? null) : null;
    if (nextUser === userId) return;
    userId = nextUser;
    generation += 1;
    loading = undefined;
    if (!nextUser) {
      set("off", []);
      return;
    }
    void load();
  }

  const unsubscribe = deps.auth.onStateChange(onAuth);
  onAuth(deps.auth.getState());

  return {
    stream: deps.stream,
    status: () => status,
    models: () => models,
    lockedIds: () => locked,

    register(modelRegistry) {
      const signature =
        status === "off"
          ? "off"
          : JSON.stringify([status, models.map((m) => [m.id, m.allowed, m.name])]);
      if (registered.get(modelRegistry) === signature) return;
      if (status === "off") {
        modelRegistry.unregisterProvider(MODUS_PROVIDER_ID);
        registered.set(modelRegistry, signature);
        return;
      }
      // Full replacement: drop a previous model list before registering (an empty list would
      // otherwise leave the old models in place).
      modelRegistry.unregisterProvider(MODUS_PROVIDER_ID);
      modelRegistry.registerProvider(MODUS_PROVIDER_ID, {
        name: MODUS_PROVIDER_NAME,
        api: MODUS_API_ID as Api,
        baseUrl: deps.routerUrl() ?? PLACEHOLDER_BASE_URL,
        apiKey: MODUS_API_KEY_PLACEHOLDER,
        streamSimple: deps.stream,
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          api: MODUS_API_ID as Api,
          reasoning: false,
          input: ["text"],
          contextWindow: model.contextWindow ?? 128_000,
          maxTokens: model.maxTokens ?? 16_384,
          // Credits are charged by the router; no local per-token price.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      });
      registered.set(modelRegistry, signature);
    },

    retryIfUnavailable() {
      if (status === "unavailable" && userId) void load();
    },

    reload: () => (userId ? load() : Promise.resolve()),

    dispose() {
      unsubscribe();
      generation += 1;
    },
  };
}
