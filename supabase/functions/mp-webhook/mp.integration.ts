/**
 * mp-webhook + mp-checkout against the REAL migrated Postgres (supabase/tests/run.sh, CI job
 * "supabase · pgTAP · integration"): real handlers, real createPostgresBillingDb, real
 * signature, a fake Mercado Pago API (never the real one, no secrets). Not a *.test.ts.
 */
import { assertEquals } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { createPostgresBillingDb } from "../_shared/db.ts";
import type { CreatePreapprovalInput, MpApi, MpPayment, MpPreapproval } from "../_shared/mp.ts";
import { hmacSha256Hex, mpManifest } from "../_shared/mp-signature.ts";
import { mpExpect, URLS } from "../_shared/test-helpers.ts";
import { createMpCheckoutHandler } from "../mp-checkout/handler.ts";
import { createMpWebhookHandler } from "./handler.ts";

const dbUrl = Deno.env.get("MODUS_TEST_DB_URL");
const SECRET = "integration-webhook-secret";
const EXPECT = mpExpect(false);

Deno.test({
  name: "Mercado Pago against a real Postgres: checkout -> preapproval -> credit once, retry after a DB failure, refunds",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false, onnotice: () => {} });
    const db = createPostgresBillingDb(dbUrl ?? "");
    try {
      const [{ id: userId }] =
        await admin`select tests.create_user('mp-it@example.com', true) as id`;
      const balance = async () =>
        Number(
          (await admin`select balance from public.credit_wallets where user_id = ${userId}`)[0]
            .balance,
        );

      // Fake MP state, mutated by the test.
      const preapprovals = new Map<string, MpPreapproval>();
      const payments = new Map<string, MpPayment>();
      const invoices = new Map<
        string,
        { id: string; preapproval_id: string; payment_id: string | null }
      >();
      const must = <T>(v: T | undefined, what: string): T => {
        if (v === undefined) throw new Error(`fake MP: unknown ${what}`);
        return v;
      };
      let created = 0;
      const api: MpApi = {
        createPreapproval: (input: CreatePreapprovalInput, key: string) => {
          created++;
          assertEquals(key, input.externalReference);
          const pre: MpPreapproval = {
            id: "PREIT1",
            status: "pending",
            external_reference: input.externalReference,
            collector_id: "777",
            amount_minor: input.amountMinor,
            currency: input.currency,
            next_payment_date: null,
            init_point:
              "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=PREIT1",
          };
          preapprovals.set(pre.id, pre);
          return Promise.resolve(pre);
        },
        getPreapproval: (id) => Promise.resolve(structuredClone(must(preapprovals.get(id), id))),
        getAuthorizedPayment: (id) => Promise.resolve(structuredClone(must(invoices.get(id), id))),
        getPayment: (id) => Promise.resolve(structuredClone(must(payments.get(id), id))),
        cancelPreapproval: () => Promise.reject(new Error("not used here")),
        createPreference: () => Promise.reject(new Error("not used here")),
      };

      // 1) mp-checkout (server only): record + preapproval + link; a second call reuses it.
      const checkout = createMpCheckoutHandler({
        api,
        db,
        getUser: () => Promise.resolve({ id: userId, email: "mp-it@example.com" }),
        urls: () => URLS,
        expect: EXPECT,
      });
      const req = () =>
        new Request("http://localhost/mp-checkout", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer t" },
          body: JSON.stringify({ plan: "starter" }),
        });
      const first = await checkout(req());
      assertEquals(first.status, 200);
      const { url } = await first.json();
      assertEquals(url, must(preapprovals.get("PREIT1"), "PREIT1").init_point);
      assertEquals((await (await checkout(req())).json()).url, url);
      assertEquals(created, 1, "the open checkout is reused: one preapproval");
      const [co] =
        await admin`select id, amount_minor, provider_ref, status from public.billing_checkouts
                                where user_id = ${userId}`;
      assertEquals(
        [Number(co.amount_minor), co.provider_ref, co.status],
        [4990, "PREIT1", "created"],
      );

      const webhook = createMpWebhookHandler({
        api,
        db,
        secret: SECRET,
        expect: EXPECT,
        now: () => Date.now(),
      });
      const notify = async (topic: string, dataId: string, requestId: string) => {
        const ts = String(Date.now());
        const sig = await hmacSha256Hex(SECRET, mpManifest(dataId, requestId, ts));
        const res = await webhook(
          new Request(`http://localhost/mp-webhook?data.id=${dataId}&type=${topic}`, {
            method: "POST",
            headers: { "x-request-id": requestId, "x-signature": `ts=${ts},v1=${sig}` },
            body: JSON.stringify({ type: topic, data: { id: dataId } }),
          }),
        );
        return { status: res.status, body: await res.json() };
      };

      // 2) preapproval authorized -> incomplete (no plan yet).
      must(preapprovals.get("PREIT1"), "PREIT1").status = "authorized";
      assertEquals(
        (await notify("subscription_preapproval", "PREIT1", "it-1")).body.code,
        "subscription_incomplete",
      );

      // 3) Invoice with an approved payment, first delivery hits a DB failure -> 500.
      payments.set("880001", {
        id: "880001",
        status: "approved",
        status_detail: "accredited",
        amount_minor: 4990,
        refunded_minor: 0,
        live_mode: false,
        collector_id: "777",
        currency: "BRL",
        external_reference: null,
      });
      invoices.set("770001", { id: "770001", preapproval_id: "PREIT1", payment_id: "880001" });
      await admin.unsafe(`
        create function public.it_fail() returns trigger language plpgsql as
          $f$ begin raise exception 'simulated failure'; end $f$;
        create trigger it_fail before insert on public.credit_transactions
          for each row execute function public.it_fail();`);
      assertEquals((await notify("subscription_authorized_payment", "770001", "it-2")).status, 500);
      assertEquals(await balance(), 1000, "nothing credited by the failed delivery");
      const [n1] =
        await admin`select status from public.mp_notifications where request_id = 'it-2'`;
      assertEquals(n1.status, "received", "not marked processed after the failure");
      await admin.unsafe(
        `drop trigger it_fail on public.credit_transactions; drop function public.it_fail();`,
      );

      // MP retry, same x-request-id: processed, credited once; then duplicate.
      assertEquals(
        (await notify("subscription_authorized_payment", "770001", "it-2")).body.code,
        "credited",
      );
      assertEquals(
        (await notify("subscription_authorized_payment", "770001", "it-2")).body.code,
        "duplicate",
      );
      assertEquals(
        (await notify("subscription_authorized_payment", "770001", "it-3")).body.code,
        "already_credited",
      );
      assertEquals((await notify("payment", "880001", "it-4")).body.code, "already_credited");
      assertEquals(await balance(), 21000, "starter credited exactly once (1000 + 20000)");
      const [sub] =
        await admin`select status, plan from public.subscriptions where provider_subscription_id = 'PREIT1'`;
      assertEquals([sub.status, sub.plan], ["active", "starter"]);

      // 4) Partial refund via the payment topic: proportional debit; then full refund cancels.
      must(payments.get("880001"), "880001").refunded_minor = 2495;
      assertEquals((await notify("payment", "880001", "it-5")).body.code, "reversed");
      assertEquals(await balance(), 11000, "half refunded -> 10000 debited");
      must(payments.get("880001"), "880001").status = "refunded";
      must(payments.get("880001"), "880001").refunded_minor = 4990;
      assertEquals((await notify("payment", "880001", "it-6")).body.code, "reversed");
      assertEquals(await balance(), 1000, "total debited = credited");
      const [sub2] =
        await admin`select status from public.subscriptions where provider_subscription_id = 'PREIT1'`;
      assertEquals(sub2.status, "canceled", "full refund cancels");

      // 5) A payment never linked by an invoice is not credited.
      payments.set("880099", {
        ...must(payments.get("880001"), "880001"),
        id: "880099",
        status: "approved",
        refunded_minor: 0,
      });
      assertEquals((await notify("payment", "880099", "it-7")).body.code, "unlinked");
      assertEquals(await balance(), 1000);
    } finally {
      await admin.end();
    }
  },
});
