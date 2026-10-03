import { assert, assertEquals, assertGreater, assertLessOrEqual } from "jsr:@std/assert@1";
import type { AuthenticatedUser } from "../_shared/auth.ts";
import { USER } from "../_shared/test-helpers.ts";
import { createRouterHandler, type RouterDeps } from "./handler.ts";
import { creditsFor, estimateOutputTokens, estimateTokens, parseCreditMarkup } from "./pricing.ts";
import {
  completionRequest,
  FakeDb,
  FLASH,
  fakeUpstream,
  GLM,
  PAID,
  type Reservation,
  routerConfig,
  sse,
} from "./test-fakes.ts";

const M125 = parseCreditMarkup({ get: () => undefined });
const MESSAGES = [{ role: "user", content: "hello there" }];
const PROMPT_TOKENS = estimateTokens(JSON.stringify(MESSAGES).length);

type Logged = Record<string, unknown>[];

function reservationOf(db: FakeDb, key: string): Reservation {
  const r = db.reservations.get(key);
  if (!r) throw new Error(`no reservation ${key}`);
  return r;
}
function chargedOf(r: Reservation): number {
  if (r.charged === undefined) throw new Error("not settled");
  return r.charged;
}
function bodyOf(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new Error("no body");
  return res.body;
}

function handler(db: FakeDb, baseUrl: string, extra: Partial<RouterDeps> = {}, logs: Logged = []) {
  return createRouterHandler({
    db,
    getUser: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === "Bearer user.jwt.token"
          ? (USER as AuthenticatedUser)
          : null,
      ),
    config: routerConfig(baseUrl),
    catalog: [FLASH, GLM, PAID],
    log: (event) => logs.push(event),
    ...extra,
    limits: { settleRetryDelayMs: 1, ...extra.limits },
  });
}

/** Awaits every waitUntil promise, including ones registered while waiting. */
async function drainAll(list: Promise<unknown>[]) {
  for (let seen = -1; seen !== list.length; ) {
    seen = list.length;
    await Promise.all(list);
  }
}

const promptOnly = () =>
  creditsFor(FLASH, { promptTokens: PROMPT_TOKENS, cachedTokens: 0, completionTokens: 0 }, M125);

/** What the gateway sends for `stream: true` (the router always asks for it). */
const okCompletion = (usage: unknown) =>
  new Response(
    sse([
      {
        id: "cmpl",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: "hi!" }, finish_reason: null }],
      },
      {
        id: "cmpl",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      ...(usage === undefined
        ? []
        : [{ id: "cmpl", object: "chat.completion.chunk", created: 1, choices: [], usage }]),
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );

async function errorOf(res: Response) {
  return { status: res.status, error: (await res.json()).error };
}

Deno.test("401 without a valid JWT; 404 unknown route; 405 wrong method", async () => {
  const db = new FakeDb();
  const h = handler(db, "http://127.0.0.1:1/v1");
  const anon = completionRequest(
    { model: FLASH.id, messages: MESSAGES },
    { headers: { authorization: "" } },
  );
  assertEquals(await errorOf(await h(anon)), { status: 401, error: "unauthorized" });
  assertEquals(
    (await h(new Request("http://localhost/model-router/v2/x", { method: "POST" }))).status,
    404,
  );
  assertEquals(
    (await h(new Request("http://localhost/model-router/v1/models", { method: "POST" }))).status,
    405,
  );
  assertEquals(db.claims.size, 0);
});

Deno.test("config fails closed with 503 before the key is claimed or anything is reserved", async () => {
  for (const [config, code] of [
    [routerConfig("http://x", { markup: "abc" }), "pricing_not_configured"],
    [routerConfig("http://x", { markup: "" }), "pricing_not_configured"],
    [routerConfig("http://x", { markup: "0.9" }), "pricing_not_configured"],
    [routerConfig("http://x", { keys: {} }), "provider_not_configured"],
    [routerConfig("http://x", { keys: { claude: "k-claude" } }), "provider_not_configured"],
    [routerConfig("http://x", { maxDurationMs: "abc" }), "router_not_configured"],
    [routerConfig("http://x", { maxDurationMs: "0" }), "router_not_configured"],
    [routerConfig("http://x", { maxDurationMs: "600000" }), "router_not_configured"],
    [routerConfig("http://x", { maxDurationMs: "145000" }), "router_not_configured"],
  ] as const) {
    const db = new FakeDb();
    const res = await handler(db, "http://x", { config })(
      completionRequest({ model: FLASH.id, messages: MESSAGES }),
    );
    assertEquals(await errorOf(res), { status: 503, error: code });
    assertEquals(db.claims.size, 0);
    assertEquals(db.reservations.size, 0);
  }
});

