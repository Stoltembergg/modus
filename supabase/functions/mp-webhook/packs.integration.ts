/**
 * L5a credit packs against the REAL migrated Postgres (supabase/tests/run.sh): the real
 * mp-webhook handler + createPostgresBillingDb with a fake Mercado Pago API (never the real
 * one), then the real model-router handler + createPostgresRouterDb. A purchase payment is
 * credited once into a lot, unlocks the pack's access plan, and router usage consumes the
 * allowance first, then the lot; a refund takes back only the lot; a chargeback blocks.
 * Not a *.test.ts (needs the cluster).
 */
import { assertEquals, assertGreater } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { MODEL_CATALOG } from "../_shared/model-catalog.ts";
import type { MpApi, MpPayment } from "../_shared/mp.ts";
import { hmacSha256Hex, mpManifest } from "../_shared/mp-signature.ts";
import { createPostgresRouterDb } from "../_shared/router-db.ts";
import { createRouterHandler } from "../model-router/handler.ts";
import { completionRequest, fakeUpstream, routerConfig, sse } from "../model-router/test-fakes.ts";
import { createMpWebhookHandler } from "./handler.ts";

const dbUrl = Deno.env.get("MODUS_TEST_DB_URL");
const SECRET = "integration-webhook-secret";
const EXPECT = { liveMode: false as const, collectorId: "777" };
const PAID = "deepseek/deepseek-v4-pro";

