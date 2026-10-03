import { assert, assertEquals } from "jsr:@std/assert@1";
import { cryptoProvider, realStripe, recorder } from "../_shared/test-helpers.ts";
import { createWebhookHandler } from "./handler.ts";

const SECRET = "whsec_unit_test_secret";

function event(type: string, object: Record<string, unknown>, livemode: unknown = false) {
  return JSON.stringify({ id: "evt_1", object: "event", type, livemode, data: { object } });
}

async function signed(payload: string, secret = SECRET): Promise<Request> {
  const header = await realStripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    cryptoProvider,
  });
  return new Request("http://localhost/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

const FETCHED_INVOICE = {
  id: "in_1",
  object: "invoice",
  livemode: false,
  status: "paid",
  amount_paid: 900,
};
const FETCHED_SUB = { id: "sub_1", object: "subscription", livemode: false, status: "active" };

function setup({
  invoice = FETCHED_INVOICE as Record<string, unknown>,
  result = { processed: true, code: "credits_granted" } as Record<string, unknown>,
  dbError = false,
} = {}) {
  const rec = recorder();
  const verified: string[] = [];
  const handler = createWebhookHandler({
    webhookSecret: SECRET,
    cryptoProvider,
    stripe: {
      webhooks: {
        constructEventAsync: (payload, header, secret, tolerance, provider) => {
          verified.push(payload);
          return realStripe.webhooks.constructEventAsync(
            payload,
            header,
            secret,
            tolerance,
            provider,
          );
        },
      },
      invoices: { retrieve: rec.record("invoices.retrieve", async () => invoice as never) },
      subscriptions: { retrieve: rec.record("subscriptions.retrieve", async () => FETCHED_SUB) },
    },
    db: {
      processStripeEvent: rec.record("processStripeEvent", async () => {
        if (dbError) throw new Error("P0404");
        return result;
      }),
    },
  });
  return { handler, rec, verified };
}

Deno.test("webhook: verifies the raw body, re-fetches the invoice and passes the FETCHED object", async () => {
  const { handler, rec, verified } = setup();
  // data.object carries forged fields: it must never reach the database.
  const payload = event("invoice.paid", {
    id: "in_1",
    object: "invoice",
    amount_paid: 999999,
    customer: "cus_evil",
  });
  const res = await handler(await signed(payload));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { received: true, code: "credits_granted" });
  assertEquals(verified, [payload], "the exact raw text was verified");
  assertEquals(rec.calls.find((c) => c.name === "invoices.retrieve")?.args, ["in_1"]);
  assertEquals(rec.calls.find((c) => c.name === "processStripeEvent")?.args, [
    "evt_1",
    "invoice.paid",
    FETCHED_INVOICE,
  ]);
});

Deno.test("webhook: subscription events re-fetch the subscription", async () => {
  for (const type of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]) {
    const { handler, rec } = setup({ result: { processed: true, code: "subscription_upserted" } });
    const res = await handler(await signed(event(type, { id: "sub_1", object: "subscription" })));
    assertEquals(res.status, 200, type);
    assertEquals(rec.calls.find((c) => c.name === "subscriptions.retrieve")?.args, ["sub_1"]);
    assertEquals(rec.calls.find((c) => c.name === "processStripeEvent")?.args, [
      "evt_1",
      type,
      FETCHED_SUB,
    ]);
  }
});

Deno.test("webhook: bad, missing or foreign signatures are rejected before any parsing or effect", async () => {
  const payload = event("invoice.paid", { id: "in_1", object: "invoice" });
  const { handler, rec } = setup();
  assertEquals((await handler(await signed(payload, "whsec_other"))).status, 400);
  const tampered = await signed(payload);
  const forged = new Request(tampered.url, {
    method: "POST",
    headers: tampered.headers,
    body: payload.replace("in_1", "in_2"),
  });
  assertEquals((await handler(forged)).status, 400);
  const unsigned = new Request("http://localhost/stripe-webhook", {
    method: "POST",
    body: payload,
  });
  assertEquals((await handler(unsigned)).status, 400);
  // Not even valid JSON: the answer is still "invalid_signature" (verification comes first).
  const garbage = await handler(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=00" },
      body: "{not json",
    }),
  );
  assertEquals(await garbage.json(), { error: "invalid_signature" });
  assertEquals(rec.calls.length, 0, "no Stripe fetch and no database call");
});

Deno.test("webhook: livemode true events are rejected (live lock)", async () => {
  const missing = JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "invoice.paid",
    data: { object: { id: "in_1" } },
  });
  for (const payload of [
    event("invoice.paid", { id: "in_1", object: "invoice" }, true),
    event("invoice.paid", { id: "in_1", object: "invoice" }, "false"),
    event("invoice.paid", { id: "in_1", object: "invoice" }, null),
    missing,
  ]) {
    const { handler, rec } = setup();
    const res = await handler(await signed(payload));
    assertEquals(res.status, 400, payload);
    assertEquals(await res.json(), { error: "livemode_rejected" });
    assertEquals(rec.calls.length, 0);
  }
});

Deno.test("webhook: a re-fetched live object is rejected too", async () => {
  const { handler, rec } = setup({ invoice: { ...FETCHED_INVOICE, livemode: true } });
  const res = await handler(await signed(event("invoice.paid", { id: "in_1", object: "invoice" })));
  assertEquals(res.status, 400);
  assert(!rec.names().includes("processStripeEvent"));
});

Deno.test("webhook: duplicate events are a 200 no-op", async () => {
  const { handler } = setup({ result: { processed: false, code: "duplicate", event_id: "evt_1" } });
  const res = await handler(await signed(event("invoice.paid", { id: "in_1", object: "invoice" })));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { received: true, code: "duplicate" });
});

Deno.test("webhook: unhandled types are acknowledged without fetching or writing", async () => {
  const { handler, rec } = setup();
  const res = await handler(
    await signed(event("checkout.session.completed", { id: "cs_1", object: "checkout.session" })),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { received: true, ignored: true });
  assertEquals(rec.calls.length, 0);
});

Deno.test("webhook: processing errors return 500 so Stripe retries", async () => {
  const { handler } = setup({ dbError: true });
  const res = await handler(await signed(event("invoice.paid", { id: "in_1", object: "invoice" })));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "processing_failed" });
});

Deno.test("webhook: only POST", async () => {
  const { handler } = setup();
  assertEquals((await handler(new Request("http://localhost/x"))).status, 405);
});