Deno.test("Idempotency-Key: required; a repeat is ALWAYS 409 replay / conflict", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb();
    const h = handler(db, up.baseUrl);
    const body = { model: FLASH.id, messages: MESSAGES };
    assertEquals(await errorOf(await h(completionRequest(body, { key: null }))), {
      status: 400,
      error: "idempotency_key_required",
    });
    assertEquals(await errorOf(await h(completionRequest(body, { key: "bad key!" }))), {
      status: 400,
      error: "invalid_idempotency_key",
    });
    assertEquals((await h(completionRequest(body, { key: "k1" }))).status, 200);
    assertEquals(await errorOf(await h(completionRequest(body, { key: "k1" }))), {
      status: 409,
      error: "idempotency_replay",
    });
    assertEquals(
      await errorOf(await h(completionRequest({ ...body, temperature: 1 }, { key: "k1" }))),
      {
        status: 409,
        error: "idempotency_conflict",
      },
    );
    // A key whose first attempt failed (403) is still used up.
    const blocked = { model: PAID.id, messages: MESSAGES };
    assertEquals((await h(completionRequest(blocked, { key: "k2" }))).status, 403);
    assertEquals(await errorOf(await h(completionRequest(blocked, { key: "k2" }))), {
      status: 409,
      error: "idempotency_replay",
    });
    assertEquals(up.seen.length, 1, "repeats never reach the upstream");
    assertEquals(db.reservations.size, 1);
  } finally {
    await up.close();
  }
});

Deno.test("model checks happen before reserving: 400 / 404 / 403 / 503, no reservation", async () => {
  const db = new FakeDb(100000, {
    plan: "free",
    allowedModels: [FLASH.id, GLM.id, "zai/listed-but-not-in-table"],
  });
  const h = handler(db, "http://127.0.0.1:1/v1");
  const cases: [unknown, number, string][] = [
    ["deepseek-flash", 400, "invalid_model"],
    ["DeepSeek/x y", 400, "invalid_model"],
    [42, 400, "invalid_model"],
    ["openai/gpt-6-luna", 404, "model_not_found"],
    [PAID.id, 403, "model_not_in_plan"],
    ["zai/listed-but-not-in-table", 503, "model_not_configured"],
  ];
  let i = 0;
  for (const [model, status, error] of cases) {
    const res = await h(completionRequest({ model, messages: MESSAGES }, { key: `m${i++}` }));
    assertEquals(await errorOf(res), { status, error }, String(model));
  }
  assertEquals(db.reservations.size, 0);
  assertEquals(db.balance, 100000, "balance untouched");
});

Deno.test("paid plan (allowed_models NULL) may use any model in the table", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb(100000, { plan: "pro", allowedModels: null });
    const res = await handler(
      db,
      up.baseUrl,
    )(completionRequest({ model: PAID.id, messages: MESSAGES }));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(up.seen[0].body.model, "glm-paid");
  } finally {
    await up.close();
  }
});

Deno.test("request validation: n != 1, bad max_tokens, empty messages, oversize body, context", async () => {
  const db = new FakeDb();
  const h = handler(db, "http://127.0.0.1:1/v1");
  const r = (body: unknown, key: string) => h(completionRequest(body, { key }));
  assertEquals(await errorOf(await r({ model: FLASH.id, messages: MESSAGES, n: 2 }, "v1")), {
    status: 400,
    error: "unsupported_n",
  });
  assertEquals(
    await errorOf(await r({ model: FLASH.id, messages: MESSAGES, max_tokens: 0 }, "v2")),
    {
      status: 400,
      error: "invalid_max_tokens",
    },
  );
  assertEquals(await errorOf(await r({ model: FLASH.id, messages: [] }, "v3")), {
    status: 400,
    error: "invalid_messages",
  });
  assertEquals(await errorOf(await r("{not json", "v4")), { status: 400, error: "invalid_json" });
  const huge = { model: FLASH.id, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] };
  assertEquals(await errorOf(await r(huge, "v5")), { status: 413, error: "body_too_large" });
  const small = handler(db, "http://127.0.0.1:1/v1", { catalog: [{ ...FLASH, contextWindow: 3 }] });
  assertEquals(
    await errorOf(
      await small(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "v6" })),
    ),
    { status: 400, error: "context_length_exceeded" },
  );
  assertEquals(db.reservations.size, 0);
});

