import { assertEquals } from "jsr:@std/assert@1";
import type { MpLinkResult, MpPurchase } from "../_shared/db.ts";
import { type CreatePreferenceInput, MpApiError, type MpPreference } from "../_shared/mp.ts";
import { mpExpect, recorder, request, URLS, USER } from "../_shared/test-helpers.ts";
import {
  CREDIT_PACK_IDS,
  createMpBuyCreditsHandler,
  type MpBuyCreditsDeps,
  mpNotificationUrl,
} from "./handler.ts";

const EXPECT = mpExpect(false);
const NOTIFY = "https://proj.supabase.co/functions/v1/mp-webhook?source_news=webhooks";
const PURCHASE: MpPurchase = {
  code: "created",
  purchaseId: "5f0c7a52-4c55-4c47-9d2a-7a0c8a3e5f10",
  packId: "credits_10k",
  name: "10,000 credits",
  credits: 10000,
  amountMinor: 7290,
  currency: "BRL",
};
const NOW = Date.parse("2026-10-04T01:31:00Z");
const INIT = "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=777-abc";

function prefFor(input: CreatePreferenceInput, patch: Partial<MpPreference> = {}): MpPreference {
  return {
    id: "777-abc",
    external_reference: input.externalReference,
    collector_id: "777",
    amount_minor: input.amountMinor,
    currency: input.currency,
    init_point: INIT,
    ...patch,
  };
}

function setup(
  o: Partial<{
    purchase: MpPurchase;
    pref: Partial<MpPreference>;
    apiError: Error;
    link: MpLinkResult;
    user: typeof USER | null;
    urlsFail: boolean;
  }> = {},
) {
  const { calls, record, names } = recorder();
  const deps: MpBuyCreditsDeps = {
    api: {
      createPreference: record("createPreference", (input: CreatePreferenceInput, _key: string) =>
        o.apiError ? Promise.reject(o.apiError) : Promise.resolve(prefFor(input, o.pref)),
      ),
    },
    db: {
      mpCreatePurchase: record("mpCreatePurchase", (_u: string, _p: string) =>
        Promise.resolve(o.purchase ?? PURCHASE),
      ),
      mpLinkPurchase: record("mpLinkPurchase", (_c: string, _p: string, url: string) =>
        Promise.resolve(o.link ?? { code: "linked" as const, checkoutUrl: url }),
      ),
    },
    getUser: record("getUser", () => Promise.resolve(o.user === undefined ? USER : o.user)),
    urls: () => {
      if (o.urlsFail) throw new Error("BILLING_RETURN_URL is not set.");
      return URLS;
    },
    notificationUrl: NOTIFY,
    expect: EXPECT,
    now: () => NOW,
  };
  return { handler: createMpBuyCreditsHandler(deps), calls, names };
}

Deno.test("creates the purchase, then a Checkout Pro preference keyed by it (expires in 30 min), links it, returns init_point", async () => {
  const { handler, calls, names } = setup();
  const res = await handler(request({ packId: "credits_10k" }));
  assertEquals([res.status, await res.json()], [200, { url: INIT }]);
  assertEquals(names(), ["getUser", "mpCreatePurchase", "createPreference", "mpLinkPurchase"]);
  assertEquals(calls[1].args, [USER.id, "credits_10k"]);
  const [input, key] = calls[2].args as [CreatePreferenceInput, string];
  assertEquals(key, PURCHASE.purchaseId, "X-Idempotency-Key = purchase id");
  assertEquals(input, {
    packId: "credits_10k",
    title: "Modus 10,000 credits",
    externalReference: PURCHASE.purchaseId,
    payerEmail: USER.email,
    amountMinor: 7290,
    currency: "BRL",
    notificationUrl: NOTIFY,
    backUrls: { success: URLS.successUrl, pending: URLS.successUrl, failure: URLS.cancelUrl },
    expiresAt: new Date("2026-10-04T02:01:00Z"),
  });
  assertEquals(calls[3].args, [PURCHASE.purchaseId, "777-abc", INIT]);
});

