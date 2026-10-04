/**
 * L5a credit packs against the REAL migrated Postgres (supabase/tests/run.sh): the real
 * mp-webhook handler + createPostgresBillingDb with a fake Mercado Pago API (never the real
 * one), then the real model-router handler + createPostgresRouterDb. A purchase payment is
 * credited once into a lot, unlocks the pack's access plan, and router usage consumes the
 * allowance first, then the lot; a refund takes back only the lot; a chargeback blocks.
 * Not a *.test.ts (needs the cluster).
 */
import { assert, assertEquals, assertGreater } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { MODEL_CATALOG } from "../_shared/model-catalog.ts";
import type { CreatePreferenceInput, MpApi, MpPayment } from "../_shared/mp.ts";
import { hmacSha256Hex, mpManifest } from "../_shared/mp-signature.ts";
import { createPostgresRouterDb } from "../_shared/router-db.ts";
import { URLS } from "../_shared/test-helpers.ts";
import { createRouterHandler } from "../model-router/handler.ts";
import { completionRequest, fakeUpstream, routerConfig, sse } from "../model-router/test-fakes.ts";
import { createMpBuyCreditsHandler, mpNotificationUrl } from "../mp-buy-credits/handler.ts";
import { createMpWebhookHandler } from "./handler.ts";

const dbUrl = Deno.env.get("MODUS_TEST_DB_URL");
const SECRET = "integration-webhook-secret";
const EXPECT = { liveMode: false as const, collectorId: "777" };
const PAID = "deepseek/deepseek-v4-pro";
const FLASH = "deepseek/deepseek-flash";
const FREE_MODELS = [FLASH, "zai/glm-5.3-flash"];
// L5c: Starter = the Free models + Claude Opus 5.5 (provisional); claude-fable-* is Pro+.
const STARTER_MODELS = [...FREE_MODELS, "anthropic/claude-opus-5-5"];

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

      // The lot unlocks the pack's access plan (starter: its explicit list, L5a review 2).
      assertEquals(await routerDb.getPlan(userId), {
        plan: "starter",
        allowedModels: STARTER_MODELS,
      });
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

      // A model outside Starter's list is refused before reserving.
      assertEquals(await call(PAID, "pk-not-starter"), 403);

      // Usage is charged from the allowance (1000) first: the lot is untouched.
      assertEquals(await call(FLASH, "pk-call-1"), 200);
      const afterFirst = await state();
      assertEquals(afterFirst.endsWith("|5000"), true, `lot untouched: ${afterFirst}`);

      // Allowance spent (balance = lot only): the next call consumes the lot.
      await admin`update public.credit_wallets set balance = 5000 where user_id = ${userId}`;
      assertEquals(await state(), "5000+0|5000");
      assertEquals(await call(FLASH, "pk-call-2"), 200);
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
    const FABLE = "anthropic/claude-fable-5-1";
    const OPUS = "anthropic/claude-opus-5-5";
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
    // The REAL MODEL_CATALOG (L5c: Fable 5.1 and Opus 5.5 provisional) and the REAL plan seed
    // (no override): Starter's explicit list has Opus but no claude-fable-*, Pro keeps every
    // model (NULL).
    try {
      const [{ allowed }] =
        await admin`select allowed_models as allowed from public.plans where plan = 'starter'`;
      assertEquals(allowed, STARTER_MODELS, "the real Starter seed");
      const [{ id: userId }] =
        await admin`select tests.create_user('packs-fable@example.com', true) as id`;
      const h = createRouterHandler({
        db: routerDb,
        getUser: () => Promise.resolve({ id: userId as string, email: null }),
        config: routerConfig(up.baseUrl, {
          keys: { "model - china": "upstream-secret", claude: "claude-secret" },
        }),
        catalog: MODEL_CATALOG,
        log: () => {},
      });
      const call = async (key: string, model: string = FABLE) => {
        const res = await h(
          completionRequest({ model, messages: [{ role: "user", content: "hi" }] }, { key }),
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
      assertEquals(await call("opus-starter", OPUS), [200, OPUS], "Starter has Opus 5.5");

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
      const big = pay("690003", p25.purchase_id, 18190);
      assertEquals((await billing.processMpPurchasePayment(big, EXPECT, null)).code, "credited");
      assertEquals(await routerDb.getPlan(userId), { plan: "pro", allowedModels: null });
      assertEquals(await call("fable-pro"), [200, FABLE]);

      // The pro lot refunded in full: back to the starter lots, Fable refused again.
      const refunded = { ...big, status: "refunded", refunded_minor: 18190 };
      assertEquals(
        (await billing.processMpPurchasePayment(refunded, EXPECT, null)).code,
        "reversed",
      );
      assertEquals((await routerDb.getPlan(userId)).plan, "starter");
      assertEquals(await call("fable-after-refund"), [403, "model_not_in_plan"]);
    } finally {
      await up.close();
      await admin.end();
    }
  },
});

