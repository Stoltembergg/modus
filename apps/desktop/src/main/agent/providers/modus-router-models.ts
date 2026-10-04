import type { ModusSession } from "./modus-router-adapter";

/** One entry of the router's GET /v1/models (handler.ts listModels). */
export type ModusRouterModel = {
  /** `<provider>/<id>`, as the router expects it in a completion. */
  id: string;
  name: string;
  ownedBy: string;
  /** False: not in the user's plan. UI hint only; the router's 403 is the real barrier. */
  allowed: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type ModusModelsResult =
  | { ok: true; plan: string; models: ModusRouterModel[] }
  /** "signed-out": no token, or the session expired (expireSession already ran). */
  | { ok: false; reason: "signed-out" | "unavailable" };

export type ModusModelsDeps = {
  routerUrl(): string | undefined;
  anonKey?(): string | undefined;
  session: ModusSession;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LIST_TIMEOUT_MS = 15_000;

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseModusModels(value: unknown): { plan: string; models: ModusRouterModel[] } {
  const body = (value ?? {}) as { plan?: unknown; data?: unknown };
  const models: ModusRouterModel[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(body.data) ? body.data : []) {
    const row = (item ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = positive(row.context_window);
    const maxTokens = positive(row.max_tokens);
    models.push({
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
      ownedBy: typeof row.owned_by === "string" ? row.owned_by : (id.split("/")[0] ?? ""),
      allowed: row.allowed === true,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
  }
  return { plan: typeof body.plan === "string" ? body.plan : "free", models };
}

/** GET /v1/models with the same 401 rule as completions: refresh once, retry once. */
export async function fetchModusModels(deps: ModusModelsDeps): Promise<ModusModelsResult> {
  const url = deps.routerUrl();
  if (!url) return { ok: false, reason: "unavailable" };
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const anonKey = deps.anonKey?.();
  let token: string | null;
  try {
    token = await deps.session.getAccessToken();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!token) return { ok: false, reason: "signed-out" };
  const get = async (bearer: string) =>
    await fetchImpl(`${url}/v1/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(anonKey ? { apikey: anonKey } : {}),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? LIST_TIMEOUT_MS),
    });
  try {
    let response = await get(token);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      try {
        token = await deps.session.refreshAccessToken(token);
      } catch (error) {
        if ((error as { kind?: unknown } | null)?.kind === "network") {
          return { ok: false, reason: "unavailable" };
        }
        await deps.session.expireSession().catch(() => undefined);
        return { ok: false, reason: "signed-out" };
      }
      response = await get(token);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        await deps.session.expireSession().catch(() => undefined);
        return { ok: false, reason: "signed-out" };
      }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, ...parseModusModels(await response.json()) };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