Deno.test("upstream request: catalog model id, forced max_tokens, include_usage, NO client headers", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 9, completion_tokens: 1 }));
  try {
    const db = new FakeDb(1e9);
    const h = handler(db, up.baseUrl);
    const sneaky = {
      cookie: "session=1",
      "x-api-key": "client-key",
      "x-forwarded-for": "1.2.3.4",
      "openai-organization": "org-x",
      "x-custom": "y",
    };
    const res = await h(
      completionRequest(
        {
          model: FLASH.id,
          messages: MESSAGES,
          max_tokens: 10_000_000,
          user: "u",
          store: true,
          stream_options: { include_usage: false },
          temperature: 0.2,
        },
        { key: "s1", headers: sneaky },
      ),
    );
    assertEquals(res.status, 200);
    await res.json();
    const stream = await h(
      completionRequest(
        { model: GLM.id, messages: MESSAGES, stream: true },
        { key: "s2", headers: sneaky },
      ),
    );
    await stream.text();

    const [plain, streamed] = up.seen;
    assertEquals(new URL(plain.url).pathname, "/v1/chat/completions");
    assertEquals(
      plain.body,
      {
        model: "deepseek-v4.1-flash",
        messages: MESSAGES,
        temperature: 0.2,
        max_tokens: FLASH.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      "a non-stream client still gets a streaming upstream call",
    );
    assertEquals(streamed.body.model, "glm-5.3-flash");
    assertEquals(
      streamed.body.max_tokens,
      GLM.maxTokens,
      "absent max_tokens is set to the model cap",
    );
    assertEquals(streamed.body.stream_options, { include_usage: true });
    for (const seen of up.seen) {
      assertEquals(seen.body.stream, true);
      assertEquals(seen.headers.get("accept"), "text/event-stream");
      assertEquals(seen.headers.get("authorization"), "Bearer upstream-secret");
      for (const name of Object.keys(sneaky)) assertEquals(seen.headers.get(name), null, name);
      const names = [...seen.headers.keys()].filter(
        (n) =>
          ![
            "accept",
            "authorization",
            "content-type",
            "content-length",
            "host",
            "accept-encoding",
            "user-agent",
            "accept-language",
          ].includes(n),
      );
      assertEquals(names, [], "only our own headers reach the upstream");
    }
  } finally {
    await up.close();
  }
});

Deno.test("non-stream: settles real usage (cache at cacheRead), refunds the rest", async () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 400 },
  };
  const up = fakeUpstream(() => okCompletion(usage));
  try {
    const db = new FakeDb(1e9);
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      {},
      logs,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 1000 }, { key: "n1" }));
    assertEquals((await res.json()).choices[0].message.content, "hi!", "body comes from upstream");
    const expected = creditsFor(
      FLASH,
      { promptTokens: 1000, cachedTokens: 400, completionTokens: 200 },
      M125,
    );
    assertEquals(expected, 4);
    const r = reservationOf(db, "n1");
    assertEquals(r.status, "settled");
    assertEquals(r.charged, expected);
    assertEquals(
      r.amount,
      creditsFor(
        FLASH,
        { promptTokens: PROMPT_TOKENS, cachedTokens: 0, completionTokens: 1000 },
        M125,
      ),
    );
    assertEquals(db.balance, 1e9 - expected);
    assertEquals(db.settles[0].inputTokens, 1000);
    assertEquals(db.settles[0].outputTokens, 200);
    assertEquals(db.settles[0].provider, "deepseek");
    assertEquals(logs.at(-1)?.estimated, false);
    assert(!JSON.stringify(logs).includes("hello there"), "the prompt is never logged");
    assert(!JSON.stringify(logs).includes("hi!"), "the response is never logged");
    assert(!JSON.stringify(logs).includes("upstream-secret"), "the key is never logged");
  } finally {
    await up.close();
  }
});

Deno.test("DeepSeek usage shape (prompt_cache_hit_tokens) is understood", async () => {
  const up = fakeUpstream(() =>
    okCompletion({ prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400 }),
  );
  try {
    const db = new FakeDb(1e9);
    await (
      await handler(
        db,
        up.baseUrl,
      )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "d1" }))
    ).json();
    assertEquals(reservationOf(db, "d1").charged, 4);
  } finally {
    await up.close();
  }
});

Deno.test("charge is capped at the reservation even when the upstream over-reports", async () => {
  const up = fakeUpstream(() =>
    okCompletion({ prompt_tokens: 50_000_000, completion_tokens: 50_000_000 }),
  );
  try {
    const db = new FakeDb(1e9);
    await (
      await handler(
        db,
        up.baseUrl,
      )(completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "c1" }))
    ).json();
    const r = reservationOf(db, "c1");
    assertEquals(r.charged, r.amount);
    assertEquals(db.balance, 1e9 - r.amount);
  } finally {
    await up.close();
  }
});

Deno.test("stream: settles from the final usage chunk; body passed through untouched", async () => {
  const events = [
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 30 } },
  ];
  const up = fakeUpstream(
    () => new Response(sse(events), { headers: { "content-type": "text/event-stream" } }),
  );
  try {
    const db = new FakeDb(1e9);
    const res = await handler(
      db,
      up.baseUrl,
    )(completionRequest({ model: GLM.id, messages: MESSAGES, stream: true }, { key: "st1" }));
    assertEquals(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assertEquals(await res.text(), sse(events));
    assertEquals(
      reservationOf(db, "st1").charged,
      creditsFor(GLM, { promptTokens: 20, cachedTokens: 0, completionTokens: 30 }, M125),
    );
    assertEquals(db.settles[0].outputTokens, 30);
  } finally {
    await up.close();
  }
});

