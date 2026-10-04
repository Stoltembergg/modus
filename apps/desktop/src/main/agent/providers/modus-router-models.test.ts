import { describe, expect, it, vi } from "vitest";
import { AuthBackendError } from "../../auth/auth-backend";
import { fetchModusModels, parseModusModels } from "./modus-router-models";

const ROUTER = "https://crdgtmyvwdnswuggpjco.supabase.co/functions/v1/model-router";
const LIST = {
  object: "list",
  plan: "free",
  data: [
    {
      id: "deepseek/deepseek-flash",
      object: "model",
      owned_by: "deepseek",
      name: "DeepSeek Flash",
      allowed: true,
      context_window: 128000,
      max_tokens: 8192,
    },
    { id: "zai/glm-4.6", owned_by: "zai", name: "GLM 4.6", allowed: false },
    { id: "not-a-model-id", allowed: true },
    { id: "deepseek/deepseek-flash", allowed: false },
  ],
};

function session(overrides = {}) {
  return {
    getAccessToken: vi.fn(async () => "jwt-old" as string | null),
    refreshAccessToken: vi.fn(async () => "jwt-new"),
    expireSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fetchSequence(...responses: Array<() => Response>) {
  let index = 0;
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses[index++];
    if (!next) throw new Error("unexpected request");
    return next();
  });
}

describe("parseModusModels", () => {
  it("keeps valid unique <provider>/<id> entries with allowed and limits", () => {
    expect(parseModusModels(LIST)).toEqual({
      plan: "free",
      models: [
        {
          id: "deepseek/deepseek-flash",
          name: "DeepSeek Flash",
          ownedBy: "deepseek",
          allowed: true,
          contextWindow: 128000,
          maxTokens: 8192,
        },
        { id: "zai/glm-4.6", name: "GLM 4.6", ownedBy: "zai", allowed: false },
      ],
    });
    expect(parseModusModels(null)).toEqual({ plan: "free", models: [] });
  });
});

describe("fetchModusModels", () => {
  it("GETs the fixed URL with the session token", async () => {
    const fetch = fetchSequence(() => Response.json(LIST));
    const result = await fetchModusModels({
      routerUrl: () => ROUTER,
      anonKey: () => "sb_publishable_test",
      session: session(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.ok && result.models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-flash",
      "zai/glm-4.6",
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${ROUTER}/v1/models`);
    expect(init?.headers).toMatchObject({
      authorization: "Bearer jwt-old",
      apikey: "sb_publishable_test",
    });
  });

  it("401 → refresh once → retry once", async () => {
    const fetch = fetchSequence(
      () => new Response("", { status: 401 }),
      () => Response.json(LIST),
    );
    const s = session();
    const result = await fetchModusModels({
      routerUrl: () => ROUTER,
      session: s,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(true);
    expect(s.refreshAccessToken).toHaveBeenCalledWith("jwt-old");
    expect((fetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe(
      "Bearer jwt-new",
    );
    expect(s.expireSession).not.toHaveBeenCalled();
  });

  it("a second 401 or a rejected refresh expires the session", async () => {
    const twice = session();
    await expect(
      fetchModusModels({
        routerUrl: () => ROUTER,
        session: twice,
        fetch: fetchSequence(
          () => new Response("", { status: 401 }),
          () => new Response("", { status: 401 }),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "signed-out" });
    expect(twice.expireSession).toHaveBeenCalledTimes(1);

    const rejected = session({
      refreshAccessToken: vi.fn(async () => {
        throw new AuthBackendError("rejected", "Invalid Refresh Token");
      }),
    });
    await expect(
      fetchModusModels({
        routerUrl: () => ROUTER,
        session: rejected,
        fetch: fetchSequence(
          () => new Response("", { status: 401 }),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "signed-out" });
    expect(rejected.expireSession).toHaveBeenCalledTimes(1);
  });

  it("503, network errors and an offline refresh are 'unavailable' (session kept)", async () => {
    const s = session({
      refreshAccessToken: vi.fn(async () => {
        throw new AuthBackendError("network", "network");
      }),
    });
    for (const respond of [
      () => Response.json({ error: "billing_unavailable" }, { status: 503 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("", { status: 401 }),
    ]) {
      await expect(
        fetchModusModels({
          routerUrl: () => ROUTER,
          session: s,
          fetch: fetchSequence(respond) as unknown as typeof globalThis.fetch,
        }),
      ).resolves.toEqual({ ok: false, reason: "unavailable" });
    }
    expect(s.expireSession).not.toHaveBeenCalled();
  });

  it("no session or no router URL: no request", async () => {
    const fetch = fetchSequence();
    await expect(
      fetchModusModels({
        routerUrl: () => ROUTER,
        session: session({ getAccessToken: vi.fn(async () => null) }),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "signed-out" });
    await expect(
      fetchModusModels({
        routerUrl: () => undefined,
        session: session(),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
