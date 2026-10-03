// Router behind a REAL Deno.serve (ephemeral port), as in production. Deno.serve's legacy
// behavior aborts request.signal after a SUCCESSFUL response too, so these prove that a
// fully delivered response settles as `complete` (never `client_disconnect`), and that a
// real client disconnect still settles with the upstream's final usage (billing rule A).
import { assertEquals, assertLessOrEqual } from "jsr:@std/assert@1";
import type { AuthenticatedUser } from "../_shared/auth.ts";
import { USER } from "../_shared/test-helpers.ts";
import { createRouterHandler } from "./handler.ts";
import { creditsFor, parseCreditMarkup } from "./pricing.ts";
import { FakeDb, FLASH, fakeUpstream, GLM, routerConfig, sse } from "./test-fakes.ts";

const M125 = parseCreditMarkup({ get: () => undefined });
const MESSAGES = [{ role: "user", content: "hello there" }];
const USAGE = { prompt_tokens: 11, completion_tokens: 222 };
const CHARGE = creditsFor(
  FLASH,
  { promptTokens: 11, cachedTokens: 0, completionTokens: 222 },
  M125,
);
type Logged = Record<string, unknown>[];

function serveRouter(db: FakeDb, upstreamBase: string) {
  const logs: Logged = [];
  const later: Promise<unknown>[] = [];
  const handler = createRouterHandler({
    db,
    getUser: () => Promise.resolve(USER as AuthenticatedUser),
    config: routerConfig(upstreamBase),
    catalog: [FLASH, GLM],
    log: (event) => logs.push(event),
    waitUntil: (p) => later.push(p),
  });
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}/model-router/v1/chat/completions`,
    logs,
    /** Waits for the settlement log line of `key`. */
    async settled(key: string): Promise<Record<string, unknown>> {
      for (let i = 0; i < 400; i++) {
        const hit = logs.find(
          (l) => l.request_id === key && String(l.event).startsWith("model_router.settle"),
        );
        if (hit) {
          await Promise.all(later);
          return hit;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`no settlement for ${key}`);
    },
    close: () => server.shutdown(),
  };
}

const post = (url: string, key: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer user.jwt.token",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
    signal,
  });

function streamingUpstream(hold?: Promise<void>) {
  return fakeUpstream(() => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            enc.encode(sse([{ choices: [{ delta: { content: "hi" } }] }], { done: false })),
          );
          if (hold) await hold;
          controller.enqueue(enc.encode(sse([{ choices: [], usage: USAGE }])));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
}

Deno.test("real Deno.serve: a fully delivered stream settles as complete", async () => {
  const up = streamingUpstream();
  const db = new FakeDb(1e9);
  const router = serveRouter(db, up.baseUrl);
  try {
    const res = await post(router.url, "s1", { model: FLASH.id, messages: MESSAGES, stream: true });
    assertEquals(res.status, 200);
    const text = await res.text();
    assertEquals(text.includes("[DONE]"), true);
    const log = await router.settled("s1");
    // Give the legacy request.signal abort time to fire: it must not change anything.
    await new Promise((r) => setTimeout(r, 50));
    assertEquals([log.event, log.outcome], ["model_router.settled", "complete"]);
    assertEquals(db.reservations.get("s1")?.charged, CHARGE);
    assertEquals(db.settles.length, 1);
    assertEquals(router.logs.filter((l) => l.outcome === "client_disconnect").length, 0);
  } finally {
    await router.close();
    await up.close();
  }
});

Deno.test("real Deno.serve: a fully delivered non-stream settles as complete", async () => {
  const up = streamingUpstream();
  const db = new FakeDb(1e9);
  const router = serveRouter(db, up.baseUrl);
  try {
    const res = await post(router.url, "n1", { model: FLASH.id, messages: MESSAGES });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).usage, USAGE);
    const log = await router.settled("n1");
    await new Promise((r) => setTimeout(r, 50));
    assertEquals([log.event, log.outcome], ["model_router.settled", "complete"]);
    assertEquals(db.reservations.get("n1")?.charged, CHARGE);
    assertEquals(db.settles.length, 1);
  } finally {
    await router.close();
    await up.close();
  }
});

Deno.test("real Deno.serve: a real client disconnect mid-stream still pays the final usage", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = streamingUpstream(hold);
  const db = new FakeDb(1e9);
  const router = serveRouter(db, up.baseUrl);
  try {
    const abort = new AbortController();
    const res = await post(
      router.url,
      "d1",
      { model: FLASH.id, messages: MESSAGES, stream: true },
      abort.signal,
    );
    const reader = res.body?.getReader();
    await reader?.read();
    abort.abort();
    await reader?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    release();
    const log = await router.settled("d1");
    assertEquals(log.outcome, "client_disconnect");
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [11, 222]);
    const r = db.reservations.get("d1");
    assertEquals(r?.charged, CHARGE);
    assertLessOrEqual(CHARGE, r?.amount ?? 0);
  } finally {
    release?.();
    await router.close();
    await up.close();
  }
});

Deno.test("real Deno.serve: a client that drops a slow non-stream request still pays the full response", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const up = fakeUpstream(async () => {
    await hold;
    return new Response(
      sse([{ choices: [{ index: 0, delta: { content: "late" } }] }, { choices: [], usage: USAGE }]),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const db = new FakeDb(1e9);
  const router = serveRouter(db, up.baseUrl);
  try {
    const abort = new AbortController();
    const pending = post(router.url, "d2", { model: FLASH.id, messages: MESSAGES }, abort.signal);
    for (let i = 0; i < 200 && up.seen.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(db.reservations.get("d2")?.status, "active", "upstream still running");
    release();
    const log = await router.settled("d2");
    assertEquals(log.event, "model_router.settled");
    assertEquals([db.settles[0].inputTokens, db.settles[0].outputTokens], [11, 222]);
    assertEquals(db.reservations.get("d2")?.charged, CHARGE);
  } finally {
    release?.();
    await router.close();
    await up.close();
  }
});