Deno.test("stream without usage: conservative estimate (prompt chars/4 + ceil(out chars/4*1.10))", async () => {
  const text = "x".repeat(400);
  const up = fakeUpstream(
    () =>
      new Response(
        sse([
          {
            choices: [
              { delta: { content: text.slice(0, 250), reasoning_content: text.slice(250) } },
            ],
          },
        ]),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );
  try {
    const db = new FakeDb(1e9);
    const logs: Logged = [];
    await (
      await handler(
        db,
        up.baseUrl,
        {},
        logs,
      )(completionRequest({ model: FLASH.id, messages: MESSAGES, stream: true }, { key: "e1" }))
    ).text();
    assertEquals(estimateOutputTokens(400), 110);
    assertEquals(db.settles[0].inputTokens, PROMPT_TOKENS);
    assertEquals(db.settles[0].outputTokens, 110);
    assertEquals(
      reservationOf(db, "e1").charged,
      creditsFor(
        FLASH,
        { promptTokens: PROMPT_TOKENS, cachedTokens: 0, completionTokens: 110 },
        M125,
      ),
    );
    assertEquals(logs.at(-1)?.estimated, true);
  } finally {
    await up.close();
  }
});

Deno.test("client disconnect mid-stream: upstream NOT aborted, drained under waitUntil, real usage", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = fakeUpstream(() => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              sse([{ choices: [{ delta: { content: "y".repeat(40) } }] }], { done: false }),
            ),
          );
          await hold;
          controller.enqueue(
            enc.encode(sse([{ choices: [], usage: { prompt_tokens: 9, completion_tokens: 300 } }])),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const db = new FakeDb(1e9);
    const logs: Logged = [];
    const later: Promise<unknown>[] = [];
    const res = await handler(
      db,
      up.baseUrl,
      { waitUntil: (p) => later.push(p) },
      logs,
    )(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, stream: true, max_tokens: 500 },
        { key: "x1" },
      ),
    );
    const reader = bodyOf(res).getReader();
    await reader.read();
    await reader.cancel();
    assertEquals(reservationOf(db, "x1").status, "active", "not settled at the disconnect");
    release();
    await drainAll(later);
    const r = reservationOf(db, "x1");
    assertEquals(r.status, "settled");
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [9, 300]);
    assertEquals(
      chargedOf(r),
      creditsFor(FLASH, { promptTokens: 9, cachedTokens: 0, completionTokens: 300 }, M125),
    );
    assertLessOrEqual(chargedOf(r), r.amount);
    assertEquals(logs.at(-1)?.outcome, "client_disconnect");
    assertEquals(logs.at(-1)?.estimated, false);
  } finally {
    release?.();
    await up.close();
  }
});

Deno.test("client disconnect mid-stream without usage: output estimate of everything drained", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = fakeUpstream(() => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              sse([{ choices: [{ delta: { content: "a".repeat(40) } }] }], { done: false }),
            ),
          );
          await hold;
          controller.enqueue(
            enc.encode(sse([{ choices: [{ delta: { content: "b".repeat(360) } }] }])),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const db = new FakeDb(1e9);
    const later: Promise<unknown>[] = [];
    const res = await handler(db, up.baseUrl, { waitUntil: (p) => later.push(p) })(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, stream: true, max_tokens: 500 },
        { key: "x2" },
      ),
    );
    const reader = bodyOf(res).getReader();
    await reader.read();
    await reader.cancel();
    release();
    await drainAll(later);
    assertEquals(db.settles[0].outputTokens, estimateOutputTokens(400));
    assertEquals(db.settles[0].inputTokens, PROMPT_TOKENS);
    const r = reservationOf(db, "x2");
    assertLessOrEqual(chargedOf(r), r.amount);
  } finally {
    release?.();
    await up.close();
  }
});

Deno.test("non-stream: the whole upstream call + settle is handed to waitUntil", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb(1e9);
    const later: Promise<unknown>[] = [];
    const pending = handler(db, up.baseUrl, { waitUntil: (p) => later.push(p) })(
      completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "w1" }),
    );
    // A caller that walks away: the registered work still finishes and settles.
    for (let i = 0; i < 100 && later.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assertEquals(later.length, 1);
    await drainAll(later);
    assertEquals(reservationOf(db, "w1").status, "settled");
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [5, 2]);
    await (await pending).json();
  } finally {
    await up.close();
  }
});

