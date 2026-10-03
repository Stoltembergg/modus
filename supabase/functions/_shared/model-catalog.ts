/**
 * Server-side model table for the model-router (B4a). Prices are what WE pay the
 * upstream, never the catalog/models.json list prices, and they are a versioned
 * snapshot: the router never fetches pricing at runtime (model-catalog.test.ts
 * greps the router code for that).
 *
 * Upstream: a single OpenAI-compatible New API gateway (vibi.top). Its base URL and
 * key come ONLY from env (MODUS_UPSTREAM_BASE_URL, MODUS_UPSTREAM_API_KEY); moving
 * to another provider is env + this table, no code.
 *
 * Ids are `<native provider>/<native model id>` from catalog/models.json and are what
 * plans.allowed_models stores; `upstreamId` is the gateway's model name. Context
 * window, output cap and tier thresholds come from catalog/models.json (parity test).
 *
 * PRICING SNAPSHOT  version: vibi-2026-10-03
 *   source:    GET https://vibi.top/api/pricing (public, no auth), fetched
 *              2026-10-03 03:28 BRT, pricing_version a42d372ccf0b5dd13ecf71203521f9d2.
 *              /api/status at the same time: New API v1.0.0-rc.40, quota_per_unit
 *              500000, quota_display_type USD.
 *   premise (New API ratio billing, to be confirmed on the first real request by
 *   comparing our usage with the debit in the vibi panel):
 *     input  US$/1M = model_ratio * 2 * group_ratio        (ratio 1 = US$ 2 / 1M)
 *     output US$/1M = model_ratio * completion_ratio * 2 * group_ratio
 *     cache  US$/1M = model_ratio * cache_ratio * 2 * group_ratio   (when listed)
 *   Models billed with `billing_expr` (tiered_expr) state US$/1M coefficients
 *   directly (none of the models below).
 *   group_ratio: per model, `groupRatio` = max(1.0, highest group_ratio among the
 *   model's enable_groups in the snapshot): conservative, never below cost.
 *   Snapshot group_ratio: auto 1, claude 1, "codex plus" 0.6, "codex pro" 0.9,
 *   "gemini ultra" 3, "grok heavy" 0.8, "image - 2k" 1, "image - 4k" 5.5,
 *   "model - china" 0.8, "Claude Max 20x Account" 6 (SNAPSHOT_GROUP_RATIOS).
 *   Our key is in group "auto" (ratio 1), which may route these models to
 *   "model - china" (0.8). Change a groupRatio only after comparing a real debit in
 *   the vibi panel with our usage (pinned by model-catalog.test.ts).
 *
 *   deepseek-v4.1-flash  model_ratio 1.1   completion_ratio 3.863636363636
 *                        cache_ratio 0.136363636364  enable_groups ["model - china"]
 *                        -> 2.2 / 8.5 / 0.3 US$ per 1M (input / output / cache read)
 *   glm-5.3-flash        model_ratio 0.6   completion_ratio 3.3125
 *                        cache_ratio 0.333333333333  create_cache_ratio 1
 *                        enable_groups ["model - china"]
 *                        -> 1.2 / 3.975 / 0.4 US$ per 1M
 *   (derived values rounded to 6 decimals)
 */

/** group_ratio per group in the snapshot (/api/pricing `group_ratio`). */
export const SNAPSHOT_GROUP_RATIOS: Readonly<Record<string, number>> = {
  "Claude Max 20x Account": 6,
  auto: 1,
  claude: 1,
  "codex plus": 0.6,
  "codex pro": 0.9,
  "gemini ultra": 3,
  "grok heavy": 0.8,
  "image - 2k": 1,
  "image - 4k": 5.5,
  "model - china": 0.8,
};

/** max(1.0, highest snapshot group_ratio among the model's enable_groups). */
export function groupRatioFor(enableGroups: readonly string[]): number {
  return Math.max(1, ...enableGroups.map((group) => SNAPSHOT_GROUP_RATIOS[group] ?? Infinity));
}

export const PRICING_SNAPSHOT = {
  version: "vibi-2026-10-03",
  source: "https://vibi.top/api/pricing",
  fetchedAt: "2026-10-03T03:28:05-03:00",
  pricingVersion: "a42d372ccf0b5dd13ecf71203521f9d2",
} as const;

export type ModelApi = "openai-completions";

/** US$ per 1M tokens. */
export type TokenPrice = { input: number; output: number; cacheRead: number };

export type CatalogModel = {
  /** `<native provider>/<native id>`, matched exactly against plans.allowed_models. */
  id: string;
  /** Native provider key in catalog/models.json (used for usage_events.provider). */
  provider: string;
  /** Model name at the upstream gateway. */
  upstreamId: string;
  name: string;
  /** Adapter used upstream (only openai-completions ships). */
  api: ModelApi;
  contextWindow: number;
  maxTokens: number;
  /** Snapshot enable_groups of the upstream model (audit trail for groupRatio). */
  enableGroups: readonly string[];
  /** Applied to the upstream price: max(1.0, highest group_ratio of enableGroups). */
  groupRatio: number;
  cost: TokenPrice;
  /** Higher price when the prompt is above `inputTokensAbove` tokens. */
  tier?: TokenPrice & { inputTokensAbove: number };
};

const usd = (value: number, groupRatio: number) => Math.round(value * groupRatio * 1e6) / 1e6;

/** New API ratios -> US$ per 1M tokens (premise in the header comment). */
export function newApiPrice(ratios: {
  modelRatio: number;
  completionRatio: number;
  cacheRatio: number;
  groupRatio: number;
}): TokenPrice {
  const input = ratios.modelRatio * 2;
  return {
    input: usd(input, ratios.groupRatio),
    output: usd(input * ratios.completionRatio, ratios.groupRatio),
    cacheRead: usd(input * ratios.cacheRatio, ratios.groupRatio),
  };
}

const CHINA = ["model - china"] as const;

export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: "deepseek/deepseek-flash",
    provider: "deepseek",
    upstreamId: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    contextWindow: 1000000,
    maxTokens: 384000,
    enableGroups: CHINA,
    groupRatio: groupRatioFor(CHINA),
    cost: newApiPrice({
      modelRatio: 1.1,
      completionRatio: 3.863636363636,
      cacheRatio: 0.136363636364,
      groupRatio: groupRatioFor(CHINA),
    }),
  },
  {
    id: "zai/glm-5.3-flash",
    provider: "zai",
    upstreamId: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    api: "openai-completions",
    contextWindow: 1000000,
    maxTokens: 131072,
    enableGroups: CHINA,
    groupRatio: groupRatioFor(CHINA),
    cost: newApiPrice({
      modelRatio: 0.6,
      completionRatio: 3.3125,
      cacheRatio: 0.333333333333,
      groupRatio: groupRatioFor(CHINA),
    }),
  },
];

/**
 * Models served by the gateway that have NO entry in catalog/models.json (the parity
 * test skips only these). Empty today: both models have native catalog entries. The
 * parity test FAILS if an id listed here shows up in catalog/models.json, so it is
 * removed from this list as soon as the catalog has it.
 */
export const SERVER_ONLY_MODELS: readonly string[] = [];

export function findModel(catalog: readonly CatalogModel[], id: string): CatalogModel | undefined {
  return catalog.find((model) => model.id === id);
}