Deno.test({
  name: "L5a review 2: every id in the migrated Starter allowed_models exists in the router's MODEL_CATALOG",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    try {
      const rows = await admin`select plan, allowed_models from public.plans order by sort_order`;
      const byPlan = new Map(
        rows.map((r) => [r.plan as string, r.allowed_models as string[] | null]),
      );
      const starter = byPlan.get("starter");
      assert(Array.isArray(starter) && starter.length > 0, "Starter has an explicit list");
      const ids = new Set(MODEL_CATALOG.map((m) => m.id));
      for (const id of starter) assert(ids.has(id), `Starter lists ${id}: not in MODEL_CATALOG`);
      assertEquals(
        [...starter].sort(),
        [...ids].filter((id) => !/(^|\/)claude-fable-/.test(id)).sort(),
        "Starter = MODEL_CATALOG minus claude-fable-*",
      );
      for (const plan of ["pro", "max", "ultra"]) assertEquals(byPlan.get(plan), null, plan);
      assertEquals(byPlan.get("free"), FREE_MODELS, "Free unchanged");
    } finally {
      await admin.end();
    }
  },
});

Deno.test({
  name: "L5b mp-buy-credits against a real Postgres: purchase frozen + preference linked, webhook credits it, blocked refused",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    const billing = createPostgresBillingDb(dbUrl ?? "");
    try {
      const [{ id: userId }] =
        await admin`select tests.create_user('buy-it@example.com', true) as id`;
      const prefs: CreatePreferenceInput[] = [];
      const payments = new Map<string, MpPayment>();
      const api: MpApi = {
        createPreference: (input, key) => {
          prefs.push(input);
          assertEquals(key, input.externalReference);
          return Promise.resolve({
            id: `777-${prefs.length}`,
            external_reference: input.externalReference,
            collector_id: "777",
            amount_minor: input.amountMinor,
            currency: input.currency,
            init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=777-${prefs.length}`,
          });
        },
        getPayment: (id) => Promise.resolve(structuredClone(payments.get(id) as MpPayment)),
        getPreapproval: () => Promise.reject(new Error("not used here")),
        getAuthorizedPayment: () => Promise.reject(new Error("not used here")),
        createPreapproval: () => Promise.reject(new Error("not used here")),
        cancelPreapproval: () => Promise.reject(new Error("not used here")),
      };
      const buy = createMpBuyCreditsHandler({
        api,
        db: billing,
        getUser: () => Promise.resolve({ id: userId, email: "buy-it@example.com" }),
        urls: () => URLS,
        notificationUrl: mpNotificationUrl("http://127.0.0.1:54321"),
        expect: EXPECT,
      });
      const req = (packId: string) =>
        new Request("http://localhost/mp-buy-credits", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer t" },
          body: JSON.stringify({ packId }),
        });

      // The DB price is what Mercado Pago is asked for.
      const res = await buy(req("credits_25k"));
      assertEquals(res.status, 200);
      const { url } = await res.json();
      assertEquals(url, "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=777-1");
      assertEquals(
        [prefs[0].amountMinor, prefs[0].currency, prefs[0].notificationUrl],
        [18190, "BRL", "http://127.0.0.1:54321/functions/v1/mp-webhook?source_news=webhooks"],
      );
      const [row] =
        await admin`select id, pack_id, credits, amount_minor, status, preference_id, checkout_url
                      from public.credit_purchases where user_id = ${userId}`;
      assertEquals(
        [row.pack_id, Number(row.credits), Number(row.amount_minor), row.status, row.preference_id],
        ["credits_25k", 25000, 18190, "created", "777-1"],
      );
      assertEquals(row.checkout_url, url);

      // MP pays it: credited by the webhook path (same RPC mp-webhook calls).
      payments.set("670001", {
        id: "670001",
        status: "approved",
        status_detail: "accredited",
        amount_minor: 18190,
        refunded_minor: 0,
        live_mode: false,
        collector_id: "777",
        currency: "BRL",
        external_reference: row.id,
      });
      const credited = await billing.processMpPurchasePayment(
        await api.getPayment("670001"),
        EXPECT,
        null,
      );
      assertEquals(credited.code, "credited");
      const [w] = await admin`select balance from public.credit_wallets where user_id = ${userId}`;
      assertEquals(Number(w.balance), 26000);

      // Blocked account (chargeback): refused before Mercado Pago is called.
      await admin`update public.credit_purchases set status = 'charged_back' where id = ${row.id}`;
      const blocked = await buy(req("credits_5k"));
      assertEquals([blocked.status, (await blocked.json()).error], [403, "account_blocked"]);
      assertEquals(prefs.length, 1);
    } finally {
      await admin.end();
    }
  },
});
