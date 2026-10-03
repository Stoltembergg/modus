import { assertEquals } from "jsr:@std/assert@1";
import type { MpCheckout, MpLinkResult } from "../_shared/db.ts";
import { type CreatePreapprovalInput, MpApiError, type MpPreapproval } from "../_shared/mp.ts";
import { recorder, request, URLS, USER } from "../_shared/test-helpers.ts";
import { createMpCheckoutHandler, type MpCheckoutDeps } from "./handler.ts";

const EXPECT = { liveMode: false as const, collectorId: "777" };
const CHECKOUT: MpCheckout = {
  code: "created",
  checkoutId: "0b9b3b52-4c55-4c47-9d2a-7a0c8a3e5f10",
  plan: "pro",
  planName: "Pro",
  amountMinor: 10990,
  currency: "BRL",
  checkoutUrl: null,
};
const INIT = "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre1";

function preFor(input: CreatePreapprovalInput, patch: Partial<MpPreapproval> = {}): MpPreapproval {
  return {
    id: "pre1",
    status: "pending",
    external_reference: input.externalReference,
    collector_id: "777",
    amount_minor: input.amountMinor,
    currency: input.currency,
    next_payment_date: null,
    init_point: INIT,
    ...patch,
  };
}

function setup(
  o: Partial<{
    checkout: MpCheckout;
    pre: Partial<MpPreapproval>;
    apiError: Error;
    link: MpLinkResult;
    user: typeof USER | null;
    urlsFail: boolean;
  }> = {},
) {
  const { calls, record, names } = recorder();
  const deps: MpCheckoutDeps = {
    api: {
      createPreapproval: record(
        "createPreapproval",
        (input: CreatePreapprovalInput, _key: string) =>
          o.apiError ? Promise.reject(o.apiError) : Promise.resolve(preFor(input, o.pre)),
      ),
    },
    db: {
      mpCreateCheckout: record("mpCreateCheckout", (_u: string, _p: string) =>
        Promise.resolve(o.checkout ?? CHECKOUT),
      ),
      mpLinkCheckout: record("mpLinkCheckout", (_c: string, _p: string, url: string) =>
        Promise.resolve(o.link ?? { code: "linked" as const, checkoutUrl: url }),
      ),
    },
    getUser: record("getUser", () => Promise.resolve(o.user === undefined ? USER : o.user)),
    urls: () => {
      if (o.urlsFail) throw new Error("BILLING_RETURN_URL is not set.");
      return URLS;
    },
    expect: EXPECT,
  };
  return { handler: createMpCheckoutHandler(deps), calls, names };
}

Deno.test("creates the record, then the preapproval keyed by it, links it, returns init_point", async () => {
  const { handler, calls, names } = setup();
  const res = await handler(request({ plan: "pro" }));
  assertEquals([res.status, await res.json()], [200, { url: INIT }]);
  assertEquals(names(), ["getUser", "mpCreateCheckout", "createPreapproval", "mpLinkCheckout"]);
  assertEquals(calls[1].args, [USER.id, "pro"]);
  const [input, key] = calls[2].args as [CreatePreapprovalInput, string];
  assertEquals(key, CHECKOUT.checkoutId, "X-Idempotency-Key = checkout id");
  assertEquals(input, {
    reason: "Modus Pro",
    externalReference: CHECKOUT.checkoutId,
    payerEmail: USER.email,
    amountMinor: 10990,
    currency: "BRL",
    backUrl: URLS.successUrl,
  });
  assertEquals(calls[3].args, [CHECKOUT.checkoutId, "pre1", INIT]);
});

Deno.test("only {plan} from the client; anything else is 400", async () => {
  for (const body of [
    {},
    { plan: "pro", price: 1 },
    { plan: "PRO" },
    { plan: 1 },
    { plan: "pro", user_id: "x" },
  ]) {
    const { handler, names } = setup();
    assertEquals((await handler(request(body))).status, 400, JSON.stringify(body));
    assertEquals(names().includes("mpCreateCheckout"), false);
  }
});

Deno.test("401 without a user; 400 without an email; 503 without BILLING_RETURN_URL; 405", async () => {
  assertEquals((await setup({ user: null }).handler(request({ plan: "pro" }))).status, 401);
  const noEmail = await setup({ user: { id: USER.id, email: null } }).handler(
    request({ plan: "pro" }),
  );
  assertEquals([noEmail.status, await noEmail.json()], [400, { error: "email_required" }]);
  const unconfigured = setup({ urlsFail: true });
  assertEquals((await unconfigured.handler(request({ plan: "pro" }))).status, 503);
  assertEquals(unconfigured.names(), []);
  assertEquals((await setup().handler(request({ plan: "pro" }, { method: "GET" }))).status, 405);
});

Deno.test("unknown plan 404; already subscribed (any provider) 409; no preapproval created", async () => {
  for (const [code, status] of [
    ["unknown_plan", 404],
    ["already_subscribed", 409],
  ] as const) {
    const { handler, names } = setup({ checkout: { code } });
    const res = await handler(request({ plan: "pro" }));
    assertEquals([res.status, (await res.json()).error], [status, code]);
    assertEquals(names().includes("createPreapproval"), false);
  }
});

Deno.test("reused checkout with a stored init_point: no second preapproval", async () => {
  const { handler, names } = setup({
    checkout: { ...CHECKOUT, code: "reused", checkoutUrl: INIT },
  });
  const res = await handler(request({ plan: "pro" }));
  assertEquals([res.status, await res.json()], [200, { url: INIT }]);
  assertEquals(names(), ["getUser", "mpCreateCheckout"]);
});

Deno.test("unexpected preapproval (reference / amount / currency / collector / host) -> 502, not linked", async () => {
  for (const patch of [
    { external_reference: "other" },
    { amount_minor: 1 },
    { currency: "USD" },
    { collector_id: "999" },
    { init_point: "https://evil.example.com/checkout" },
    { init_point: "http://www.mercadopago.com.br/x" },
    { init_point: null },
  ]) {
    const { handler, names } = setup({ pre: patch });
    const res = await handler(request({ plan: "pro" }));
    assertEquals(
      [res.status, (await res.json()).error],
      [502, "unexpected_preapproval"],
      JSON.stringify(patch),
    );
    assertEquals(names().includes("mpLinkCheckout"), false);
  }
});

Deno.test("MP API failure -> 502 mercadopago_unavailable; link conflict -> 409", async () => {
  const failing = await setup({ apiError: new MpApiError(503, "http") }).handler(
    request({ plan: "pro" }),
  );
  assertEquals([failing.status, (await failing.json()).error], [502, "mercadopago_unavailable"]);
  const conflict = await setup({ link: { code: "conflict", checkoutUrl: null } }).handler(
    request({ plan: "pro" }),
  );
  assertEquals([conflict.status, (await conflict.json()).error], [409, "checkout_conflict"]);
});
