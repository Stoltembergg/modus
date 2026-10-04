/**
 * L1e mp-cancel against the REAL migrated Postgres (supabase/tests/run.sh): real handlers
 * (mp-checkout, mp-webhook, mp-cancel), real createPostgresBillingDb, a fake Mercado Pago API.
 * Not a *.test.ts.
 */
import { assertEquals } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { createPostgresBillingDb } from "../_shared/db.ts";
import type { CreatePreapprovalInput, MpApi, MpPreapproval } from "../_shared/mp.ts";
import { hmacSha256Hex, mpManifest } from "../_shared/mp-signature.ts";
import { URLS } from "../_shared/test-helpers.ts";
import { createMpCheckoutHandler } from "../mp-checkout/handler.ts";
import { createMpWebhookHandler } from "../mp-webhook/handler.ts";
import { createMpCancelHandler } from "./handler.ts";

const dbUrl = Deno.env.get("MODUS_TEST_DB_URL");
const SECRET = "integration-webhook-secret";
const EXPECT = { liveMode: false as const, collectorId: "777" };
const PRE = "PREL1E1";

Deno.test({
  name: "mp-cancel against a real Postgres: incomplete -> requested (still live) -> canceled -> no-op",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    const db = createPostgresBillingDb(dbUrl ?? "");
    try {
      const [{ id: userId }] =
        await admin`select tests.create_user('mp-cancel-it@example.com', true) as id`;
      const [{ id: otherId }] =
        await admin`select tests.create_user('mp-cancel-other@example.com', true) as id`;
      const user = { id: userId as string, email: "mp-cancel-it@example.com" };

      const preapprovals = new Map<string, MpPreapproval>();
      let putStatus = "authorized";
      const puts: string[] = [];
      let created = 0;
      const api: MpApi = {
        createPreapproval: (input: CreatePreapprovalInput) => {
          const id = created++ === 0 ? PRE : `PREL1E${created}`;
          const pre: MpPreapproval = {
            id,
            status: "pending",
            external_reference: input.externalReference,
            collector_id: "777",
            amount_minor: input.amountMinor,
            currency: input.currency,
            next_payment_date: null,
            init_point: `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${id}`,
          };
          preapprovals.set(pre.id, pre);
          return Promise.resolve(pre);
        },
        getPreapproval: (id) => {
          const pre = preapprovals.get(id);
          return pre ? Promise.resolve(structuredClone(pre)) : Promise.reject(new Error(id));
        },
        cancelPreapproval: (id) => {
          puts.push(id);
          const pre = preapprovals.get(id);
          if (!pre) return Promise.reject(new Error(id));
          pre.status = putStatus;
          return Promise.resolve(structuredClone(pre));
        },
        getAuthorizedPayment: () => Promise.reject(new Error("not used")),
        getPayment: () => Promise.reject(new Error("not used")),
      };

      const checkout = createMpCheckoutHandler({
        api,
        db,
        getUser: () => Promise.resolve(user),
        urls: () => URLS,
        expect: EXPECT,
      });
      const post = (body: unknown) =>
        new Request("http://localhost/fn", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer t" },
          body: JSON.stringify(body),
        });
      assertEquals((await checkout(post({ plan: "starter" }))).status, 200);

      const webhook = createMpWebhookHandler({
        api,
        db,
        secret: SECRET,
        expect: EXPECT,
        now: () => Date.now(),
      });
      const notify = async (requestId: string) => {
        const ts = String(Date.now());
        const sig = await hmacSha256Hex(SECRET, mpManifest(PRE, requestId, ts));
        const res = await webhook(
          new Request(`http://localhost/mp-webhook?data.id=${PRE}&type=subscription_preapproval`, {
            method: "POST",
            headers: { "x-request-id": requestId, "x-signature": `ts=${ts},v1=${sig}` },
            body: JSON.stringify({ type: "subscription_preapproval", data: { id: PRE } }),
          }),
        );
        return (await res.json()).code;
      };
      const row = async () => {
        const [r] = await admin`select status, cancel_at_period_end,
                                        cancel_requested_at is not null as requested
                                   from public.subscriptions
                                 where provider_subscription_id = ${PRE}`;
        // [status, cancel_at_period_end (L1g grace: only for a paid row), cancel requested]
        return [r.status, r.cancel_at_period_end, r.requested];
      };

      // Authorized in MP, no approved payment: incomplete (the L1d "no way out" case).
      const first = preapprovals.get(PRE);
      if (!first) throw new Error("fake MP: no preapproval");
      first.status = "authorized";
      assertEquals(await notify("l1e-1"), "subscription_incomplete");
      assertEquals(await row(), ["incomplete", false, false]);

      const cancelFor = (id: string) =>
        createMpCancelHandler({
          api,
          db,
          getUser: () => Promise.resolve({ id, email: null }),
          expect: EXPECT,
        });
      const cancel = cancelFor(userId);

      // Another user has nothing to cancel and never reaches this user's preapproval.
      assertEquals(await (await cancelFor(otherId)(post({}))).json(), { code: "no_subscription" });
      assertEquals(puts, []);

      // MP accepted the PUT but still reads authorized: flagged, status untouched (still live).
      assertEquals(await (await cancel(post({}))).json(), { code: "cancel_requested" });
      assertEquals(await row(), ["incomplete", false, true]);
      // A late `authorized` webhook keeps the request (the row is still live).
      assertEquals(await notify("l1e-late"), "subscription_incomplete");
      assertEquals(await row(), ["incomplete", false, true]);

      // MP confirms: applied through process_mp_preapproval (the webhook path).
      putStatus = "canceled";
      assertEquals(await (await cancel(post({}))).json(), { code: "canceled" });
      assertEquals(await row(), ["canceled", false, false]);
      assertEquals(puts, [PRE, PRE]);

      // Repeat: no-op; the late webhook for the same preapproval does not revive it.
      assertEquals(await (await cancel(post({}))).json(), { code: "no_subscription" });
      assertEquals(puts.length, 2);
      await notify("l1e-2");
      assertEquals((await row())[0], "canceled");

      // A new checkout is possible again (this row was never paid: canceled without the grace flag).
      const again = await checkout(post({ plan: "starter" }));
      assertEquals(again.status, 200);
      assertEquals(created, 2, "a fresh preapproval for the new checkout");

      // L1g: while a cancelled MP plan is still paid (grace), mp-checkout refuses on the server
      // (409 cancel_grace_active, no preapproval created); allowed once current_period_end passed.
      await admin`insert into public.subscriptions
                    (user_id, provider, provider_subscription_id, plan, status,
                     cancel_at_period_end, current_period_end)
                  values (${otherId}, 'mercadopago', 'PREL1GGRACE', 'starter', 'canceled', true,
                          now() + interval '20 days')`;
      const otherCheckout = createMpCheckoutHandler({
        api,
        db,
        getUser: () =>
          Promise.resolve({ id: otherId as string, email: "mp-cancel-other@example.com" }),
        urls: () => URLS,
        expect: EXPECT,
      });
      const refused = await otherCheckout(post({ plan: "starter" }));
      assertEquals([refused.status, await refused.json()], [409, { error: "cancel_grace_active" }]);
      assertEquals(created, 2, "no preapproval during the grace");
      await admin`update public.subscriptions set current_period_end = now() - interval '1 second'
                   where provider_subscription_id = 'PREL1GGRACE'`;
      assertEquals((await otherCheckout(post({ plan: "starter" }))).status, 200);
      assertEquals(created, 3, "a preapproval once the period ended");
    } finally {
      await admin.end();
    }
  },
});
