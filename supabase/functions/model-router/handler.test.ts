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
  });
}

const okCompletion = (usage: unknown) =>
  Response.json({
    id: "cmpl",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "hi!" } }],
    ...(usage === undefined ? {} : { usage }),
  });

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
    [routerConfig("http://x", { apiKey: "" }), "provider_not_configured"],
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
  const up = fakeUpstream((seen) =>
    seen.body.stream
      ? new Response(
          sse([
            { choices: [{ delta: { content: "hi" } }] },
            { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } },
          ]),
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      : okCompletion({ prompt_tokens: 9, completion_tokens: 1 }),
  );
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
    assertEquals(plain.body, {
      model: "deepseek-v4.1-flash",
      messages: MESSAGES,
      temperature: 0.2,
      max_tokens: FLASH.maxTokens,
      stream: false,
    });
    assertEquals(streamed.body.model, "glm-5.3-flash");
    assertEquals(
      streamed.body.max_tokens,
      GLM.maxTokens,
      "absent max_tokens is set to the model cap",
    );
    assertEquals(streamed.body.stream_options, { include_usage: true });
    for (const seen of up.seen) {
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

Deno.test("client disconnect mid-stream: upstream aborted, partial settled, never above reserved", async () => {
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
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const db = new FakeDb(1e9);
    const settled: Promise<unknown>[] = [];
    const res = await handler(db, up.baseUrl, { waitUntil: (p) => settled.push(p) })(
      completionRequest(
        { model: FLASH.id, messages: MESSAGES, stream: true, max_tokens: 500 },
        { key: "x1" },
      ),
    );
    const reader = bodyOf(res).getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(settled);
    const r = reservationOf(db, "x1");
    assertEquals(r.status, "settled");
    assertEquals(db.settles[0].outputTokens, estimateOutputTokens(40));
    assertGreater(chargedOf(r), 0);
    assertLessOrEqual(chargedOf(r), r.amount);
    for (let i = 0; i < 50 && up.aborted() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assertEquals(up.aborted(), 1, "the upstream request was aborted");
    release();
  } finally {
    release?.();
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

Deno.test("stream: upstream headers timeout -> 504 and full release", async () => {
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
    assertEquals(reservationOf(db, "t1").charged, 0);
    assertEquals(db.balance, 5000);
    await new Promise((r) => setTimeout(r, 450));
  } finally {
    await up.close();
  }
});

Deno.test("non-stream: a slow upstream is bounded by the total cap, not the headers timeout", async () => {
  const up = fakeUpstream(async () => {
    await new Promise((r) => setTimeout(r, 150));
    return okCompletion({ prompt_tokens: 3, completion_tokens: 2 });
  });
  try {
    const db = new FakeDb(5000);
    const slow = await handler(db, up.baseUrl, { limits: { headersTimeoutMs: 20 } })(
      completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "t2" }),
    );
    assertEquals(slow.status, 200);
    await slow.json();
    const capped = await handler(db, up.baseUrl, { limits: { streamCapMs: 30 } })(
      completionRequest({ model: FLASH.id, messages: MESSAGES, max_tokens: 100 }, { key: "t3" }),
    );
    assertEquals(await errorOf(capped), { status: 504, error: "upstream_timeout" });
    assertEquals(chargedOf(reservationOf(db, "t3")), 0);
    await new Promise((r) => setTimeout(r, 200));
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
    const res = await handler(db, up.baseUrl, { limits: { streamCapMs: 100 } })(
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
    assertLessOrEqual(chargedOf(r), r.amount);
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

Deno.test("a settle failure is logged without content; the reservation is left for the sweep", async () => {
  const up = fakeUpstream(() => okCompletion({ prompt_tokens: 5, completion_tokens: 2 }));
  try {
    const db = new FakeDb(1e9);
    db.settleError = true;
    const logs: Logged = [];
    const res = await handler(
      db,
      up.baseUrl,
      {},
      logs,
    )(completionRequest({ model: FLASH.id, messages: MESSAGES }, { key: "f1" }));
    assertEquals(res.status, 200);
    await res.json();
    assertEquals(logs.at(-1)?.event, "model_router.settle_failed");
    assertEquals(reservationOf(db, "f1").status, "active");
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
