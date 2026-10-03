/**
 * Integration test for the REAL db.ts (npm:postgres) against a migrated Postgres.
 * Not picked up by `deno test` (name is not *.test.ts): supabase/tests/run.sh runs it
 * with MODUS_TEST_DB_URL pointing at its throwaway cluster, after the migrations.
 * Guards the B3 smoke bug: `${JSON.stringify(payload)}::jsonb` reached
 * process_stripe_event as a JSON *string* and failed with 22023.
 */
import { assertEquals } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.9";
import { createPostgresBillingDb } from "./db.ts";

const dbUrl = Deno.env.get("MODUS_TEST_DB_URL");
const STARTER = "price_1UMIyDKAHtqpope6RahtIgRw";
const PRO = "price_1UMIyIKAHtqpope6sw0xLZDQ";
const PERIOD = { start: 1790000000, end: 1792592000 };

function subscription(id: string, customer: string, price: string) {
  return {
    id,
    object: "subscription",
    customer,
    status: "active",
    livemode: false,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: price },
          current_period_start: PERIOD.start,
          current_period_end: PERIOD.end,
        },
      ],
    },
  };
}

function invoice(
  id: string,
  customer: string,
  sub: string,
  reason: string,
  price: string,
  amount: number,
) {
  return {
    id,
    object: "invoice",
    customer,
    status: "paid",
    billing_reason: reason,
    amount_paid: amount,
    subscription: sub,
    livemode: false,
    lines: {
      data: [{ price: { id: price }, proration: false, subscription: sub, amount, period: PERIOD }],
    },
  };
}