Deno.test("mid-stream upstream error after 2xx: estimate of what was received, never a release", async () => {
  const up = fakeUpstream(() => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              sse([{ choices: [{ delta: { content: "e".repeat(40) } }] }], { done: false }),
            ),
          );
          await new Promise((r) => setTimeout(r, 20));
          controller.error(new Error("boom"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const db = new FakeDb(1e9);
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      {},
      logs,
    )(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, stream: true, max_tokens: 500 },
        { key: "m1" },
      ),
    );
    await res.text().catch(() => {});
    for (let i = 0; i < 100 && db.settles.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    assertEquals(db.settles[0].inputTokens, PROMPT_TOKENS);
    assertEquals(db.settles[0].outputTokens, estimateOutputTokens(40));
    assertGreater(chargedOf(reservationOf(db, "m1")), 0);
    assertEquals(logs.at(-1)?.outcome, "upstream_error");
  } finally {
    await up.close();
  }
});

Deno.test("upstream error status: 502, full release (charged 0), no body forwarded", async () => {
  const up = fakeUpstream(() => new Response('{"error":"secret detail"}', { status: 500 }));
  try {
    const db = new FakeDb(5000);
    const res = await handler(
      db,
      up.baseUrl,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "u1" }));
    assertEquals(res.status, 502);
    assertEquals(await res.json(), { error: "upstream_error", upstream_status: 500 });
    assertEquals(reservationOf(db, "u1").charged, 0);
    assertEquals(db.balance, 5000);
  } finally {
    await up.close();
  }
});

Deno.test("upstream unreachable: 502 and full release", async () => {
  const db = new FakeDb(5000);
  const res = await handler(
    db,
    "http://127.0.0.1:1/v1",
  )(completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "u2" }));
  assertEquals(await errorOf(res), { status: 502, error: "upstream_error" });
  assertEquals(reservationOf(db, "u2").charged, 0);
  assertEquals(db.balance, 5000);
});

Deno.test("stream: upstream headers timeout -> 504, prompt estimate charged (not released)", async () => {
  const up = fakeUpstream(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return okCompletion({ prompt_tokens: 1, completion_tokens: 1 });
  });
  try {
    const db = new FakeDb(5000);
    const res = await handler(db, up.baseUrl, { limits: { headersTimeoutMs: 50 } })(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, max_tokens: 100, stream: true },
        { key: "t1" },
      ),
    );
    assertEquals(await errorOf(res), { status: 504, error: "upstream_timeout" });
    assertGreater(promptOnly(), 0);
    assertEquals(reservationOf(db, "t1").charged, promptOnly());
    assertEquals(db.balance, 5000 - promptOnly());
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [PROMPT_TOKENS, 0]);
    await new Promise((r) => setTimeout(r, 450));
  } finally {
    await up.close();
  }
});

Deno.test("non-stream: the headers timeout applies too (504, prompt estimate charged)", async () => {
  const up = fakeUpstream(async () => {
    await new Promise((r) => setTimeout(r, 300));
    return okCompletion({ prompt_tokens: 3, completion_tokens: 2 });
  });
  try {
    const db = new FakeDb(5000);
    const res = await handler(db, up.baseUrl, { limits: { headersTimeoutMs: 40 } })(
      completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "t2" }),
    );
    assertEquals(await errorOf(res), { status: 504, error: "upstream_timeout" });
    assertEquals(chargedOf(reservationOf(db, "t2")), promptOnly(), "after send: the estimate");
    await new Promise((r) => setTimeout(r, 350));
  } finally {
    await up.close();
  }
});

/** Sends `parts` content deltas (one every `gapMs`), then hangs until `hold` resolves. */
function trickle(parts: string[], gapMs: number, hold: Promise<void>) {
  return () => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const part of parts) {
            controller.enqueue(
              enc.encode(
                sse([{ choices: [{ index: 0, delta: { content: part } }] }], { done: false }),
              ),
            );
            await new Promise((r) => setTimeout(r, gapMs));
          }
          await hold;
          try {
            controller.close();
          } catch {
            // cancelled
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
}

Deno.test("non-stream cap: charges prompt + the OUTPUT received so far (not just the prompt)", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = fakeUpstream(trickle(["a".repeat(200), "b".repeat(200)], 5, hold));
  try {
    const db = new FakeDb(1e9);
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      { config: routerConfig(up.baseUrl, { maxDurationMs: "120" }) },
      logs,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 5000 }, { key: "nc1" }));
    assertEquals(await errorOf(res), { status: 504, error: "upstream_timeout" });
    assertEquals(
      [db.settles[0].inputTokens, db.settles[0].outputTokens],
      [PROMPT_TOKENS, estimateOutputTokens(400)],
    );
    const r = reservationOf(db, "nc1");
    assertEquals(
      chargedOf(r),
      creditsFor(
        FLASH,
        {
          promptTokens: PROMPT_TOKENS,
          cachedTokens: 0,
          completionTokens: estimateOutputTokens(400),
        },
        M125,
      ),
    );
    assertGreater(chargedOf(r), promptOnly());
    assertLessOrEqual(chargedOf(r), r.amount);
    assertEquals(logs.at(-1)?.outcome, "stream_cap");
  } finally {
    release?.();
    await up.close();
  }
});

