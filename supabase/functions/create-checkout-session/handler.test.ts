import { assert, assertEquals } from "jsr:@std/assert@1";
import { recorder, request, URLS, USER } from "../_shared/test-helpers.ts";
import { createCheckoutHandler } from "./handler.ts";

const STARTER_PRICE = "price_1UMIyDKAHtqpope6RahtIgRw";

function setup({
  storedCustomer = null as string | null,
  claimed = undefined as string | undefined,
  subscribed = false,
  sessionUrl = "https://checkout.stripe.com/c/pay/cs_test_1",
  sessionLivemode = false,
  user = USER as typeof USER | null,
} = {}) {
  const rec = recorder();
  const handler = createCheckoutHandler({
    getUser: rec.record("getUser", async () => user),
    urls: URLS,
    db: {
      getPurchasablePlan: rec.record("getPurchasablePlan", async (plan: string) =>
        plan === "starter" ? { plan: "starter", stripePriceId: STARTER_PRICE } : null,
      ),
      getStripeCustomerId: rec.record("getStripeCustomerId", async () => storedCustomer),
      hasLiveSubscription: rec.record("hasLiveSubscription", async () => subscribed),
      claimStripeCustomer: rec.record(
        "claimStripeCustomer",
        async (_u: string, id: string) => claimed ?? id,
      ),
    },
    stripe: {
      customers: {
        create: rec.record("customers.create", async () => ({ id: "cus_new", livemode: false })),
      },
      checkout: {
        sessions: {
          create: rec.record("sessions.create", async () => ({
            id: "cs_test_1",
            url: sessionUrl,
            livemode: sessionLivemode,
          })),
        },
      },
    },
  });
  return { handler, rec };
}

Deno.test("checkout: creates a session from server state only", async () => {
  const { handler, rec } = setup({ storedCustomer: "cus_existing" });
  const res = await handler(request({ plan: "starter" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert(!rec.names().includes("customers.create"), "existing customer is reused");
  const params = rec.calls.find((c) => c.name === "sessions.create")?.args[0] as Record<
    string,
    unknown
  >;
  assertEquals(params.customer, "cus_existing");
  assertEquals(params.client_reference_id, USER.id);
  assertEquals(params.metadata, { supabase_user_id: USER.id, plan: "starter" });
  assertEquals(params.subscription_data, {
    metadata: { supabase_user_id: USER.id, plan: "starter" },
  });
  assertEquals(params.line_items, [{ price: STARTER_PRICE, quantity: 1 }]);
  assertEquals(params.mode, "subscription");
  assertEquals(params.ui_mode, "hosted_page");
  assertEquals(params.success_url, URLS.successUrl);
  assertEquals(params.cancel_url, URLS.cancelUrl);
  assertEquals(params.billing_address_collection, "auto");
  assertEquals(params.phone_number_collection, { enabled: false });
  assertEquals(params.automatic_tax, { enabled: false });
  assertEquals(params.allow_promotion_codes, false);
  assertEquals(params.payment_method_collection, "always");
  assertEquals(params.integration_identifier, "hosted_mobile_app_0001");
  assertEquals(params.origin_context, "mobile_app");
});

Deno.test("checkout: creates the customer once (idempotency key) and stores it via claim", async () => {
  const { handler, rec } = setup();
  assertEquals((await handler(request({ plan: "starter" }))).status, 200);
  const create = rec.calls.find((c) => c.name === "customers.create");
  assertEquals(create?.args, [
    { email: USER.email, metadata: { supabase_user_id: USER.id } },
    { idempotencyKey: `modus-customer-${USER.id}` },
  ]);
  assertEquals(rec.calls.find((c) => c.name === "claimStripeCustomer")?.args, [USER.id, "cus_new"]);
  const params = rec.calls.find((c) => c.name === "sessions.create")?.args[0] as Record<
    string,
    unknown
  >;
  assertEquals(params.customer, "cus_new");
});

Deno.test("checkout: a concurrently stored customer wins over the one just created", async () => {
  const { handler, rec } = setup({ claimed: "cus_first" });
  assertEquals((await handler(request({ plan: "starter" }))).status, 200);
  const params = rec.calls.find((c) => c.name === "sessions.create")?.args[0] as Record<
    string,
    unknown
  >;
  assertEquals(params.customer, "cus_first");
});

Deno.test("checkout: rejects anything but a plan key from the client", async () => {
  const bodies: unknown[] = [
    { plan: "starter", price: "price_evil" },
    { plan: "starter", customer: "cus_other" },
    { plan: "starter", user_id: "22222222-2222-4222-8222-222222222222" },
    { plan: "starter", success_url: "https://evil.example" },
    { plan: "starter", metadata: { plan: "ultra" } },
    { price: STARTER_PRICE },
    { plan: "Starter!" },
    { plan: 1 },
    [],
    "not json",
  ];
  for (const body of bodies) {
    const { handler, rec } = setup();
    const res = await handler(request(body));
    assertEquals(res.status, 400, JSON.stringify(body));
    assert(!rec.names().some((n) => n.includes(".")), "no Stripe call");
  }
});

Deno.test("checkout: auth, method, plan and existing-subscription guards", async () => {
  assertEquals((await setup({ user: null }).handler(request({ plan: "starter" }))).status, 401);
  assertEquals((await setup().handler(request(null, { method: "GET" }))).status, 405);
  for (const plan of ["free", "unknown"]) {
    const { handler, rec } = setup();
    const res = await handler(request({ plan }));
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { error: "unknown_plan" });
    assert(!rec.names().includes("sessions.create"));
  }
  const subscribed = setup({ subscribed: true });
  const res = await subscribed.handler(request({ plan: "starter" }));
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "already_subscribed" });
  assert(!subscribed.rec.names().includes("sessions.create"));
});

Deno.test("checkout: an unexpected session (live or non-Stripe URL) is not returned", async () => {
  for (const options of [{ sessionLivemode: true }, { sessionUrl: "https://evil.example/pay" }]) {
    const res = await setup(options).handler(request({ plan: "starter" }));
    assertEquals(res.status, 502);
  }
});
