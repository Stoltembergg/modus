import { assert, assertEquals } from "jsr:@std/assert@1";
import { recorder, request, URLS, USER } from "../_shared/test-helpers.ts";
import { createPortalHandler } from "./handler.ts";

function setup({
  customer = "cus_own" as string | null,
  url = "https://billing.stripe.com/p/session/test_1",
} = {}) {
  const rec = recorder();
  const handler = createPortalHandler({
    getUser: async () => USER,
    urls: URLS,
    db: { getStripeCustomerId: rec.record("getStripeCustomerId", async () => customer) },
    stripe: {
      billingPortal: {
        sessions: { create: rec.record("portal.create", async () => ({ url, livemode: false })) },
      },
    },
  });
  return { handler, rec };
}

Deno.test("portal: only for the caller's own stored customer", async () => {
  const { handler, rec } = setup();
  const res = await handler(request({}));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { url: "https://billing.stripe.com/p/session/test_1" });
  assertEquals(rec.calls.find((c) => c.name === "getStripeCustomerId")?.args, [USER.id]);
  assertEquals(rec.calls.find((c) => c.name === "portal.create")?.args, [
    { customer: "cus_own", return_url: URLS.portalReturnUrl },
  ]);
});

Deno.test("portal: a customer id from the client is refused", async () => {
  const { handler, rec } = setup();
  assertEquals((await handler(request({ customer: "cus_other" }))).status, 400);
  assert(!rec.names().includes("portal.create"));
});

Deno.test("portal: no stored customer -> 404, unauthenticated -> 401, unexpected URL -> 502", async () => {
  const none = setup({ customer: null });
  const res = await none.handler(request({}));
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "no_billing_account" });
  assert(!none.rec.names().includes("portal.create"));

  const anonymous = createPortalHandler({
    getUser: async () => null,
    urls: URLS,
    db: { getStripeCustomerId: async () => "cus_own" },
    stripe: {
      billingPortal: {
        sessions: {
          create: async () => ({ url: "https://billing.stripe.com/x", livemode: false }),
        },
      },
    },
  });
  assertEquals((await anonymous(request({}))).status, 401);
  assertEquals((await setup({ url: "https://evil.example/" }).handler(request({}))).status, 502);
});