Deno.test("non-stream: progressive cost updates while the upstream is still producing", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = fakeUpstream(
    trickle(["x".repeat(400), "y".repeat(400), "z".repeat(400), "w".repeat(400)], 30, hold),
  );
  try {
    const db = new FakeDb(1e9);
    const later: Promise<unknown>[] = [];
    const pending = handler(db, up.baseUrl, {
      waitUntil: (p) => later.push(p),
      limits: { progressIntervalMs: 20 },
    })(
      completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 5000 }, { key: "np1" }),
    );
    for (let i = 0; i < 100 && db.storeHistory.length < 3; i++)
      await new Promise((r) => setTimeout(r, 10));
    const credits = db.storeHistory.map((s) => s.credits);
    assertEquals(credits[0], promptOnly(), "minimum before the fetch");
    assertGreater(credits.length, 2, `periodic updates on the non-stream path: ${credits}`);
    for (let i = 1; i < credits.length; i++) assertGreater(credits[i], credits[i - 1]);
    // Worker death here -> the sweep charges the last stored value.
    assertEquals(reservationOf(db, "np1").status, "active");
    release();
    const res = await pending;
    assertEquals(res.status, 200);
    assertEquals((await res.json()).choices[0].message.content.length, 1600);
    await drainAll(later);
  } finally {
    release?.();
    await up.close();
  }
});

Deno.test("pre-fetch cost store fails -> 503 billing_unavailable, upstream never called, released", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    for (const stream of [false, true]) {
      const db = new FakeDb(5000);
      db.storeError = true;
      const logs: Logged = [];
      const res = await handler(
        db,
        up.baseUrl,
        {},
        logs,
      )(
        completionRequest(
          { model: FLASH.id, messages: MESSAGES, max_tokens: 100, stream },
          { key: "bu" },
        ),
      );
      assertEquals(await errorOf(res), { status: 503, error: "billing_unavailable" });
      assertEquals(up.seen.length, 0, "the upstream was never called");
      const r = reservationOf(db, "bu");
      assertEquals([r.status, r.charged], ["settled", 0], "reservation released");
      assertEquals(db.balance, 5000, "no credits debited");
      assertEquals(db.stored.has("bu"), false);
      assert(logs.some((l) => l.event === "model_router.cost_store_failed"));
    }
  } finally {
    await up.close();
  }
});

Deno.test("upstream that ignores stream:true and answers JSON: passed through, real usage billed", async () => {
  const body = {
    id: "cmpl-json",
    object: "chat.completion",
    created: 7,
    model: "deepseek-v4.1-flash",
    choices: [
      { index: 0, message: { role: "assistant", content: "plain" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
  };
  const up = fakeUpstream(() => Response.json(body));
  try {
    const db = new FakeDb(1e9);
    const res = await handler(
      db,
      up.baseUrl,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "js1" }));
    assertEquals(await res.json(), body);
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [12, 34]);
  } finally {
    await up.close();
  }
});

Deno.test("stream cap: a stream past the total limit is cut and settled by estimate", async () => {
  const up = fakeUpstream(() => {
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            enc.encode(
              sse([{ choices: [{ delta: { content: "z".repeat(80) } }] }], { done: false }),
            ),
          );
          timer = setTimeout(() => {
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          }, 500);
        },
        cancel() {
          clearTimeout(timer);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const db = new FakeDb(1e9);
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      { config: routerConfig(up.baseUrl, { maxDurationMs: "100" }) },
      logs,
    )(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, stream: true, max_tokens: 500 },
        { key: "cap1" },
      ),
    );
    let failed = false;
    try {
      await res.text();
    } catch {
      failed = true;
    }
    assert(failed, "the client sees the stream end with an error");
    const r = reservationOf(db, "cap1");
    assertEquals(r.status, "settled");
    assertEquals(db.settles[0].outputTokens, estimateOutputTokens(80));
    assertEquals(db.settles[0].inputTokens, PROMPT_TOKENS);
    assertGreater(chargedOf(r), 0);
    assertLessOrEqual(chargedOf(r), r.amount);
    assertEquals(logs.at(-1)?.outcome, "stream_cap");
  } finally {
    await up.close();
  }
});

Deno.test("402: balance cannot pay for the minimum output; nothing reserved, upstream untouched", async () => {
  const db = new FakeDb(1);
  const res = await handler(
    db,
    "http://127.0.0.1:1/v1",
  )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "p1" }));
  assertEquals(await errorOf(res), { status: 402, error: "insufficient_credits" });
  assertEquals(db.reservations.size, 0);
  const none = new FakeDb(null);
  assertEquals(
    (await handler(none, "http://x")(completionRequest({ model: FLASH.id, messages: MESSAGES })))
      .status,
    402,
  );
});

