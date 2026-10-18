import { ConfigError, type EnvSource } from "../_shared/config.ts";
import { UPSTREAM_GROUPS, type UpstreamGroup } from "../_shared/model-catalog.ts";
import { type Markup, parseCreditMarkup } from "./pricing.ts";

/**
 * Upstream gateway, from env ONLY (never from the request):
 *   MODUS_UPSTREAM_BASE_URL   default https://vibi.top/v1; must be a plain https URL
 *   one key per vibi group (the group is fixed per key), UPSTREAM_GROUPS in
 *   _shared/model-catalog.ts: MODUS_UPSTREAM_KEY_CHINA ("model - china"),
 *   MODUS_UPSTREAM_KEY_CLAUDE, MODUS_UPSTREAM_KEY_CODEX_PLUS, MODUS_UPSTREAM_KEY_CODEX_PRO.
 *   A model is called ONLY with the key of its upstreamGroup: no fallback to another key.
 * Anything missing or invalid -> ConfigError -> 503 provider_not_configured.
 */
export const DEFAULT_UPSTREAM_BASE_URL = "https://vibi.top/v1";

export type UpstreamConfig = { baseUrl: string; apiKey: string };

export function loadUpstreamBaseUrl(env: EnvSource): string {
  const rawBase = env.get("MODUS_UPSTREAM_BASE_URL");
  const base = rawBase === undefined ? DEFAULT_UPSTREAM_BASE_URL : rawBase.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError("MODUS_UPSTREAM_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(
      "MODUS_UPSTREAM_BASE_URL must be a plain https URL (no query, fragment or credentials).",
    );
  }
  return url.href.replace(/\/+$/, "");
}

/** The key of exactly this group (never another group's). */
export function loadUpstreamKey(env: EnvSource, group: UpstreamGroup): string {
  const entry = UPSTREAM_GROUPS[group];
  if (!entry) throw new ConfigError(`no upstream key mapping for group "${group}".`);
  const apiKey = env.get(entry.envKey)?.trim();
  if (!apiKey) throw new ConfigError(`${entry.envKey} is not set.`);
  return apiKey;
}

/**
 * Wall clock (Supabase Edge Functions, Free plan): 150 s per worker INCLUDING
 * waitUntil. MODUS_ROUTER_MAX_DURATION_MS (default 120000) bounds the whole
 * request from the moment it arrives (upstream included); the settle retries and a
 * margin for the DB calls must fit in what is left.
 */
export const WALL_CLOCK_LIMIT_MS = 150_000;
export const DEFAULT_MAX_DURATION_MS = 120_000;
/** Streaming only: time to the upstream response headers (min with the cap). */
export const HEADERS_TIMEOUT_MS = 60_000;
/** settle_usage retries (1 + 2 attempts) and their linear backoff. */
export const SETTLE_RETRIES = 2;
export const SETTLE_RETRY_DELAY_MS = 200;
/** Sum of the settle backoff sleeps: 200 + 400. */
export const SETTLE_BACKOFF_TOTAL_MS =
  (SETTLE_RETRY_DELAY_MS * SETTLE_RETRIES * (SETTLE_RETRIES + 1)) / 2;
/** Auth, claim, reserve, cost stores and the settle DB round trips. */
export const WALL_CLOCK_MARGIN_MS = 10_000;

export type DurationLimits = { maxDurationMs: number; headersTimeoutMs: number };

export function parseMaxDuration(env: EnvSource): DurationLimits {
  const raw = env.get("MODUS_ROUTER_MAX_DURATION_MS");
  let maxDurationMs = DEFAULT_MAX_DURATION_MS;
  if (raw !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(raw)) {
      throw new ConfigError("MODUS_ROUTER_MAX_DURATION_MS must be a positive integer (ms).");
    }
    maxDurationMs = Number(raw);
  }
  if (maxDurationMs + SETTLE_BACKOFF_TOTAL_MS + WALL_CLOCK_MARGIN_MS >= WALL_CLOCK_LIMIT_MS) {
    throw new ConfigError(
      `MODUS_ROUTER_MAX_DURATION_MS + settle retries + margin must stay under ${WALL_CLOCK_LIMIT_MS} ms.`,
    );
  }
  return { maxDurationMs, headersTimeoutMs: Math.min(HEADERS_TIMEOUT_MS, maxDurationMs) };
}

export type RouterConfig = {
  /** Throws ConfigError (-> 503 pricing_not_configured). */
  markup: () => Markup;
  /** Throws ConfigError (-> 503 router_not_configured). */
  duration: () => DurationLimits;
  /** Throws ConfigError (-> 503 provider_not_configured). */
  baseUrl: () => string;
  /** Throws ConfigError (-> 503 provider_not_configured). */
  upstreamKey: (group: UpstreamGroup) => string;
};

/** Read per request (cheap) so a fixed secret takes effect without a redeploy. */
export function routerConfigFromEnv(env: EnvSource): RouterConfig {
  return {
    markup: () => parseCreditMarkup(env),
    duration: () => parseMaxDuration(env),
    baseUrl: () => loadUpstreamBaseUrl(env),
    upstreamKey: (group) => loadUpstreamKey(env, group),
  };
}