Deno.test("price and credits come only from the DB purchase (frozen), never from the client", async () => {
  const { handler, calls } = setup({
    purchase: { ...PURCHASE, packId: "credits_5k", amountMinor: 3690, name: "5,000 credits" },
  });
  await handler(request({ packId: "credits_5k" }));
  const [input] = calls[2].args as [CreatePreferenceInput];
  assertEquals([input.packId, input.amountMinor], ["credits_5k", 3690]);
});

Deno.test("only {packId} with one of the three pack ids; anything else is 400 before the DB", async () => {
  assertEquals([...CREDIT_PACK_IDS], ["credits_5k", "credits_10k", "credits_25k"]);
  for (const body of [
    {},
    { packId: "credits_1m" },
    { packId: "starter" },
    { packId: "CREDITS_5K" },
    { packId: 5000 },
    { packId: "credits_5k", amount: 1 },
    { packId: "credits_5k", user_id: "x" },
    { plan: "credits_5k" },
  ]) {
    const { handler, names } = setup();
    assertEquals((await handler(request(body))).status, 400, JSON.stringify(body));
    assertEquals(names().includes("mpCreatePurchase"), false);
  }
});

Deno.test("auth, email, method and config", async () => {
  const anon = setup({ user: null });
  const res = await anon.handler(request({ packId: "credits_5k" }));
  assertEquals([res.status, await res.json()], [401, { error: "unauthorized" }]);
  assertEquals(anon.names(), ["getUser"]);
  const noEmail = await setup({ user: { id: USER.id, email: null } }).handler(
    request({ packId: "credits_5k" }),
  );
  assertEquals([noEmail.status, await noEmail.json()], [400, { error: "email_required" }]);
  const unconfigured = setup({ urlsFail: true });
  assertEquals((await unconfigured.handler(request({ packId: "credits_5k" }))).status, 503);
  assertEquals(unconfigured.names(), []);
  const get = await setup().handler(request({ packId: "credits_5k" }, { method: "GET" }));
  assertEquals(get.status, 405);
});

Deno.test("blocked account 403, unknown / inactive pack 404, rate limited 429: no preference created", async () => {
  for (const [code, status, error] of [
    ["blocked", 403, "account_blocked"],
    ["unknown_pack", 404, "unknown_pack"],
    ["too_many_purchases", 429, "too_many_purchases"],
  ] as const) {
    const { handler, names } = setup({ purchase: { code } });
    const res = await handler(request({ packId: "credits_25k" }));
    assertEquals([res.status, (await res.json()).error], [status, error]);
    assertEquals(names().includes("createPreference"), false);
  }
});

Deno.test("unexpected preference (reference / amount / currency / collector / host) -> 502, not linked", async () => {
  for (const patch of [
    { external_reference: "other" },
    { amount_minor: 1 },
    { currency: "USD" },
    { collector_id: "999" },
    { init_point: "https://evil.example.com/checkout" },
    { init_point: "http://www.mercadopago.com.br/checkout" },
    { init_point: null },
  ]) {
    const { handler, names } = setup({ pref: patch });
    const res = await handler(request({ packId: "credits_10k" }));
    assertEquals([res.status, (await res.json()).error], [502, "unexpected_preference"]);
    assertEquals(names().includes("mpLinkPurchase"), false, JSON.stringify(patch));
  }
});

Deno.test("Mercado Pago failure -> 502 mercadopago_unavailable; link conflict 409; lost 500", async () => {
  const down = await setup({ apiError: new MpApiError(503, "http") }).handler(
    request({ packId: "credits_5k" }),
  );
  assertEquals([down.status, (await down.json()).error], [502, "mercadopago_unavailable"]);
  const conflict = await setup({ link: { code: "conflict", checkoutUrl: null } }).handler(
    request({ packId: "credits_5k" }),
  );
  assertEquals([conflict.status, (await conflict.json()).error], [409, "purchase_conflict"]);
  const lost = await setup({ link: { code: "not_found", checkoutUrl: null } }).handler(
    request({ packId: "credits_5k" }),
  );
  assertEquals([lost.status, (await lost.json()).error], [500, "purchase_lost"]);
});

Deno.test("notification URL: the project's mp-webhook, Webhooks format only", () => {
  assertEquals(
    mpNotificationUrl("https://proj.supabase.co/"),
    "https://proj.supabase.co/functions/v1/mp-webhook?source_news=webhooks",
  );
});