Deno.test("max_tokens is clamped to what the balance pays for", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb(1000);
    await (
      await handler(
        db,
        up.baseUrl,
      )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "a1" }))
    ).json();
    const cap = up.seen[0].body.max_tokens as number;
    assert(cap < FLASH.maxTokens && cap >= 256, String(cap));
    const reserved = reservationOf(db, "a1").amount;
    assertLessOrEqual(reserved, 1000);
    assertGreater(
      creditsFor(
        FLASH,
        { promptTokens: PROMPT_TOKENS, cachedTokens: 0, completionTokens: cap + 1 },
        M125,
      ),
      1000,
    );
  } finally {
    await up.close();
  }
});

Deno.test("429: too many active reservations", async () => {
  const db = new FakeDb(1e9);
  for (let i = 0; i < 4; i++) db.reservations.set(`busy${i}`, { amount: 1, status: "active" });
  const res = await handler(
    db,
    "http://x",
  )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "q1" }));
  assertEquals(await errorOf(res), { status: 429, error: "too_many_requests" });
  assertEquals(db.reservations.has("q1"), false);
});

Deno.test("settle is retried 2 times: a transient failure still settles", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb(1e9);
    db.settleFailures = 2;
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      {},
      logs,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "f0" }));
    await res.json();
    assertEquals(db.settleAttempts, 3);
    assertEquals(reservationOf(db, "f0").status, "settled");
    assertEquals(db.storeHistory.length, 1, "only the pre-fetch minimum was stored");
    assertEquals(logs.at(-1)?.attempts, 3);
  } finally {
    await up.close();
  }
});

Deno.test("settle keeps failing: the computed cost is stored for the sweep, logged without content", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb(1e9);
    db.settleFailures = Infinity;
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      {},
      logs,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "f1" }));
    assertEquals(res.status, 200);
    await res.json();
    assertEquals(db.settleAttempts, 3, "1 try + 2 retries");
    const stored = db.stored.get("f1");
    assertEquals(
      stored?.credits,
      creditsFor(FLASH, { promptTokens: 5, cachedTokens: 0, completionTokens: 2 }, M125),
    );
    assertEquals(
      [stored?.model, stored?.provider, stored?.inputTokens, stored?.outputTokens],
      [FLASH.id, "deepseek", 5, 2],
    );
    const last = logs.at(-1) ?? {};
    assertEquals([last.event, last.cost_stored], ["model_router.settle_failed", true]);
    assert(!JSON.stringify(logs).includes("hello there"), "no content in logs");
    assertEquals(reservationOf(db, "f1").status, "active");
  } finally {
    await up.close();
  }
});

Deno.test("settle failure on a release (non-2xx): stored cost zeroed, the sweep refunds", async () => {
  const up = fakeUpstream(() => new Response("no", { status: 503 }));
  try {
    const db = new FakeDb(1e9);
    db.settleFailures = Infinity;
    const logs: Logged = [];
    await (
      await handler(
        db,
        up.baseUrl,
        {},
        logs,
      )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "f2" }))
    ).json();
    assertEquals(db.stored.get("f2")?.credits, 0);
    assertEquals(logs.at(-1)?.cost_stored, false);
  } finally {
    await up.close();
  }
});

const CLAUDE_MODEL = {
  ...GLM,
  id: "anthropic/claude-test",
  provider: "anthropic",
  upstreamId: "claude-test",
  enableGroups: ["claude"],
  upstreamGroup: "claude" as const,
};

Deno.test("upstream key: the model's own vibi group key, 503 when missing, never another group's", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const paid = () => new FakeDb(1e9, { plan: "pro", allowedModels: null });
    const both = routerConfig(up.baseUrl, {
      keys: { "model - china": "k-china", claude: "k-claude" },
    });
    const catalog = [FLASH, GLM, CLAUDE_MODEL];
    for (const [model, key] of [
      [FLASH.id, "Bearer k-china"],
      [CLAUDE_MODEL.id, "Bearer k-claude"],
    ]) {
      const res = await handler(paid(), up.baseUrl, { config: both, catalog })(
        completionRequest(
          { model, messages: MESSAGES },
          { key: `g-${key.length}-${model.length}` },
        ),
      );
      assertEquals(res.status, 200);
      await res.json();
      assertEquals(up.seen.at(-1)?.headers.get("authorization"), key);
    }
    const calls = up.seen.length;
    for (const [model, keys] of [
      [CLAUDE_MODEL.id, { "model - china": "k-china", "codex pro": "k-pro" }],
      [FLASH.id, { claude: "k-claude", "codex plus": "k-plus" }],
    ] as const) {
      const db = paid();
      const res = await handler(db, up.baseUrl, {
        config: routerConfig(up.baseUrl, { keys }),
        catalog,
      })(completionRequest({ model, messages: MESSAGES }, { key: "g-missing" }));
      assertEquals(await errorOf(res), { status: 503, error: "provider_not_configured" });
      assertEquals(db.claims.size, 0, "checked before the Idempotency-Key is claimed");
      assertEquals(db.reservations.size, 0);
    }
    assertEquals(up.seen.length, calls, "no request went out with another group's key");
  } finally {
    await up.close();
  }
});

