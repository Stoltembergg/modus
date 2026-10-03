import { ConfigError, type EnvSource } from "../_shared/config.ts";
import { type Markup, parseCreditMarkup } from "./pricing.ts";

/**
 * Upstream gateway, from env ONLY (never from the request):
 *   MODUS_UPSTREAM_BASE_URL  default https://vibi.top/v1; must be a plain https URL
 *   MODUS_UPSTREAM_API_KEY   required
 * Anything missing or invalid -> ConfigError -> 503 provider_not_configured.
 */
export const DEFAULT_UPSTREAM_BASE_URL = "https://vibi.top/v1";

export type UpstreamConfig = { baseUrl: string; apiKey: string };

export function loadUpstreamConfig(env: EnvSource): UpstreamConfig {
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
  const apiKey = env.get("MODUS_UPSTREAM_API_KEY")?.trim();
  if (!apiKey) throw new ConfigError("MODUS_UPSTREAM_API_KEY is not set.");
  return { baseUrl: url.href.replace(/\/+$/, ""), apiKey };
}

export type RouterConfig = {
  /** Throws ConfigError (-> 503 pricing_not_configured). */
  markup: () => Markup;
  /** Throws ConfigError (-> 503 provider_not_configured). */
  upstream: () => UpstreamConfig;
};

/** Read per request (cheap) so a fixed secret takes effect without a redeploy. */
export function routerConfigFromEnv(env: EnvSource): RouterConfig {
  return { markup: () => parseCreditMarkup(env), upstream: () => loadUpstreamConfig(env) };
}
