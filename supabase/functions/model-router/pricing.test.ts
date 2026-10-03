import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ConfigError } from "../_shared/config.ts";
import type { CatalogModel } from "../_shared/model-catalog.ts";
import { env } from "../_shared/test-helpers.ts";
import {
  affordableMaxTokens,
  creditsFor,
  estimateOutputTokens,
  estimateTokens,
  parseCreditMarkup,
} from "./pricing.ts";

const MODEL: CatalogModel = {
  id: "deepseek/deepseek-flash",
  provider: "deepseek",
  upstreamId: "deepseek-v4.1-flash",
  name: "t",
  api: "openai-completions",
  contextWindow: 1000000,
  maxTokens: 384000,
  enableGroups: ["model - china"],
  upstreamGroup: "model - china",
  groupRatio: 1,
  cost: { input: 2.2, output: 8.5, cacheRead: 0.3 },
};
const TIERED: CatalogModel = {
  ...MODEL,
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  tier: { inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02 },
};
const M125 = parseCreditMarkup(env({}));

Deno.test("CREDIT_MARKUP: unset -> 1.25; valid decimals >= 1 accepted", () => {
  assertEquals(M125, { scaled: 12500n, text: "1.25" });
  assertEquals(parseCreditMarkup(env({ CREDIT_MARKUP: "1" })).scaled, 10000n);
  assertEquals(parseCreditMarkup(env({ CREDIT_MARKUP: " 2.5 " })).scaled, 25000n);
  assertEquals(parseCreditMarkup(env({ CREDIT_MARKUP: "1.0001" })).scaled, 10001n);
});

for (const bad of [
  "",
  "   ",
  "abc",
  "1.25x",
  "Infinity",
  "NaN",
  "0",
  "0.0",
  "0.99",
  "-1",
  "1e3",
  "+2",
  "1.23456",
  "1,25",
]) {
  Deno.test(`CREDIT_MARKUP=${JSON.stringify(bad)} -> ConfigError (503 fail closed)`, () => {
    assertThrows(() => parseCreditMarkup(env({ CREDIT_MARKUP: bad })), ConfigError);
  });
}

Deno.test("credits = ceil(cost_usd * 1000 * markup), exact (BigInt), cache at cacheRead", () => {
  // 1M prompt (uncached) at 2.2 = $2.2 -> 2200 * 1.25 = 2750
  assertEquals(
    creditsFor(MODEL, { promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }, M125),
    2750,
  );
  // 1000 out at 8.5/1M = 0.0085 -> 8.5 * 1.25 = 10.625 -> 11
  assertEquals(
    creditsFor(MODEL, { promptTokens: 0, cachedTokens: 0, completionTokens: 1000 }, M125),
    11,
  );
  // 400 prompt of which 400 cached at 0.3/1M = 0.00012 -> 0.15 -> 1
  assertEquals(
    creditsFor(MODEL, { promptTokens: 400, cachedTokens: 400, completionTokens: 0 }, M125),
    1,
  );
  // uncached 600*2.2 + cached 400*0.3 + 200*8.5 = 1320+120+1700 = 3140e-6 $ -> 3.925 credits -> 4
  assertEquals(
    creditsFor(MODEL, { promptTokens: 1000, cachedTokens: 400, completionTokens: 200 }, M125),
    4,
  );
  // exact boundary: 800 out at 1.25 markup -> 0.0068 $ -> 8.5 credits... and 1e6 out -> 10625 exactly
  assertEquals(
    creditsFor(MODEL, { promptTokens: 0, cachedTokens: 0, completionTokens: 1e6 }, M125),
    10625,
  );
  assertEquals(
    creditsFor(MODEL, { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }, M125),
    0,
  );
  // cached > prompt is clamped
  assertEquals(
    creditsFor(MODEL, { promptTokens: 10, cachedTokens: 99, completionTokens: 0 }, M125),
    1,
  );
});

Deno.test("tier: prompts above inputTokensAbove use the higher price for everything", () => {
  const at = (p: number) =>
    creditsFor(TIERED, { promptTokens: p, cachedTokens: 0, completionTokens: 1e6 }, M125);
  // 272000 * 0.1 + 1e6 * 0.5 = 527200e-6 $ -> 659 credits
  assertEquals(at(272000), 659);
  // 272001 * 0.2 + 1e6 * 0.75 = 804400.2e-6 $ -> 1005.50025 -> 1006
  assertEquals(at(272001), 1006);
});

Deno.test("estimates: ceil(chars/4) input, ceil(chars/4*1.10) output", () => {
  assertEquals(estimateTokens(0), 0);
  assertEquals(estimateTokens(1), 1);
  assertEquals(estimateTokens(8), 2);
  assertEquals(estimateTokens(9), 3);
  assertEquals(estimateOutputTokens(0), 0);
  assertEquals(estimateOutputTokens(40), 11);
  assertEquals(estimateOutputTokens(400), 110);
  assertEquals(estimateOutputTokens(1), 1);
});

Deno.test("affordableMaxTokens: largest cap whose worst case fits the balance", () => {
  assertEquals(affordableMaxTokens(MODEL, 100, 384000, 1e9, M125), 384000);
  const cap = affordableMaxTokens(MODEL, 100, 384000, 1000, M125);
  const cost = (out: number) =>
    creditsFor(MODEL, { promptTokens: 100, cachedTokens: 0, completionTokens: out }, M125);
  assertEquals(cost(cap) <= 1000 && cost(cap + 1) > 1000, true);
  assertEquals(affordableMaxTokens(MODEL, 1e6, 10, 0, M125), 0);
});