Deno.test({
  name: "db.ts against a real Postgres: process_stripe_event gets a jsonb object",
  ignore: !dbUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const admin = postgres(dbUrl ?? "", { max: 1, prepare: false });
    try {
      const [{ id: userId }] =
        await admin`select tests.create_user('db-it@example.com', true) as id`;
      const db = createPostgresBillingDb(dbUrl ?? "");
      const wallet = async () =>
        (
          await admin`select balance, plan_allowance from public.credit_wallets where user_id = ${userId}`
        )[0];

      // The other db.ts calls (scalar / text[] parameters).
      assertEquals(await db.getPurchasablePlan("starter"), {
        plan: "starter",
        stripePriceId: STARTER,
      });
      assertEquals(await db.getPurchasablePlan("free"), null);
      // L1a: pro / max / ultra are inactive, so the Stripe checkout path refuses them.
      for (const plan of ["pro", "max", "ultra"]) {
        assertEquals(await db.getPurchasablePlan(plan), null, `${plan} is not purchasable`);
      }
      assertEquals(await db.getStripeCustomerId(userId), null);
      assertEquals(await db.claimStripeCustomer(userId, "cus_IT"), "cus_IT");
      assertEquals(await db.claimStripeCustomer(userId, "cus_OTHER"), "cus_IT");
      assertEquals(await db.getStripeCustomerId(userId), "cus_IT");
      assertEquals(await db.hasLiveSubscription(userId), false);
      // L1b: no Stripe subscription row yet -> the Portal stays closed while Stripe is off.
      assertEquals(await db.hasStripeSubscription(userId), false);

      // How the parameter arrives: tx.json(...) is a jsonb object; the old
      // `${JSON.stringify(...)}::jsonb` was a jsonb string (process_stripe_event's
      // first check rejects anything but an object with 22023).
      const probe = subscription("sub_PROBE", "cus_IT", STARTER);
      assertEquals((await admin`select jsonb_typeof(${admin.json(probe)}) as t`)[0].t, "object");
      assertEquals(
        (await admin`select jsonb_typeof(${JSON.stringify(probe)}::jsonb) as t`)[0].t,
        "string",
      );
      const eventRow = async (id: string) =>
        (
          await admin`select type, status, result from public.stripe_events where event_id = ${id}`
        )[0];

      // customer.subscription.created -> subscriptions row (this threw 22023 before the fix).
      const created = await db.processStripeEvent(
        "evt_it_sub",
        "customer.subscription.created",
        subscription("sub_IT", "cus_IT", STARTER),
      );
      assertEquals(created.code, "subscription_upserted");
      assertEquals(await db.hasLiveSubscription(userId), true);
      assertEquals(await db.hasStripeSubscription(userId), true);
      assertEquals(await eventRow("evt_it_sub"), {
        type: "customer.subscription.created",
        status: "processed",
        result: "subscription_upserted",
      });
      const [sub] =
        await admin`select plan, status from public.subscriptions where stripe_subscription_id = 'sub_IT'`;
      assertEquals({ plan: sub.plan, status: sub.status }, { plan: "starter", status: "active" });

      // invoice.paid (subscription_create) -> Starter credits once.
      const before = await wallet();
      const paid = await db.processStripeEvent(
        "evt_it_inv",
        "invoice.paid",
        invoice("in_IT_1", "cus_IT", "sub_IT", "subscription_create", STARTER, 900),
      );
      assertEquals(paid.code, "credits_granted");
      const afterPaid = await wallet();
      assertEquals(Number(afterPaid.balance) - Number(before.balance), 10000);
      assertEquals(Number(afterPaid.plan_allowance), 10000);
      assertEquals(await eventRow("evt_it_inv"), {
        type: "invoice.paid",
        status: "processed",
        result: "credits_granted",
      });

      // Same event id again: no-op.
      const dup = await db.processStripeEvent(
        "evt_it_inv",
        "invoice.paid",
        invoice("in_IT_1", "cus_IT", "sub_IT", "subscription_create", STARTER, 900),
      );
      assertEquals(dup.code, "duplicate");
      assertEquals(await wallet(), afterPaid, "a repeated invoice.paid grants nothing");
      assertEquals(
        Number(
          (
            await admin`select count(*) as n from public.credit_transactions where user_id = ${userId} and idempotency_key = 'invoice:in_IT_1'`
          )[0].n,
        ),
        1,
      );

      // L1a: Pro is inactive. An upgrade invoice to Pro credits nothing and is
      // recorded as processed / rejected_inactive_plan (the Function answers 200).
      const rejected = await db.processStripeEvent(
        "evt_it_up_inactive",
        "invoice.paid",
        invoice("in_IT_2", "cus_IT", "sub_IT", "subscription_update", PRO, 1100),
      );
      assertEquals(rejected.code, "rejected_inactive_plan");
      assertEquals(await wallet(), afterPaid, "an inactive-plan invoice grants nothing");
      assertEquals(await eventRow("evt_it_up_inactive"), {
        type: "invoice.paid",
        status: "processed",
        result: "rejected_inactive_plan",
      });

      // B3 upgrade path (Pro reactivated for this check, then deactivated again):
      // subscription_update, amount_paid > 0 -> +15000 (Pro 25000 - 10000).
      await admin`update public.plans set active = true where plan = 'pro'`;
      try {
        const up = await db.processStripeEvent(
          "evt_it_up",
          "invoice.paid",
          invoice("in_IT_2", "cus_IT", "sub_IT", "subscription_update", PRO, 1100),
        );
        assertEquals(up.code, "upgrade_credits_granted");
      } finally {
        await admin`update public.plans set active = false where plan = 'pro'`;
      }
      const afterUp = await wallet();
      assertEquals(Number(afterUp.balance) - Number(afterPaid.balance), 15000);

      const events =
        await admin`select event_id, status from public.stripe_events where event_id like 'evt_it_%' order by event_id`;
      assertEquals(
        events.map((e) => `${e.event_id}:${e.status}`),
        [
          "evt_it_inv:processed",
          "evt_it_sub:processed",
          "evt_it_up:processed",
          "evt_it_up_inactive:processed",
        ],
      );

      // L1b: hasStripeSubscription is per user and ignores canceled rows.
      const [{ id: otherId }] =
        await admin`select tests.create_user('db-it-other@example.com', true) as id`;
      assertEquals(
        await db.hasStripeSubscription(otherId),
        false,
        "another user's row never counts",
      );
      // Allowlist: active / trialing / past_due / unpaid open the Portal; everything else
      // (incomplete, incomplete_expired, paused, canceled, unknown) fails closed.
      const expected: Array<[string, boolean]> = [
        ["active", true],
        ["trialing", true],
        ["past_due", true],
        ["unpaid", true],
        ["incomplete", false],
        ["incomplete_expired", false],
        ["paused", false],
        ["some_future_status", false],
        ["canceled", false],
      ];
      for (const [status, allowed] of expected) {
        await admin`update public.subscriptions set status = ${status} where stripe_subscription_id = 'sub_IT'`;
        assertEquals(await db.hasStripeSubscription(userId), allowed, status);
      }
    } finally {
      await admin.end();
    }
  },
});
