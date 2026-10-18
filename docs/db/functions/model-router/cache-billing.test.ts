/**
 * L2: prompt-cache billing. Writes at cacheWrite, reads at cacheRead, the rest at input,
 * composed from the upstream usage (prompt_tokens INCLUDES reads and writes). The raw usage
 * objects below are the vibi probe results of 2026-10-03 23:20 BRT, verbatim.
 */
import { assert, assertEquals, assertGreater } from "jsr:@std/assert@1";
import { MODEL_CATALOG } from "../_shared/model-catalog.ts";
import {
  affordableMaxTokens,
  creditsFor,
  parseCreditMarkup,
  promptParts,
  type Usage,
  worstCaseCredits,
} from "./pricing.ts";
import { cacheWriteTokens, parseUsage } from "./upstream.ts";

const M125 = parseCreditMarkup({ get: () => undefined });
const byId = (id: string) => {
  const model = MODEL_CATALOG.find((m) => m.id === id);
  if (!model) throw new Error(id);
  return model;
};
const OPUS = byId("anthropic/claude-opus-5-5");
const FABLE = byId("anthropic/claude-fable-5-1");
const FLASH = byId("deepseek/deepseek-flash");

// Probe call 1: claude-opus-5-5, stream.
const PROBE_OPUS_STREAM = {
  prompt_tokens: 274,
  completion_tokens: 1,
  total_tokens: 275,
  usage_semantic: "openai",
  usage_source: "anthropic",
  billing_usage: {
    source: "claude_messages",
    semantic: "anthropic",
    claude_usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 175,
      cache_read_input_tokens: 87,
      output_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 175 },
      claude_cache_creation_5_m_tokens: 0,
      claude_cache_creation_1_h_tokens: 0,
    },
  },
  prompt_tokens_details: {
    cached_tokens: 87,
    cached_creation_tokens: 175,
    cache_write_tokens: 175,
    text_tokens: 0,
    audio_tokens: 0,
    image_tokens: 0,
  },
  completion_tokens_details: {
    text_tokens: 0,
    audio_tokens: 0,
    image_tokens: 0,
    reasoning_tokens: 0,
  },
  input_tokens: 274,
  output_tokens: 0,
  input_tokens_details: null,
  claude_cache_creation_5_m_tokens: 175,
  claude_cache_creation_1_h_tokens: 0,
};
// Probe call 5: claude-opus-5-5, non-stream, cache_control on a ~3.1k-token content part.
const PROBE_OPUS_CACHE = {
  prompt_tokens: 3143,
  completion_tokens: 1,
  total_tokens: 3144,
  usage_semantic: "openai",
  usage_source: "anthropic",
  billing_usage: {
    source: "claude_messages",
    semantic: "anthropic",
    claude_usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 3143,
      cache_read_input_tokens: 0,
      output_tokens: 1,
      claude_cache_creation_5_m_tokens: 0,
      claude_cache_creation_1_h_tokens: 0,
    },
  },
  prompt_tokens_details: {
    cached_tokens: 0,
    cached_creation_tokens: 3143,
    cache_write_tokens: 3143,
    text_tokens: 0,
    audio_tokens: 0,
    image_tokens: 0,
  },
  completion_tokens_details: {
    text_tokens: 0,
    audio_tokens: 0,
    image_tokens: 0,
    reasoning_tokens: 0,
  },
  input_tokens: 3143,
  output_tokens: 0,
  input_tokens_details: null,
  claude_cache_creation_5_m_tokens: 3143,
  claude_cache_creation_1_h_tokens: 0,
};
// Probe call 3/4: claude-fable-5-1.
const PROBE_FABLE = {
  prompt_tokens: 11,
  completion_tokens: 1,
  total_tokens: 12,
  usage_semantic: "openai",
  usage_source: "anthropic",
  billing_usage: {
    source: "claude_messages",
    semantic: "anthropic",
    claude_usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
      claude_cache_creation_5_m_tokens: 0,
      claude_cache_creation_1_h_tokens: 0,
    },
  },
  prompt_tokens_details: { cached_tokens: 0, text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
  completion_tokens_details: {
    text_tokens: 0,
    audio_tokens: 0,
    image_tokens: 0,
    reasoning_tokens: 0,
  },
  input_tokens: 11,
  output_tokens: 0,
  input_tokens_details: null,
  claude_cache_creation_5_m_tokens: 0,
  claude_cache_creation_1_h_tokens: 0,
};

