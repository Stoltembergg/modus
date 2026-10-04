import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../shared/auth";
import { createModusProvider } from "./modus-provider";
import type { ModusModelsResult } from "./providers/modus-router-models";

function auth(status: AuthState["status"], userId = "u1") {
  let state = { status, user: status === "signed-in" ? { id: userId } : null } as AuthState;
  const listeners = new Set<(next: AuthState) => void>();
  return {
    getState: () => state,
    onStateChange(listener: (next: AuthState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(next: AuthState["status"], id = userId) {
      state = { ...state, status: next, user: next === "signed-in" ? ({ id } as never) : null };
      for (const listener of listeners) listener(state);
    },
  };
}

const READY: ModusModelsResult = {
  ok: true,
  plan: "free",
  models: [
    { id: "deepseek/deepseek-flash", name: "Flash", ownedBy: "deepseek", allowed: true },
    { id: "zai/glm-4.6", name: "GLM", ownedBy: "zai", allowed: false },
  ],
};

function fakeRegistry() {
  return {
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
  } as unknown as ModelRegistry & {
    registerProvider: ReturnType<typeof vi.fn>;
    unregisterProvider: ReturnType<typeof vi.fn>;
  };
}

function setup(initial: AuthState["status"], fetchModels = vi.fn(async () => READY)) {
  const source = auth(initial);
  const onChanged = vi.fn();
  const provider = createModusProvider({
    auth: source,
    fetchModels,
    stream: vi.fn() as never,
    routerUrl: () => "https://x.supabase.co/functions/v1/model-router",
    onChanged,
  });
  return { source, provider, fetchModels, onChanged };
}

describe("createModusProvider", () => {
  it("stays off (unregistered) without a session and never fetches", () => {
    const { provider, fetchModels } = setup("signed-out");
    const registry = fakeRegistry();
    provider.register(registry);
    expect(provider.status()).toBe("off");
    expect(registry.registerProvider).not.toHaveBeenCalled();
    expect(registry.unregisterProvider).toHaveBeenCalledWith("modus");
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("loads on sign-in, registers the router models with the placeholder key, flags locked ids", async () => {
    const { provider, source } = setup("signed-out");
    source.emit("signed-in");
    await vi.waitFor(() => expect(provider.status()).toBe("ready"));
    expect([...provider.lockedIds()]).toEqual(["modus/zai/glm-4.6"]);
    const registry = fakeRegistry();
    provider.register(registry);
    const [id, config] = registry.registerProvider.mock.calls[0] ?? [];
    expect(id).toBe("modus");
    expect(config).toMatchObject({
      name: "Modus",
      api: "modus-router",
      apiKey: "modus-session",
      baseUrl: "https://x.supabase.co/functions/v1/model-router",
    });
    expect(config.models.map((model: { id: string }) => model.id)).toEqual([
      "deepseek/deepseek-flash",
      "zai/glm-4.6",
    ]);
    // Idempotent: same state, no re-registration.
    provider.register(registry);
    expect(registry.registerProvider).toHaveBeenCalledTimes(1);
  });

  it("a late /v1/models result after sign-out is ignored", async () => {
    let resolve: ((result: ModusModelsResult) => void) | undefined;
    const fetchModels = vi.fn(
      () =>
        new Promise<ModusModelsResult>((done) => {
          resolve = done;
        }),
    );
    const { provider, source } = setup("signed-in", fetchModels);
    expect(provider.status()).toBe("loading");
    source.emit("signed-out");
    resolve?.(READY);
    await Promise.resolve();
    expect(provider.status()).toBe("off");
  });

  it("unavailable → re-registered with no models; retry only when asked (catalog load)", async () => {
    const fetchModels = vi
      .fn<() => Promise<ModusModelsResult>>()
      .mockResolvedValueOnce(READY)
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce(READY);
    const { provider } = setup("signed-in", fetchModels);
    await vi.waitFor(() => expect(provider.status()).toBe("ready"));
    const registry = fakeRegistry();
    provider.register(registry);
    await provider.reload();
    expect(provider.status()).toBe("unavailable");
    provider.register(registry);
    expect(registry.unregisterProvider).toHaveBeenCalledWith("modus");
    expect(registry.registerProvider.mock.calls.at(-1)?.[1].models).toEqual([]);
    expect(fetchModels).toHaveBeenCalledTimes(2);
    provider.retryIfUnavailable();
    await vi.waitFor(() => expect(provider.status()).toBe("ready"));
    provider.retryIfUnavailable();
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  it("an expired session from /v1/models turns the provider off", async () => {
    const { provider } = setup(
      "signed-in",
      vi.fn(async (): Promise<ModusModelsResult> => ({ ok: false, reason: "signed-out" })),
    );
    await vi.waitFor(() => expect(provider.status()).toBe("off"));
  });

  it("a different account reloads the models", async () => {
    const { provider, source, fetchModels } = setup("signed-in");
    await vi.waitFor(() => expect(provider.status()).toBe("ready"));
    source.emit("signed-in", "u1");
    expect(fetchModels).toHaveBeenCalledTimes(1);
    source.emit("signed-in", "u2");
    await vi.waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(2));
  });
});
