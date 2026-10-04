import { ConfigError, type EnvSource } from "../_shared/config.ts";
import type { CatalogModel, TokenPrice } from "../_shared/model-catalog.ts";

/**
 * Credits: 1 credit = US$ 0.001 of provider cost, times CREDIT_MARKUP (server env).
 *   cost_usd = (uncached * input + read * cacheRead + write * cacheWrite + completion * output) / 1e6
 *   uncached = prompt - read - write (clamped at 0): the upstream prompt_tokens INCLUDES the
 *   cache reads and the cache writes (vibi probe 2026-10-03: 274 = 12 + 87 read + 175 write).
 *   A model without a cacheWrite price bills its write tokens at input (pre-L2 behaviour).
 *   credits  = ceil(cost_usd * 1000 * CREDIT_MARKUP)
 * Computed with BigInt on scaled integers (prices in 1e-6 US$ per 1M tokens, markup in
 * 1e-4), so the ceil is exact (no 576.0000001 -> 577).
 */
export const DEFAULT_CREDIT_MARKUP = "1.25";

/** Markup as an integer number of 1e-4 units (1.25 -> 12500). */
export type Markup = { scaled: bigint; text: string };

/**
 * CREDIT_MARKUP: unset -> 1.25. Set but empty, not a plain decimal (garbage, "1e3",
 * "Infinity", "NaN", more than 4 decimals), zero or below 1 -> ConfigError, which the
 * router turns into 503 (fail closed: never sell below cost or bill with a guessed markup).
 */
export function parseCreditMarkup(env: EnvSource): Markup {
  const raw = env.get("CREDIT_MARKUP");
  const text = raw === undefined ? DEFAULT_CREDIT_MARKUP : raw.trim();
  const match = /^(\d{1,4})(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw new ConfigError("CREDIT_MARKUP must be a decimal number >= 1.");
  const scaled = BigInt(match[1]) * 10000n + BigInt((match[2] ?? "").padEnd(4, "0") || "0");
  if (scaled < 10000n) throw new ConfigError("CREDIT_MARKUP must be a decimal number >= 1.");
  return { scaled, text };
}

const MICRO = 1_000_000;

function micro(price: number): bigint {
  // Catalog prices have at most 6 decimals (e.g. 0.006): exact once scaled.
  return BigInt(Math.round(price * MICRO));
}

/** The price that applies to a prompt of `promptTokens` tokens (tier above the threshold). */
export function priceFor(model: CatalogModel, promptTokens: number): TokenPrice {
  if (model.tier && promptTokens > model.tier.inputTokensAbove) return model.tier;
  return model.cost;
}

/**
 * `cachedTokens` = prompt-cache reads, `cacheWriteTokens` = prompt-cache writes (L2; absent
 * or 0 when the upstream reports none). Both are part of `promptTokens`.
 */
export type Usage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cacheWriteTokens?: number;
};

/** Prompt split into its billed parts: read <= prompt, write <= prompt - read. */
export function promptParts(usage: Usage): { uncached: number; read: number; write: number } {
  const prompt = Math.max(0, Math.floor(usage.promptTokens));
  const read = Math.min(prompt, Math.max(0, Math.floor(usage.cachedTokens)));
  const write = Math.min(prompt - read, Math.max(0, Math.floor(usage.cacheWriteTokens ?? 0)));
  return { uncached: prompt - read - write, read, write };
}

export function creditsFor(model: CatalogModel, usage: Usage, markup: Markup): number {
  const prompt = Math.max(0, Math.floor(usage.promptTokens));
  const { uncached, read, write } = promptParts(usage);
  const completion = Math.max(0, Math.floor(usage.completionTokens));
  const price = priceFor(model, prompt);
  // sum is in 1e-12 US$ (tokens * 1e-6 US$/1M tokens).
  const sum =
    BigInt(uncached) * micro(price.input) +
    BigInt(read) * micro(price.cacheRead) +
    BigInt(write) * micro(price.cacheWrite ?? price.input) +
    BigInt(completion) * micro(price.output);
  // credits = sum * 1e-12 * 1000 * markup = sum * scaled / 1e13
  const numerator = sum * markup.scaled;
  const denominator = 10_000_000_000_000n;
  return Number((numerator + denominator - 1n) / denominator);
}

/** Input token estimate: ceil(chars / 4). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Missing final usage (stream aborted, client gone, provider omitted it): bill a
 * conservative estimate, capped at the reservation by settle_usage.
 *   input  = ceil(prompt chars / 4)            (same estimate as the reservation)
 *   output = ceil(received output chars / 4 * 1.10)
 */
export function estimateOutputTokens(outputChars: number): number {
  // Integer form of chars / 4 * 1.10 (= chars * 11 / 40): no float drift in the ceil.
  return Math.ceil((Math.max(0, Math.floor(outputChars)) * 11) / 40);
}

/**
 * Worst case for a prompt of `promptTokens` and `completionTokens` output: no cache reads and
 * every prompt token at max(input, cacheWrite) (L2: a prompt that is all cache writes must
 * still fit the reservation). Used for the reservation and the affordable output cap.
 */
export function worstCaseCredits(
  model: CatalogModel,
  promptTokens: number,
  completionTokens: number,
  markup: Markup,
): number {
  const price = priceFor(model, Math.max(0, Math.floor(promptTokens)));
  const writeIsWorse = (price.cacheWrite ?? 0) > price.input;
  return creditsFor(
    model,
    {
      promptTokens,
      cachedTokens: 0,
      cacheWriteTokens: writeIsWorse ? promptTokens : 0,
      completionTokens,
    },
    markup,
  );
}

/**
 * Largest output cap (<= wanted) whose worst case (worstCaseCredits) fits in `balance`
 * credits; 0 when not even one token fits.
 */
export function affordableMaxTokens(
  model: CatalogModel,
  promptTokens: number,
  wanted: number,
  balance: number,
  markup: Markup,
): number {
  const cost = (out: number) => worstCaseCredits(model, promptTokens, out, markup);
  if (cost(wanted) <= balance) return wanted;
  if (cost(0) > balance) return 0;
  let lo = 0;
  let hi = wanted;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (cost(mid) <= balance) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