const scaled = (u: Usage, k: number): Usage => ({
  promptTokens: u.promptTokens * k,
  cachedTokens: u.cachedTokens * k,
  cacheWriteTokens: (u.cacheWriteTokens ?? 0) * k,
  completionTokens: u.completionTokens * k,
});

Deno.test("catalog prices used: opus-5-5 6 / 30 / read 0.85 / write 7.5; fable-5-1 10 / 50 / 0.25 / 12.5", () => {
  assertEquals(OPUS.cost, { input: 6, output: 30, cacheRead: 0.85, cacheWrite: 7.5 });
  assertEquals(FABLE.cost, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
  assertEquals(FLASH.cost.cacheWrite, undefined);
});

Deno.test("probe call 1 (opus stream): 274 = 12 uncached + 87 read + 175 write, each at its rate", () => {
  const usage = parseUsage(PROBE_OPUS_STREAM);
  assertEquals(usage, {
    promptTokens: 274,
    cachedTokens: 87,
    completionTokens: 1,
    cacheWriteTokens: 175,
  });
  assertEquals(promptParts(usage as Usage), { uncached: 12, read: 87, write: 175 });
  // 12*6 + 87*0.85 + 175*7.5 + 1*30 = 1488.45 e-6 US$ -> ceil(1.8605625) = 2 credits.
  assertEquals(creditsFor(OPUS, usage as Usage, M125), 2);
  // x1000 to see the composition: 1488.45 e-3 US$ * 1.25 = 1860.5625 -> 1861
  // (pre-L2, writes at input: (187*6 + 87*0.85 + 30) * 1.25 = 1532.44 -> 1533).
  assertEquals(creditsFor(OPUS, scaled(usage as Usage, 1000), M125), 1861);
  assertEquals(
    creditsFor(OPUS, { ...scaled(usage as Usage, 1000), cacheWriteTokens: 0 }, M125),
    1533,
  );
});

Deno.test("probe call 5 (opus + cache_control): 3143 prompt, 0 read, 3143 write", () => {
  const usage = parseUsage(PROBE_OPUS_CACHE) as Usage;
  assertEquals(usage, {
    promptTokens: 3143,
    cachedTokens: 0,
    completionTokens: 1,
    cacheWriteTokens: 3143,
  });
  assertEquals(promptParts(usage), { uncached: 0, read: 0, write: 3143 });
  // 3143*7.5 + 30 = 23602.5 e-6 US$ * 1.25 = 29.5 -> 30 (pre-L2 at input: 23.61 -> 24).
  assertEquals(creditsFor(OPUS, usage, M125), 30);
  assertEquals(creditsFor(OPUS, { ...usage, cacheWriteTokens: undefined }, M125), 24);
});

Deno.test("probe Fable (11, 0 read, 0 write): input only", () => {
  const usage = parseUsage(PROBE_FABLE) as Usage;
  assertEquals(usage, {
    promptTokens: 11,
    cachedTokens: 0,
    completionTokens: 1,
    cacheWriteTokens: 0,
  });
  assertEquals(promptParts(usage), { uncached: 11, read: 0, write: 0 });
  // 11*10 + 50 = 160 e-6 US$ * 1.25 = 0.2 -> 1; x1000: 200.
  assertEquals(creditsFor(FABLE, usage, M125), 1);
  assertEquals(creditsFor(FABLE, scaled(usage, 1000), M125), 200);
});

Deno.test("write fields: top-level / prompt_tokens_details only, never billing_usage.claude_usage", () => {
  // Only the nested billing_usage figure: ignored (it said 0 while the others said 3143).
  assertEquals(
    cacheWriteTokens({
      prompt_tokens: 3143,
      billing_usage: {
        claude_usage: { claude_cache_creation_5_m_tokens: 3143, cache_creation_input_tokens: 3143 },
      },
    }),
    undefined,
  );
  assertEquals(cacheWriteTokens({ prompt_tokens_details: { cache_write_tokens: 5 } }), 5);
  assertEquals(cacheWriteTokens({ prompt_tokens_details: { cached_creation_tokens: 6 } }), 6);
  assertEquals(cacheWriteTokens({ cache_write_tokens: 7 }), 7);
  assertEquals(cacheWriteTokens({ claude_cache_creation_5_m_tokens: 8 }), 8);
  // Disagreement: the higher figure is billed.
  assertEquals(
    cacheWriteTokens({
      prompt_tokens_details: { cache_write_tokens: 100 },
      claude_cache_creation_5_m_tokens: 0,
    }),
    100,
  );
  // Garbage is not a count.
  assertEquals(
    cacheWriteTokens({ cache_write_tokens: -1, claude_cache_creation_5_m_tokens: "9" }),
    undefined,
  );
  // 1-hour writes have no field contract / price yet: not a write count on their own.
  assertEquals(cacheWriteTokens({ claude_cache_creation_1_h_tokens: 500 }), undefined);
});

Deno.test("missing write field: pre-L2 behaviour (writes stay in the uncached part, billed at input)", () => {
  const usage = parseUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 400 },
  }) as Usage;
  assertEquals(usage.cacheWriteTokens, undefined);
  assertEquals(promptParts(usage), { uncached: 600, read: 400, write: 0 });
  assertEquals(
    creditsFor(OPUS, usage, M125),
    creditsFor(OPUS, { promptTokens: 1000, cachedTokens: 400, completionTokens: 200 }, M125),
  );
});

