import { assertEquals, assertNotStrictEquals } from "jsr:@std/assert@1";
import { MODEL_CATALOG } from "../_shared/model-catalog.ts";
import { buildOpenAiCompletionsRequest, withoutCacheControl } from "./upstream.ts";

const CLAUDE = MODEL_CATALOG.filter((m) => m.upstreamGroup === "claude");
const CHINA = MODEL_CATALOG.filter((m) => m.upstreamGroup !== "claude");
const UP = { baseUrl: "https://upstream.example/v1", apiKey: "k" };

function sent(model: (typeof MODEL_CATALOG)[number], body: Record<string, unknown>) {
  const req = buildOpenAiCompletionsRequest(model, body, 64, UP, new AbortController().signal);
  return JSON.parse(String(req.init.body)) as Record<string, unknown>;
}

const body = () => ({
  messages: [
    { role: "system", content: "sys", cache_control: { type: "ephemeral" } },
    {
      role: "user",
      content: [
        { type: "text", text: "long prefix", cache_control: { type: "ephemeral", ttl: "1h" } },
        {
          type: "text",
          text: "nested",
          extra: { deeper: [{ cache_control: { type: "ephemeral" }, keep: 1 }] },
        },
        { type: "image_url", image_url: { url: "data:," } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    },
    {
      role: "tool",
      tool_call_id: "c1",
      content: [{ type: "text", text: "r", cache_control: { type: "ephemeral" } }],
    },
  ],
  tools: [
    {
      type: "function",
      function: { name: "f", parameters: { type: "object", properties: {} } },
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ],
  temperature: 0.2,
});

const hasCacheControl = (v: unknown): boolean => JSON.stringify(v).includes("cache_control");

Deno.test("L5d: claude-group models: cache_control stripped at any depth from messages and tools", () => {
  assertEquals(CLAUDE.length > 0, true, "the catalog has claude-group models");
  for (const model of CLAUDE) {
    const out = sent(model, body());
    assertEquals(hasCacheControl(out), false, model.id);
    assertEquals(out.messages, [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "long prefix" },
          { type: "text", text: "nested", extra: { deeper: [{ keep: 1 }] } },
          { type: "image_url", image_url: { url: "data:," } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "r" }] },
    ]);
    assertEquals(out.tools, [
      { type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } },
    ]);
    assertEquals(
      [out.model, out.temperature, out.max_tokens, out.stream],
      [model.upstreamId, 0.2, 64, true],
    );
  }
});

Deno.test("L5d: non-claude models are forwarded untouched (cache_control kept)", () => {
  assertEquals(CHINA.length > 0, true);
  for (const model of CHINA) {
    const input = body();
    const out = sent(model, input);
    assertEquals(out.messages, input.messages);
    assertEquals(out.tools, input.tools);
  }
});

Deno.test("L5d: the client body is never mutated", () => {
  const input = body();
  const snapshot = structuredClone(input);
  sent(CLAUDE[0], input);
  assertEquals(input, snapshot);
  const copy = withoutCacheControl(input.messages);
  assertNotStrictEquals(copy, input.messages);
  assertEquals(input, snapshot);
});

Deno.test("L5d: withoutCacheControl keeps primitives / null and a string `cache_control` value elsewhere", () => {
  assertEquals(withoutCacheControl(null), null);
  assertEquals(withoutCacheControl("cache_control"), "cache_control");
  assertEquals(withoutCacheControl([1, "a", true, null]), [1, "a", true, null]);
  assertEquals(withoutCacheControl({ text: "cache_control: keep me" }), {
    text: "cache_control: keep me",
  });
});

Deno.test("L5d: a claude body without messages / tools cache_control is unchanged", () => {
  const input = { messages: [{ role: "user", content: "hi" }] };
  assertEquals(sent(CLAUDE[0], input).messages, input.messages);
  assertEquals(sent(CLAUDE[0], input).tools, undefined);
});

Deno.test("L5d: a tool parameter named cache_control (JSON Schema) is kept verbatim", () => {
  const schema = {
    type: "object",
    properties: { cache_control: { type: "string" }, other: { type: "number" } },
    required: ["cache_control"],
  };
  const out = sent(CLAUDE[0], {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        cache_control: { type: "ephemeral" },
        function: { name: "f", parameters: schema, cache_control: { type: "ephemeral" } },
      },
    ],
  });
  assertEquals(out.tools, [{ type: "function", function: { name: "f", parameters: schema } }]);
});