Deno.test("cost is stored BEFORE the upstream fetch (prompt estimate, capped)", async () => {
  const db = new FakeDb(1e9);
  let storedAtFetch: number | undefined;
  const up = fakeUpstream(() => {
    storedAtFetch = db.stored.get("pre1")?.credits;
    return okCompletion({ prompt_tokens: 5, completion_tokens: 2 });
  });
  try {
    const res = await handler(
      db,
      up.baseUrl,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "pre1" }));
    await res.json();
    assertGreater(promptOnly(), 0);
    assertEquals(storedAtFetch, promptOnly(), "minimum cost stored before the fetch");
    assertEquals(db.storeHistory[0].requestId, "pre1");
    assertEquals(
      [db.storeHistory[0].inputTokens, db.storeHistory[0].outputTokens],
      [PROMPT_TOKENS, 0],
    );
  } finally {
    await up.close();
  }
});

Deno.test("killed worker: the stored cost is refreshed while streaming and the sweep charges it", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = fakeUpstream(() => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 4; i++) {
            controller.enqueue(
              enc.encode(
                sse([{ choices: [{ delta: { content: "k".repeat(400) } }] }], { done: false }),
              ),
            );
            await new Promise((r) => setTimeout(r, 30));
          }
          await hold; // the worker is "killed" here: no final usage, no settle
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const db = new FakeDb(1e9);
    const later: Promise<unknown>[] = [];
    const res = await handler(db, up.baseUrl, {
      waitUntil: (p) => later.push(p),
      limits: { progressIntervalMs: 20 },
    })(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, stream: true, max_tokens: 5000 },
        { key: "kill1" },
      ),
    );
    const reader = bodyOf(res).getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    await Promise.all(later);
    const credits = db.storeHistory.filter((s) => s.requestId === "kill1").map((s) => s.credits);
    assertEquals(credits[0], promptOnly(), "first store: before the fetch");
    assertGreater(credits.length, 2, `periodic updates: ${credits}`);
    for (let i = 1; i < credits.length; i++) assertGreater(credits[i], credits[i - 1]);
    const last = db.stored.get("kill1");
    assertEquals(last?.inputTokens, PROMPT_TOKENS);
    assertGreater(last?.outputTokens ?? 0, 0);
    // Worker dies (wall clock): reservation still active, the sweep charges the stored cost.
    const r = reservationOf(db, "kill1");
    assertEquals(r.status, "active");
    db.sweep();
    assertEquals(r.charged, Math.min(last?.credits ?? -1, r.amount));
    assertLessOrEqual(chargedOf(r), r.amount);
    release();
    await reader.cancel().catch(() => {});
    await drainAll(later);
  } finally {
    release?.();
    await up.close();
  }
});

Deno.test("rejected by the upstream (non-2xx / unreachable): stored cost zeroed, sweep charges nothing", async () => {
  const up = fakeUpstream(() => new Response("no", { status: 500 }));
  try {
    for (const base of [up.baseUrl, "http://127.0.0.1:1/v1"]) {
      const db = new FakeDb(5000);
      db.settleFailures = Infinity; // settle never lands: only the sweep is left
      const res = await handler(db, base, { config: routerConfig(base) })(
        completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "rej" }),
      );
      assertEquals(res.status, 502);
      await res.body?.cancel();
      assertEquals(db.storeHistory[0].credits, promptOnly(), "minimum stored before the fetch");
      assertEquals(db.stored.get("rej")?.credits, 0, "zeroed by the release");
      db.sweep();
      assertEquals(reservationOf(db, "rej").charged, 0);
      assertEquals(db.balance, 5000);
    }
  } finally {
    await up.close();
  }
});

Deno.test("GET /v1/models: the table with allowed per plan", async () => {
  const db = new FakeDb();
  const h = handler(db, "http://x");
  const req = new Request("http://localhost/model-router/v1/models", {
    headers: { authorization: "Bearer user.jwt.token" },
  });
  const body = await (await h(req)).json();
  assertEquals(body.plan, "free");
  assertEquals(
    body.data.map((m: { id: string; allowed: boolean }) => [m.id, m.allowed]),
    [
      [FLASH.id, true],
      [GLM.id, true],
      [PAID.id, false],
    ],
  );
  db.plan = { plan: "pro", allowedModels: null };
  const pro = await (await h(req)).json();
  assert(pro.data.every((m: { allowed: boolean }) => m.allowed));
});
