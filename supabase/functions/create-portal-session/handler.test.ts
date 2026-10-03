import { assert, assertEquals } from "jsr:@std/assert@1";
import { type BillingUrls, loadBillingUrls } from "../_shared/config.ts";
import { env, recorder, request, URLS, USER } from "../_shared/test-helpers.ts";
import { createPortalHandler } from "./handler.ts";

function setup({
  customer = "cus_own" as string | null,
  url = "https://billing.stripe.com/p/session/test_1",
  urls = (() => URLS) as () => BillingUrls,
} = {}) {
  const rec = recorder();
  const handler = createPortalHandler({
    getUser: async () => USER,
    urls,
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
    urls: () => URLS,
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

Deno.test("portal: fails closed (503) without a valid BILLING_RETURN_URL", async () => {
  for (const value of [
    undefined,
    " ",
    "http://192.168.0.10/billing/return",
    "https://x.example/?a=1",
  ]) {
    const { handler, rec } = setup({
      urls: () => loadBillingUrls(env(value === undefined ? {} : { BILLING_RETURN_URL: value })),
    });
    const res = await handler(request({}));
    assertEquals(res.status, 503);
    assertEquals(await res.json(), { error: "billing_not_configured" });
    assertEquals(rec.calls, []);
  }
});

Deno.test("portal: return_url comes from config only (headers and body cannot set it)", async () => {
  const { handler, rec } = setup();
  const req = new Request("https://evil.example/fn?return_url=https://evil.example", {
    method: "POST",
    headers: {
      authorization: "Bearer token.from.supabase",
      origin: "https://evil.example",
      referer: "https://evil.example/",
    },
  });
  assertEquals((await handler(req)).status, 200);
  assertEquals(rec.calls.find((c) => c.name === "portal.create")?.args, [
    { customer: "cus_own", return_url: URLS.portalReturnUrl },
  ]);
  const body = setup();
  assertEquals((await body.handler(request({ return_url: "https://evil.example" }))).status, 400);
  assert(!body.rec.names().includes("portal.create"));
});
