// Non-stream clients: the router always streams from the upstream and rebuilds the
// chat.completion. Fixture = a genuine non-stream OpenAI-style response; the stream
// fixture is the same answer as the gateway streams it (OpenAI chunk format), with two
// tool calls whose argument fragments are interleaved.
import { assertEquals } from "jsr:@std/assert@1";
import type { AuthenticatedUser } from "../_shared/auth.ts";
import { USER } from "../_shared/test-helpers.ts";
import { createRouterHandler } from "./handler.ts";
import {
  completionRequest,
  FakeDb,
  FLASH,
  fakeUpstream,
  GLM,
  routerConfig,
  sse,
} from "./test-fakes.ts";
import { CompletionAssembler, SseUsageTracker } from "./upstream.ts";

const USAGE = {
  prompt_tokens: 50,
  completion_tokens: 30,
  total_tokens: 80,
  prompt_tokens_details: { cached_tokens: 10 },
};

/** Genuine non-stream response (what `stream: false` would have returned). */
const NON_STREAM_FIXTURE = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1759470000,
  model: "deepseek-v4.1-flash",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Let me check both.",
        reasoning_content: "The user wants weather and time in Paris.",
        tool_calls: [
          {
            id: "call_weather",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris","unit":"c"}' },
          },
          {
            id: "call_time",
            type: "function",
            function: { name: "get_time", arguments: '{"tz":"Europe/Paris"}' },
          },
        ],
      },
      logprobs: null,
      finish_reason: "tool_calls",
    },
  ],
  usage: USAGE,
  system_fingerprint: "fp_vibi_1",
};

const head = {
  id: "chatcmpl-abc123",
  object: "chat.completion.chunk",
  created: 1759470000,
  model: "deepseek-v4.1-flash",
  system_fingerprint: "fp_vibi_1",
};
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  ...head,
  choices: [{ index: 0, delta: d, logprobs: null, finish_reason: finish }],
});
const tool = (index: number, part: Record<string, unknown>) =>
  delta({ tool_calls: [{ index, ...part }] });

/** The same answer, streamed. Tool-call argument fragments are interleaved 0/1/0/1. */
const STREAM_CHUNKS = [
  delta({ role: "assistant", content: "" }),
  delta({ reasoning_content: "The user wants " }),
  delta({ reasoning_content: "weather and time in Paris." }),
  delta({ content: "Let me " }),
  delta({ content: "check both." }),
  tool(0, {
    id: "call_weather",
    type: "function",
    function: { name: "get_weather", arguments: "" },
  }),
  tool(1, { id: "call_time", type: "function", function: { name: "get_time", arguments: "" } }),
  tool(0, { function: { arguments: '{"city":' } }),
  tool(1, { function: { arguments: '{"tz":' } }),
  tool(0, { function: { arguments: '"Paris","unit":"c"}' } }),
  tool(1, { function: { arguments: '"Europe/Paris"}' } }),
  delta({}, "tool_calls"),
  { ...head, choices: [], usage: USAGE },
];

Deno.test("assembler: streamed chunks -> exactly the non-stream fixture (multi tool calls)", () => {
  const assembler = new CompletionAssembler();
  for (const chunk of STREAM_CHUNKS) assembler.push(structuredClone(chunk));
  assertEquals(assembler.result(), NON_STREAM_FIXTURE);
});

Deno.test("assembler: plain text answer, content concatenated, no optional fields invented", () => {
  const assembler = new CompletionAssembler();
  const h = { id: "c1", object: "chat.completion.chunk", created: 5, model: "glm-5.3-flash" };
  assembler.push({ ...h, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] });
  assembler.push({ ...h, choices: [{ index: 0, delta: { content: "lo" } }] });
  assembler.push({ ...h, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  assembler.push({
    ...h,
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  assertEquals(assembler.result(), {
    id: "c1",
    object: "chat.completion",
    created: 5,
    model: "glm-5.3-flash",
    choices: [
      { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
});

Deno.test("tracker feeds the assembler across arbitrary byte splits", () => {
  const bytes = new TextEncoder().encode(sse(STREAM_CHUNKS));
  const assembler = new CompletionAssembler();
  const tracker = new SseUsageTracker(assembler);
  for (let i = 0; i < bytes.length; i += 7) tracker.push(bytes.slice(i, i + 7));
  tracker.end();
  assertEquals(assembler.result(), NON_STREAM_FIXTURE);
  assertEquals(tracker.usage, { promptTokens: 50, cachedTokens: 10, completionTokens: 30 });
  assertEquals(tracker.jsonBody, null);
});

Deno.test("router, non-stream client: the JSON response deep-equals the non-stream fixture", async () => {
  const up = fakeUpstream(
    () => new Response(sse(STREAM_CHUNKS), { headers: { "content-type": "text/event-stream" } }),
  );
  try {
    const db = new FakeDb(1e9);
    const h = createRouterHandler({
      db,
      getUser: () => Promise.resolve(USER as AuthenticatedUser),
      config: routerConfig(up.baseUrl),
      catalog: [FLASH, GLM],
      log: () => {},
    });
    const res = await h(
      completionRequest({ model: FLASH.id, messages: [{ role: "user", content: "hi" }] }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
    assertEquals(await res.json(), NON_STREAM_FIXTURE);
    assertEquals(up.seen[0].body.stream, true);
    assertEquals(up.seen[0].body.stream_options, { include_usage: true });
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [50, 30]);
  } finally {
    await up.close();
  }
});
