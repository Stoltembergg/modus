/**
 * model-router against the REAL migrated Postgres (supabase/tests/run.sh, CI job
 * "supabase · pgTAP · integration"): the real handler + createPostgresRouterDb, a
 * fake OpenAI-compatible upstream on 127.0.0.1. Not a *.test.ts (needs the cluster).
 */
import { assert, assertEquals, assertGreater, assertLessOrEqual } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { MODEL_CATALOG } from "../_shared/model-catalog.ts";
import { createPostgresRouterDb } from "../_shared/router-db.ts";
import { createRouterHandler } from "./handler.ts";
import { creditsFor, parseCreditMarkup } from "./pricing.ts";
import { completionRequest, fakeUpstream, routerConfig, sse } from "./test-fakes.ts";

const dbUrl = Deno.env.get("MODUS_TEST_DB_URL");
const FLASH = "deepseek/deepseek-flash";
const MESSAGES = [{ role: "user", content: "integration prompt" }];
const M125 = parseCreditMarkup({ get: () => undefined });

Deno.test({
  name: "model-router against a real Postgres: reserve / settle / release, 403, 402, 409, no orphans",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false });
    let mode: "ok" | "fail" | "stream-partial" = "ok";
    let release: (() => void) | undefined;
    const up = fakeUpstream(async (seen) => {
      if (mode === "fail") return new Response("boom", { status: 503 });
      if (mode === "stream-partial") {
        const hold = new Promise<void>((r) => (release = r));
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                enc.encode(
                  sse([{ choices: [{ delta: { content: "w".repeat(40) } }] }], { done: false }),
                ),
              );
              await hold;
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      await Promise.resolve();
      return Response.json({
        id: "x",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 80,
          prompt_tokens_details: { cached_tokens: 20 },
        },
        model: seen.body.model,
      });
    });
    const db = createPostgresRouterDb(dbUrl ?? "");
    try {
      const [{ id: userId }] =
        await admin`select tests.create_user('router-it@example.com', true) as id`;
      const user = { id: userId as string, email: null };
      const settled: Promise<unknown>[] = [];
      const h = createRouterHandler({
        db,
        getUser: () => Promise.resolve(user),
        config: routerConfig(up.baseUrl),
        catalog: MODEL_CATALOG,
        waitUntil: (p) => settled.push(p),
        log: () => {},
      });
      const wallet = async () => {
        const [w] =
          await admin`select balance, reserved from public.credit_wallets where user_id = ${userId}`;
        return { balance: Number(w.balance), reserved: Number(w.reserved) };
      };
      const reservation = async (key: string) =>
        (
          await admin`select amount, settled_amount, status from public.credit_reservations
                       where user_id = ${userId} and request_id = ${key}`
        )[0];

      // Seeded allowed_models are all in the server table (real DB after every migration).
      const plans =
        await admin`select plan, allowed_models from public.plans where allowed_models is not null`;
      for (const plan of plans) {
        for (const id of plan.allowed_models as string[]) {
          assert(
            MODEL_CATALOG.some((m) => m.id === id),
            `${plan.plan}: ${id} not in the model table`,
          );
        }
      }
      assertEquals((await db.getPlan(userId)).allowedModels, [FLASH, "zai/glm-5.3-flash"]);
      assertEquals(await wallet(), { balance: 1000, reserved: 0 });

      // 1) Success: reserve, upstream, settle the real usage; the rest goes back.
      const ok = await h(
        completionRequest({ model: FLASH, messages: MESSAGES, max_tokens: 2000 }, { key: "it-ok" }),
      );
      assertEquals(ok.status, 200);
      assertEquals((await ok.json()).model, "deepseek-v4.1-flash");
      const charged = creditsFor(
        MODEL_CATALOG[0],
        { promptTokens: 120, cachedTokens: 20, completionTokens: 80 },
        M125,
      );
      const r1 = await reservation("it-ok");
      assertEquals(r1.status, "settled");
      assertEquals(Number(r1.settled_amount), charged);
      assertEquals(await wallet(), { balance: 1000 - charged, reserved: 0 });
      const [usage] =
        await admin`select model, provider, input_tokens, output_tokens, credits, status
                                    from public.usage_events where user_id = ${userId} and request_id = 'it-ok'`;
      assertEquals(
        { ...usage, credits: Number(usage.credits) },
        {
          model: FLASH,
          provider: "deepseek",
          input_tokens: 120,
          output_tokens: 80,
          credits: charged,
          status: "billed",
        },
      );
      let balance = 1000 - charged;

      // 2) Repeated key: 409 replay / conflict, nothing else happens.
      const replay = await h(
        completionRequest({ model: FLASH, messages: MESSAGES, max_tokens: 2000 }, { key: "it-ok" }),
      );
      assertEquals([replay.status, (await replay.json()).error], [409, "idempotency_replay"]);
      const conflict = await h(completionRequest({ model: FLASH, messages: [] }, { key: "it-ok" }));
      assertEquals([conflict.status, (await conflict.json()).error], [409, "idempotency_conflict"]);
      assertEquals(up.seen.length, 1);

      // 3) Model not in the Free plan -> 403 BEFORE reserving: no reservation row, balance intact.
      const blocked = await h(
        completionRequest({ model: "openai/gpt-6-luna", messages: MESSAGES }, { key: "it-404" }),
      );
      assertEquals(blocked.status, 404);
      const notInPlan = createRouterHandler({
        db,
        getUser: () => Promise.resolve(user),
        config: routerConfig(up.baseUrl),
        catalog: [
          ...MODEL_CATALOG,
          { ...MODEL_CATALOG[0], id: "deepseek/deepseek-v4-pro", upstreamId: "pro" },
        ],
        log: () => {},
      });
      const forbidden = await notInPlan(
        completionRequest(
          { model: "deepseek/deepseek-v4-pro", messages: MESSAGES },
          { key: "it-403" },
        ),
      );
      assertEquals([forbidden.status, (await forbidden.json()).error], [403, "model_not_in_plan"]);
      assertEquals(await reservation("it-403"), undefined, "403: no reservation row");
      assertEquals(await wallet(), { balance, reserved: 0 });

      // 4) Upstream failure: full release.
      mode = "fail";
      const failed = await h(
        completionRequest(
          { model: FLASH, messages: MESSAGES, max_tokens: 500 },
          { key: "it-fail" },
        ),
      );
      assertEquals(failed.status, 502);
      await failed.body?.cancel();
      const rf = await reservation("it-fail");
      assertEquals([rf.status, Number(rf.settled_amount)], ["settled", 0]);
      assertEquals(await wallet(), { balance, reserved: 0 });

      // 5) Stream cut by the client: the upstream is drained under waitUntil and the
      //    estimate of everything it sent is settled, capped at the reservation.
      mode = "stream-partial";
      const stream = await h(
        completionRequest(
          { model: FLASH, messages: MESSAGES, stream: true, max_tokens: 500 },
          { key: "it-cut" },
        ),
      );
      if (!stream.body) throw new Error("no stream body");
      const reader = stream.body.getReader();
      await reader.read();
      await reader.cancel();
      release?.();
      for (let seen = -1; seen !== settled.length; ) {
        seen = settled.length;
        await Promise.all(settled);
      }
      const rc = await reservation("it-cut");
      assertEquals(rc.status, "settled");
      assertGreater(Number(rc.settled_amount), 0);
      assertLessOrEqual(Number(rc.settled_amount), Number(rc.amount));
      balance -= Number(rc.settled_amount);
      assertEquals(await wallet(), { balance, reserved: 0 });
      mode = "ok";

      // 6) 402: not even the minimum output fits; nothing reserved, upstream untouched.
      await admin`update public.credit_wallets set balance = 1 where user_id = ${userId}`;
      const calls = up.seen.length;
      const poor = await h(
        completionRequest({ model: FLASH, messages: MESSAGES }, { key: "it-402" }),
      );
      assertEquals([poor.status, (await poor.json()).error], [402, "insufficient_credits"]);
      assertEquals(await reservation("it-402"), undefined);
      assertEquals(up.seen.length, calls);

      // 7) Concurrency: 6 calls at once on a small wallet never go negative or past 4 active.
      await admin`update public.credit_wallets set balance = 600 where user_id = ${userId}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          h(
            completionRequest(
              { model: FLASH, messages: MESSAGES, max_tokens: 30000 },
              { key: `it-par-${i}` },
            ),
          ).then(async (res) => {
            await res.body?.cancel();
            return res.status;
          }),
        ),
      );
      assert(
        results.every((s) => [200, 402, 429].includes(s)),
        results.join(","),
      );
      assert(results.includes(200), results.join(","));
      const after = await wallet();
      assert(after.balance >= 0);
      assertEquals(after.reserved, 0);

      // 8) Settle kept failing -> router_store_cost; the expiry sweep charges the stored cost.
      await admin`update public.credit_wallets set balance = 1000 where user_id = ${userId}`;
      assertEquals(await db.claimRequest(userId, "it-store", "a".repeat(64)), "claimed");
      await db.reserve(userId, "it-store", 300, 4);
      const stored = await db.storeCost({
        userId,
        requestId: "it-store",
        credits: 120,
        model: FLASH,
        provider: "deepseek",
        inputTokens: 50,
        outputTokens: 40,
      });
      assert(stored, "cost stored on the router_requests row");
      await admin`update public.credit_reservations set expires_at = now() - interval '1 second'
                   where user_id = ${userId} and request_id = 'it-store'`;
      await admin`select private.release_expired_reservations(${userId}::uuid)`;
      const rs = await reservation("it-store");
      assertEquals([rs.status, Number(rs.settled_amount)], ["settled", 120]);
      assertEquals(await wallet(), { balance: 880, reserved: 0 });

      // No orphan reservation anywhere for this user.
      const [{ active }] =
        await admin`select count(*)::int as active from public.credit_reservations
                                        where user_id = ${userId} and status = 'active'`;
      assertEquals(active, 0, "no orphan reservation");
      const [{ over }] = await admin`select count(*)::int as over from public.credit_reservations
                                      where user_id = ${userId} and settled_amount > amount`;
      assertEquals(over, 0, "never charged above the reservation");
    } finally {
      release?.();
      await up.close();
      await admin.end();
    }
  },
});