Deno.test({
  name: "L5a credit packs against a real Postgres: webhook -> lot -> router access -> allowance then lot -> refund / chargeback",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    const billing = createPostgresBillingDb(dbUrl ?? "");
    const routerDb = createPostgresRouterDb(dbUrl ?? "");
    const up = fakeUpstream(async (seen) => {
      await Promise.resolve();
      const head = { id: "x", object: "chat.completion.chunk", created: 1, model: seen.body.model };
      return new Response(
        sse([
          { ...head, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
          { ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...head, choices: [], usage: { prompt_tokens: 400, completion_tokens: 200 } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      const [{ id: userId }] =
        await admin`select tests.create_user('packs-it@example.com', true) as id`;
      const state = async () => {
        const [w] =
          await admin`select balance, reserved from public.credit_wallets where user_id = ${userId}`;
        const lots = await admin`select remaining from public.credit_lots where user_id = ${userId}
                      order by created_at, id`;
        return `${w.balance}+${w.reserved}|${lots.map((l) => String(l.remaining)).join(",")}`;
      };

      const payments = new Map<string, MpPayment>();
      const api: Pick<MpApi, "getPreapproval" | "getAuthorizedPayment" | "getPayment"> = {
        getPreapproval: () => Promise.reject(new Error("not used here")),
        getAuthorizedPayment: () => Promise.reject(new Error("not used here")),
        getPayment: (id) => {
          const p = payments.get(id);
          if (!p) throw new Error(`fake MP: unknown payment ${id}`);
          return Promise.resolve(structuredClone(p));
        },
      };
      const webhook = createMpWebhookHandler({
        api,
        db: billing,
        secret: SECRET,
        expect: EXPECT,
        now: () => Date.now(),
      });
      const notify = async (dataId: string, requestId: string) => {
        const ts = String(Date.now());
        const sig = await hmacSha256Hex(SECRET, mpManifest(dataId, requestId, ts));
        const res = await webhook(
          new Request(`http://localhost/mp-webhook?data.id=${dataId}&type=payment`, {
            method: "POST",
            headers: { "x-request-id": requestId, "x-signature": `ts=${ts},v1=${sig}` },
            body: JSON.stringify({ type: "payment", data: { id: dataId } }),
          }),
        );
        return { status: res.status, code: (await res.json()).code };
      };

      // Free user: Free models only.
      assertEquals((await routerDb.getPlan(userId)).plan, "free");

      // Purchase (L5b's mp-buy-credits creates it the same way), approved payment.
      const [{ r: purchase }] =
        await admin`select private.mp_create_purchase(${userId}, 'credits_5k') as r`;
      assertEquals(
        [purchase.code, purchase.credits, purchase.amount_minor],
        ["created", 5000, 3690],
      );
      const pay: MpPayment = {
        id: "660001",
        status: "approved",
        status_detail: "accredited",
        amount_minor: 3690,
        refunded_minor: 0,
        live_mode: false,
        collector_id: "777",
        currency: "BRL",
        external_reference: purchase.purchase_id,
      };
      payments.set(pay.id, pay);
      assertEquals(await notify(pay.id, "pk-1"), { status: 200, code: "credited" });
      assertEquals(await notify(pay.id, "pk-1"), { status: 200, code: "duplicate" });
      assertEquals(await notify(pay.id, "pk-2"), { status: 200, code: "already_credited" });
      assertEquals(await state(), "6000+0|5000");

      // A subscription payment (no purchase reference) still goes the subscription path.
      payments.set("660009", { ...pay, id: "660009", external_reference: null });
      assertEquals((await notify("660009", "pk-sub")).code, "unlinked");

      // The lot unlocks the pack's access plan (starter: every model).
      assertEquals(await routerDb.getPlan(userId), { plan: "starter", allowedModels: null });
      const h = createRouterHandler({
        db: routerDb,
        getUser: () => Promise.resolve({ id: userId as string, email: null }),
        config: routerConfig(up.baseUrl),
        catalog: [...MODEL_CATALOG, { ...MODEL_CATALOG[0], id: PAID, upstreamId: "pro" }],
        log: () => {},
      });
      const call = async (model: string, key: string) => {
        const res = await h(
          completionRequest({ model, messages: [{ role: "user", content: "hi" }] }, { key }),
        );
        await res.text();
        return res.status;
      };

      // Usage is charged from the allowance (1000) first: the lot is untouched.
      assertEquals(await call(PAID, "pk-call-1"), 200);
      const afterFirst = await state();
      assertEquals(afterFirst.endsWith("|5000"), true, `lot untouched: ${afterFirst}`);

      // Allowance spent (balance = lot only): the next call consumes the lot.
      await admin`update public.credit_wallets set balance = 5000 where user_id = ${userId}`;
      assertEquals(await state(), "5000+0|5000");
      assertEquals(await call(PAID, "pk-call-2"), 200);
      const used = 5000 - Number((await state()).split("+")[0]);
      assertGreater(used, 0);
      assertEquals(await state(), `${5000 - used}+0|${5000 - used}`);

      // Partial refund (50%): only this lot, capped at what is left.
      payments.set(pay.id, { ...pay, refunded_minor: 1845 });
      assertEquals((await notify(pay.id, "pk-3")).code, "reversed");
      assertEquals(await state(), `${2500 - used}+0|${2500 - used}`);

      // Chargeback: the rest of the lot, account blocked, Free models only.
      payments.set(pay.id, { ...pay, status: "charged_back", refunded_minor: 3690 });
      assertEquals((await notify(pay.id, "pk-4")).code, "reversed");
      assertEquals(await state(), "0+0|0");
      const [{ shortfall, status }] =
        await admin`select l.shortfall, cp.status from public.credit_lots l
                      join public.credit_purchases cp on cp.id = l.purchase_id
                     where l.payment_id = ${Number(pay.id)}`;
      assertEquals([Number(shortfall), status], [used, "charged_back"]);
      assertEquals((await routerDb.getPlan(userId)).plan, "free");
    } finally {
      await up.close();
      await admin.end();
    }
  },
});

Deno.test({
  name: "L5a review: the same purchase paid twice -> two lots via the webhook; a pro (25k) lot unlocks Fable, a starter lot does not",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    const billing = createPostgresBillingDb(dbUrl ?? "");
    const routerDb = createPostgresRouterDb(dbUrl ?? "");
    const FABLE = "anthropic/claude-fable-5";
    const up = fakeUpstream(async (seen) => {
      await Promise.resolve();
      const head = { id: "x", object: "chat.completion.chunk", created: 1, model: seen.body.model };
      return new Response(
        sse([
          { ...head, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
          { ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...head, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    // Fable as a premium model: Starter lists the non-premium models, Pro keeps all (null).
    const [{ allowed: starterBefore }] =
      await admin`select allowed_models as allowed from public.plans where plan = 'starter'`;
    try {
      await admin`update public.plans
                     set allowed_models = array['deepseek/deepseek-flash', 'zai/glm-5.3-flash']
                   where plan = 'starter'`;
      const [{ id: userId }] =
        await admin`select tests.create_user('packs-fable@example.com', true) as id`;
      const h = createRouterHandler({
        db: routerDb,
        getUser: () => Promise.resolve({ id: userId as string, email: null }),
        config: routerConfig(up.baseUrl),
        catalog: [...MODEL_CATALOG, { ...MODEL_CATALOG[0], id: FABLE, upstreamId: "fable" }],
        log: () => {},
      });
      const call = async (key: string) => {
        const res = await h(
          completionRequest({ model: FABLE, messages: [{ role: "user", content: "hi" }] }, { key }),
        );
        const body = await res.json();
        return [res.status, res.status === 200 ? body.model : body.error];
      };
      const pay = (id: string, ref: string, amount: number): MpPayment => ({
        id,
        status: "approved",
        status_detail: "accredited",
        amount_minor: amount,
        refunded_minor: 0,
        live_mode: false,
        collector_id: "777",
        currency: "BRL",
        external_reference: ref,
      });

      // Starter (5k) lot: Fable not in the plan.
      const [{ r: p5 }] =
        await admin`select private.mp_create_purchase(${userId}, 'credits_5k') as r`;
      const first = pay("690001", p5.purchase_id, 3690);
      assertEquals((await billing.processMpPurchasePayment(first, EXPECT, null)).code, "credited");
      assertEquals((await routerDb.getPlan(userId)).plan, "starter");
      assertEquals(await call("fable-starter"), [403, "model_not_in_plan"]);

      // The same purchase paid again (same preference): a second lot, credited once.
      const second = pay("690002", p5.purchase_id, 3690);
      const again = await billing.processMpPurchasePayment(second, EXPECT, null);
      assertEquals([again.code, again.additional], ["credited", true]);
      assertEquals(
        (await billing.processMpPurchasePayment(second, EXPECT, null)).code,
        "already_credited",
      );
      const lots =
        await admin`select payment_id from public.credit_lots where purchase_id = ${p5.purchase_id}
                    order by payment_id`;
      assertEquals(
        lots.map((l) => Number(l.payment_id)),
        [690001, 690002],
      );

      // Pro (25k) lot: Fable unlocked.
      const [{ r: p25 }] =
        await admin`select private.mp_create_purchase(${userId}, 'credits_25k') as r`;
      const big = pay("690003", p25.purchase_id, 18090);
      assertEquals((await billing.processMpPurchasePayment(big, EXPECT, null)).code, "credited");
      assertEquals(await routerDb.getPlan(userId), { plan: "pro", allowedModels: null });
      assertEquals(await call("fable-pro"), [200, FABLE]);

      // The pro lot refunded in full: back to the starter lots, Fable refused again.
      const refunded = { ...big, status: "refunded", refunded_minor: 18090 };
      assertEquals(
        (await billing.processMpPurchasePayment(refunded, EXPECT, null)).code,
        "reversed",
      );
      assertEquals((await routerDb.getPlan(userId)).plan, "starter");
      assertEquals(await call("fable-after-refund"), [403, "model_not_in_plan"]);
    } finally {
      await admin`update public.plans set allowed_models = ${starterBefore} where plan = 'starter'`;
      await up.close();
      await admin.end();
    }
  },
});