Deno.test("composition clamps: read <= prompt, write <= prompt - read, uncached >= 0", () => {
  assertEquals(promptParts({ promptTokens: 10, cachedTokens: 99, completionTokens: 0 }), {
    uncached: 0,
    read: 10,
    write: 0,
  });
  assertEquals(
    promptParts({ promptTokens: 10, cachedTokens: 4, cacheWriteTokens: 99, completionTokens: 0 }),
    { uncached: 0, read: 4, write: 6 },
  );
  const parsed = parseUsage({
    prompt_tokens: 10,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 99 },
  });
  assertEquals(parsed?.cacheWriteTokens, 6);
});

Deno.test("a model without a cacheWrite price bills reported writes at input", () => {
  const usage: Usage = {
    promptTokens: 1e6,
    cachedTokens: 0,
    cacheWriteTokens: 1e6,
    completionTokens: 0,
  };
  assertEquals(
    creditsFor(FLASH, usage, M125),
    creditsFor(FLASH, { promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }, M125),
  );
});

Deno.test("reservation worst case: every prompt token at max(input, cacheWrite)", () => {
  // Opus: write 7.5 > input 6 -> the worst case bills the whole prompt as writes.
  const worst = worstCaseCredits(OPUS, 100_000, 1000, M125);
  assertEquals(
    worst,
    creditsFor(
      OPUS,
      {
        promptTokens: 100_000,
        cachedTokens: 0,
        cacheWriteTokens: 100_000,
        completionTokens: 1000,
      },
      M125,
    ),
  );
  assertGreater(
    worst,
    creditsFor(OPUS, { promptTokens: 100_000, cachedTokens: 0, completionTokens: 1000 }, M125),
  );
  // Any real split of that prompt fits the reservation.
  for (const [read, write] of [
    [0, 0],
    [0, 100_000],
    [50_000, 50_000],
    [100_000, 0],
    [1, 99_999],
  ]) {
    const cost = creditsFor(
      OPUS,
      {
        promptTokens: 100_000,
        cachedTokens: read,
        cacheWriteTokens: write,
        completionTokens: 1000,
      },
      M125,
    );
    assert(cost <= worst, `${read}/${write}: ${cost} > ${worst}`);
  }
  // A model without cacheWrite: worst case = input only (unchanged).
  assertEquals(
    worstCaseCredits(FLASH, 100_000, 1000, M125),
    creditsFor(FLASH, { promptTokens: 100_000, cachedTokens: 0, completionTokens: 1000 }, M125),
  );
  // affordableMaxTokens uses the same worst case.
  const cap = affordableMaxTokens(OPUS, 100_000, 128_000, worst, M125);
  assertEquals(cap, 1000);
  assert(worstCaseCredits(OPUS, 100_000, cap, M125) <= worst);
  assertGreater(worstCaseCredits(OPUS, 100_000, cap + 1, M125), worst);
});
