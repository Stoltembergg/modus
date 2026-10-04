import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BillingState, BillingSubscription } from "../../shared/billing";
import { AuthBackendError } from "../auth/auth-backend";
import {
  authState,
  createFakeAuth,
  createFakeBillingBackend,
  MP_STARTER,
  PACKS,
  SECRET_CHECKOUT_URL,
  SECRET_MP_PACK_URL,
  SECRET_MP_URL,
  SECRET_PORTAL_URL,
  STRIPE_STARTER,
  snapshot,
  USER_ID,
} from "./billing.test-helpers";
import {
  isStripeHostedUrl,
  LIVE_SUBSCRIPTION_STATUSES,
  mapBillingRows,
  mapCatalogRows,
  mapPackRows,
} from "./billing-backend";
import { createBillingService } from "./billing-service";

function setup(signedIn = true) {
  const auth = createFakeAuth(authState(signedIn));
  const backend = createFakeBillingBackend();
  const openExternal = vi.fn(async (_url: string) => undefined);
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const service = createBillingService({
    auth,
    backend,
    openExternal,
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  });
  const events: BillingState[] = [];
  service.onStateChange((state) => events.push(state));
  return { auth, backend, openExternal, service, timers, events };
}

describe("billing service", () => {
  it("is unavailable without a backend and signed-out without a user", async () => {
    const auth = createFakeAuth(authState(true));
    const none = createBillingService({ auth, backend: undefined, openExternal: vi.fn() });
    expect((await none.refresh()).status).toBe("unavailable");
    const { service, backend } = setup(false);
    expect((await service.refresh()).status).toBe("signed-out");
    expect(backend.fetchBilling).not.toHaveBeenCalled();
  });

  it("loads the caller's plan, subscription and wallet on sign-in", async () => {
    const { service, backend, auth } = setup(false);
    backend.fetchBilling.mockResolvedValue(
      snapshot({
        subscription: {
          plan: "pro",
          provider: "stripe",
          status: "active",
          currentPeriodEnd: "2026-11-03T03:00:00Z",
          cancelAtPeriodEnd: false,
          cancelRequestedAt: null,
        },
      }),
    );
    auth.set(authState(true));
    await vi.waitFor(() => expect(service.getState().status).toBe("ready"));
    expect(backend.fetchBilling).toHaveBeenCalledWith(USER_ID);
    expect(service.getState()).toMatchObject({ currentPlan: "pro", wallet: { balance: 1000 } });
    auth.set(authState(false));
    expect(service.getState()).toMatchObject({ status: "signed-out", plans: [], wallet: null });
  });

  it("opens Mercado Pago checkout by default and never exposes the init_point", async () => {
    const { service, backend, openExternal, events } = setup();
    await service.refresh();
    expect(service.getState().catalog).toEqual([MP_STARTER]);
    const state = await service.startCheckout("starter");
    expect(backend.createBillingSession).toHaveBeenCalledWith("mp-checkout", { plan: "starter" });
    expect(openExternal).toHaveBeenCalledWith(SECRET_MP_URL);
    expect(state).toMatchObject({ pending: "checkout", error: null });
    expect(JSON.stringify(events)).not.toContain("SECRET_preapproval");
  });

  it("refuses Stripe checkout unless the catalog has a stripe row", async () => {
    const { service, backend, openExternal } = setup();
    await service.refresh();
    expect((await service.startCheckout("starter", "stripe")).error).toMatch(/not available/);
    expect(backend.createBillingSession).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens Stripe Checkout when the catalog offers it and never exposes the session URL", async () => {
    const { service, backend, openExternal, events } = setup();
    backend.fetchBilling.mockResolvedValue(snapshot({ catalog: [MP_STARTER, STRIPE_STARTER] }));
    await service.refresh();
    const state = await service.startCheckout("starter", "stripe");
    expect(backend.createBillingSession).toHaveBeenCalledWith("create-checkout-session", {
      plan: "starter",
    });
    expect(openExternal).toHaveBeenCalledWith(SECRET_CHECKOUT_URL);
    expect(state.pending).toBe("checkout");
    expect(JSON.stringify(events)).not.toContain("cs_test_SECRET");
  });

  it("L5b buyCredits: opens Checkout Pro for a pack the catalog offers; only the pack id is sent", async () => {
    const { service, backend, openExternal, events } = setup();
    backend.fetchBilling.mockResolvedValue(snapshot({ catalog: [], packs: PACKS }));
    await service.refresh();
    const state = await service.buyCredits("credits_25k");
    expect(backend.createBillingSession).toHaveBeenCalledWith("mp-buy-credits", {
      packId: "credits_25k",
    });
    expect(openExternal).toHaveBeenCalledWith(SECRET_MP_PACK_URL);
    expect([state.pending, state.error]).toEqual(["checkout", null]);
    expect(JSON.stringify(events)).not.toContain("SECRET_preference");
  });

  it("L5b buyCredits refuses unknown ids and packs the catalog doesn't offer, before the Function", async () => {
    const { service, backend } = setup();
    backend.fetchBilling.mockResolvedValue(snapshot({ packs: PACKS.slice(0, 1) }));
    await service.refresh();
    for (const id of ["credits_10k", "credits_1m", "starter", "", "CREDITS_5K"]) {
      expect((await service.buyCredits(id)).error).toMatch(/credit pack is not available/);
    }
    backend.fetchBilling.mockResolvedValue(snapshot({ catalog: null, packs: null }));
    await service.refresh();
    expect((await service.buyCredits("credits_5k")).error).toMatch(/not available/);
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("L5b buyCredits maps the Function's refusals; a non-Mercado Pago URL is never opened", async () => {
    const { service, backend, openExternal } = setup();
    backend.fetchBilling.mockResolvedValue(snapshot({ packs: PACKS }));
    await service.refresh();
    for (const [code, message] of [
      ["account_blocked", /blocked on this account/],
      ["unknown_pack", /credit pack is not available/],
      ["mercadopago_unavailable", /Mercado Pago is unavailable/],
      ["purchase_conflict", /already being set up/],
      ["too_many_purchases", /Too many checkouts/],
    ] as const) {
      backend.createBillingSession.mockResolvedValueOnce({ ok: false, status: 403, code });
      const state = await service.buyCredits("credits_5k");
      expect([state.pending, state.error]).toEqual([null, expect.stringMatching(message)]);
    }
    backend.createBillingSession.mockResolvedValueOnce({
      ok: true,
      url: "https://evil.example/checkout",
    });
    expect((await service.buyCredits("credits_5k")).error).toMatch(/unavailable/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("L5b buyCredits needs a signed-in user", async () => {
    const { service, backend } = setup(false);
    expect((await service.buyCredits("credits_5k")).error).toMatch(/Sign in/);
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("refuses unknown, free or malformed plans before calling the Function", async () => {
    const { service, backend } = setup();
    await service.refresh();
    for (const plan of ["free", "pro", "enterprise", "Pro", "price_123", ""]) {
      expect((await service.startCheckout(plan)).error).toMatch(/not available/);
    }
    expect((await service.startCheckout("starter", "paypal" as unknown as "stripe")).error).toMatch(
      /not available/,
    );
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("offers nothing when the catalog failed to load or is empty", async () => {
    const { service, backend } = setup();
    backend.fetchBilling.mockResolvedValueOnce(snapshot({ catalog: null }));
    expect((await service.refresh()).catalog).toBeNull();
    expect((await service.startCheckout("starter")).error).toMatch(/not available/);
    backend.fetchBilling.mockResolvedValueOnce(snapshot({ catalog: [] }));
    expect((await service.refresh()).catalog).toEqual([]);
    expect((await service.startCheckout("starter")).error).toMatch(/not available/);
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("does not start a checkout for a user who already has a live subscription", async () => {
    const { service, backend } = setup();
    backend.fetchBilling.mockResolvedValue(
      snapshot({
        subscription: {
          plan: "starter",
          provider: "mercadopago",
          status: "active",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          cancelRequestedAt: null,
        },
      }),
    );
    await service.refresh();
    expect((await service.startCheckout("starter")).error).toMatch(/already have a subscription/);
    expect(backend.createBillingSession).not.toHaveBeenCalled();
  });

  it("maps mp-checkout errors (503 / 502 / 409 / 400) to messages and opens nothing", async () => {
    const { service, backend, openExternal } = setup();
    await service.refresh();
    const cases: Array<[number, string, RegExp]> = [
      [503, "billing_not_configured", /unavailable right now/],
      [502, "mercadopago_unavailable", /Mercado Pago is unavailable/],
      [502, "unexpected_preapproval", /unavailable right now/],
      [409, "checkout_conflict", /already being created/],
      [409, "already_subscribed", /already have a subscription/],
      // L1g: the server refuses a checkout while a cancelled plan is still paid.
      [409, "cancel_grace_active", /stays active until the end of the period.*subscribe again/],
      [400, "email_required", /email address/],
      [503, "stripe_disabled", /turned off/],
    ];
    for (const [status, code, message] of cases) {
      backend.createBillingSession.mockResolvedValueOnce({ ok: false, status, code });
      const state = await service.startCheckout("starter");
      expect(state.error).toMatch(message);
      expect(state.pending).toBeNull();
    }
    backend.createBillingSession.mockRejectedValueOnce(new AuthBackendError("network", "x"));
    expect((await service.startCheckout("starter")).error).toMatch(/connection/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens the Portal and maps server errors to messages", async () => {
    const { service, backend, openExternal } = setup();
    await service.refresh();
    expect((await service.openPortal()).pending).toBe("portal");
    expect(openExternal).toHaveBeenCalledWith(SECRET_PORTAL_URL);
    backend.createBillingSession.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "already_subscribed",
    });
    expect((await service.startCheckout("starter")).error).toMatch(/already have a subscription/);
    backend.createBillingSession.mockRejectedValueOnce(new AuthBackendError("network", "x"));
    expect((await service.openPortal()).error).toMatch(/connection/);
  });

  it("never opens a URL that is not hosted by the checkout's provider", async () => {
    const { service, backend, openExternal } = setup();
    backend.fetchBilling.mockResolvedValue(snapshot({ catalog: [MP_STARTER, STRIPE_STARTER] }));
    await service.refresh();
    for (const url of [
      "https://www.mercadopago.com.br.evil.example/subscriptions/checkout",
      "http://www.mercadopago.com.br/subscriptions/checkout",
      "https://www.mercadopago.com.br:8443/subscriptions/checkout",
      "https://u:p@www.mercadopago.com.br/subscriptions/checkout",
      "https://www.mercadopago.com.ar/subscriptions/checkout",
      SECRET_CHECKOUT_URL,
      "javascript:alert(1)",
    ]) {
      backend.createBillingSession.mockResolvedValueOnce({ ok: true, url });
      expect((await service.startCheckout("starter")).error).toMatch(/unavailable/);
    }
    for (const url of [
      "https://checkout.stripe.com.evil.example/c/pay",
      "http://checkout.stripe.com/c/pay",
      "https://billing.stripe.com/p/session/x",
      SECRET_MP_URL,
    ]) {
      backend.createBillingSession.mockResolvedValueOnce({ ok: true, url });
      expect((await service.startCheckout("starter", "stripe")).error).toMatch(/unavailable/);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refreshes on billing/return and again while the webhook catches up", async () => {
    const { service, backend, timers } = setup();
    await service.refresh();
    await service.startCheckout("starter");
    backend.fetchBilling.mockClear();
    const state = await service.handleReturn("success");
    expect(state).toMatchObject({ pending: null, lastReturn: "success" });
    expect(backend.fetchBilling).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.ms)).toEqual([4_000, 12_000]);
    for (const timer of timers) timer.run();
    await vi.waitFor(() => expect(backend.fetchBilling).toHaveBeenCalledTimes(3));
    service.dispose();
  });

  describe("cancelSubscription (L1e)", () => {
    const MP_SUB = {
      plan: "starter",
      provider: "mercadopago" as const,
      status: "active",
      currentPeriodEnd: "2026-11-03T00:00:00Z",
      cancelAtPeriodEnd: false,
      cancelRequestedAt: null,
    };

    async function ready(subscription: BillingSubscription | null = MP_SUB) {
      const ctx = setup();
      ctx.backend.fetchBilling.mockResolvedValue(snapshot({ subscription }));
      await ctx.service.refresh();
      return ctx;
    }

    it("confirmed: cancelling while in flight, then the live subscription is gone", async () => {
      const { service, backend, events, timers } = await ready();
      backend.fetchBilling.mockResolvedValue(snapshot({ subscription: null }));
      const state = await service.cancelSubscription();
      expect(backend.cancelSubscription).toHaveBeenCalledWith();
      expect(events.some((e) => e.cancelling && e.subscription?.status === "active")).toBe(true);
      expect(state).toMatchObject({ cancelling: false, subscription: null, currentPlan: "free" });
      expect(timers.map((t) => t.ms)).toEqual([3_000, 10_000, 30_000]);
    });

    it("not confirmed yet: the subscription stays (flagged), so checkout stays blocked", async () => {
      const { service, backend, timers } = await ready();
      backend.cancelSubscription.mockResolvedValue({ ok: true, code: "cancel_requested" });
      backend.fetchBilling.mockResolvedValue(
        snapshot({ subscription: { ...MP_SUB, cancelRequestedAt: "2026-10-03T23:50:00Z" } }),
      );
      const state = await service.cancelSubscription();
      expect(state.subscription).toMatchObject({
        status: "active",
        cancelAtPeriodEnd: false,
        cancelRequestedAt: "2026-10-03T23:50:00Z",
      });
      expect(state.error).toBeNull();
      expect((await service.startCheckout("starter")).error).toMatch(/already have/);
      expect(backend.createBillingSession).not.toHaveBeenCalled();
      // A late `authorized` webhook keeps the row live and the request set: still blocked.
      timers[0]?.run();
      await vi.waitFor(() => expect(backend.fetchBilling).toHaveBeenCalledTimes(4));
      expect(service.getState().subscription?.cancelRequestedAt).toBe("2026-10-03T23:50:00Z");
      expect((await service.startCheckout("starter")).error).toMatch(/already have/);
      expect(backend.createBillingSession).not.toHaveBeenCalled();
      // The webhook lands later: a scheduled refresh picks it up.
      backend.fetchBilling.mockResolvedValue(snapshot({ subscription: null }));
      timers[1]?.run();
      await vi.waitFor(() => expect(service.getState().subscription).toBeNull());
    });

    it("paused: counts as live (no checkout on top of it) and can be cancelled", async () => {
      const { service, backend } = await ready({ ...MP_SUB, status: "paused" });
      expect((await service.startCheckout("starter")).error).toMatch(/already have/);
      expect(backend.createBillingSession).not.toHaveBeenCalled();
      backend.fetchBilling.mockResolvedValue(snapshot({ subscription: null }));
      const state = await service.cancelSubscription();
      expect(backend.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(state.subscription).toBeNull();
    });

    it("incomplete: cancel and try again, then checkout is possible", async () => {
      const { service, backend, openExternal } = await ready({ ...MP_SUB, status: "incomplete" });
      expect((await service.startCheckout("starter")).error).toMatch(/already have/);
      backend.fetchBilling.mockResolvedValue(snapshot({ subscription: null }));
      await service.cancelSubscription();
      expect((await service.startCheckout("starter")).pending).toBe("checkout");
      expect(openExternal).toHaveBeenCalledWith(SECRET_MP_URL);
    });

    it("errors: message, cancelling cleared, subscription kept, no refresh scheduled", async () => {
      const { service, backend, timers } = await ready();
      backend.cancelSubscription.mockResolvedValue({
        ok: false,
        status: 502,
        code: "mercadopago_unavailable",
      });
      const state = await service.cancelSubscription();
      expect(state).toMatchObject({ cancelling: false, subscription: { status: "active" } });
      expect(state.error).toMatch(/Mercado Pago is unavailable/);
      expect(timers).toHaveLength(0);
      backend.cancelSubscription.mockRejectedValue(new AuthBackendError("network", "network"));
      expect((await service.cancelSubscription()).error).toMatch(/connection/);
    });

    it("refuses without a Mercado Pago subscription (none, Stripe, signed out)", async () => {
      for (const subscription of [null, { ...MP_SUB, provider: "stripe" as const }]) {
        const { service, backend } = await ready(subscription);
        expect((await service.cancelSubscription()).error).toMatch(/no Mercado Pago/);
        expect(backend.cancelSubscription).not.toHaveBeenCalled();
      }
      const out = setup(false);
      expect((await out.service.cancelSubscription()).error).toMatch(/Sign in/);
      expect(out.backend.cancelSubscription).not.toHaveBeenCalled();
    });

    it("L1g: a cancelled row paid until the period end keeps the plan, blocks checkout and cancel", async () => {
      const { service, backend } = await ready({
        ...MP_SUB,
        status: "canceled",
        cancelAtPeriodEnd: true,
      });
      expect(service.getState()).toMatchObject({
        currentPlan: "starter",
        subscription: { status: "canceled", cancelAtPeriodEnd: true },
      });
      expect((await service.startCheckout("starter")).error).toMatch(
        /cancelled plan stays active.*subscribe again after that/,
      );
      expect(backend.createBillingSession).not.toHaveBeenCalled();
      expect((await service.cancelSubscription()).error).toMatch(/no Mercado Pago/);
      expect(backend.cancelSubscription).not.toHaveBeenCalled();
      // Past current_period_end fetchBilling no longer returns the row: Free, checkout open.
      backend.fetchBilling.mockResolvedValue(snapshot({ subscription: null }));
      await service.refresh();
      expect(service.getState().currentPlan).toBe("free");
      expect((await service.startCheckout("starter")).pending).toBe("checkout");
    });

    it("a second click while cancelling does not call mp-cancel twice", async () => {
      const { service, backend } = await ready();
      let release: () => void = () => undefined;
      backend.cancelSubscription.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true, code: "canceled" });
          }),
      );
      const first = service.cancelSubscription();
      expect(service.getState().cancelling).toBe(true);
      await service.cancelSubscription();
      release();
      await first;
      expect(backend.cancelSubscription).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores a late fetch for a user who signed out", async () => {
    const { service, backend, auth } = setup();
    let release: (value: ReturnType<typeof snapshot>) => void = () => undefined;
    backend.fetchBilling.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.refresh();
    auth.set(authState(false));
    release(snapshot());
    await pending;
    expect(service.getState()).toMatchObject({ status: "signed-out", wallet: null });
  });
});

describe("billing backend helpers", () => {
  it("accepts only Stripe-hosted https URLs", () => {
    expect(isStripeHostedUrl(SECRET_CHECKOUT_URL, "https://checkout.stripe.com/")).toBe(true);
    expect(
      isStripeHostedUrl("https://checkout.stripe.com:444/x", "https://checkout.stripe.com/"),
    ).toBe(false);
    expect(
      isStripeHostedUrl("https://u@checkout.stripe.com/x", "https://checkout.stripe.com/"),
    ).toBe(false);
  });

  it("maps PostgREST rows and drops Stripe ids", () => {
    const mapped = mapBillingRows({
      plans: [
        {
          plan: "free",
          name: "Free",
          price_usd_cents: 0,
          stripe_price_id: null,
          monthly_credits: 1000,
        },
        {
          plan: "pro",
          name: "Pro",
          price_usd_cents: 2000,
          stripe_price_id: "price_1UMIyIKAHtqpope6sw0xLZDQ",
          monthly_credits: "25000",
        },
        { name: "broken" },
      ],
      catalog: [
        {
          plan: "starter",
          name: "Starter",
          monthly_credits: 10000,
          provider: "mercadopago",
          currency: "BRL",
          amount_minor: 4990,
          sort_order: 1,
        },
      ],
      subscription: {
        plan: "pro",
        status: "active",
        current_period_end: null,
        cancel_at_period_end: true,
        cancel_requested_at: null,
      },
      wallet: { balance: 26000, reserved: 0, plan_allowance: 25000, period_end: null },
    });
    expect(mapped.plans.map((plan) => [plan.plan, plan.purchasable, plan.monthlyCredits])).toEqual([
      ["free", false, 1000],
      ["pro", true, 25000],
    ]);
    expect(mapped.subscription).toMatchObject({
      plan: "pro",
      provider: "stripe",
      cancelAtPeriodEnd: true,
      cancelRequestedAt: null,
    });
    expect(mapped.catalog).toEqual([MP_STARTER]);
    expect(mapped.wallet).toMatchObject({ balance: 26000, planAllowance: 25000 });
    expect(JSON.stringify(mapped)).not.toContain("price_");
  });
});

describe("billing catalog mapping", () => {
  it("keeps well-formed public rows and drops anything else", () => {
    const rows = [
      {
        plan: "starter",
        name: "Starter",
        monthly_credits: "10000",
        provider: "mercadopago",
        currency: "BRL",
        amount_minor: "4990",
        sort_order: 1,
        stripe_price_id: "price_SECRET",
      },
      {
        ...{ plan: "starter", name: "Starter", monthly_credits: 10000, sort_order: 1 },
        provider: "stripe",
        currency: "USD",
        amount_minor: 900,
      },
      { plan: "starter", provider: "paypal", currency: "BRL", amount_minor: 4990 },
      { plan: "Bad", provider: "mercadopago", currency: "BRL", amount_minor: 4990 },
      { plan: "starter", provider: "mercadopago", currency: "brl", amount_minor: 4990 },
      { plan: "starter", provider: "mercadopago", currency: "BRL", amount_minor: 0 },
      null,
    ];
    const mapped = mapCatalogRows(rows);
    expect(mapped).toEqual([MP_STARTER, STRIPE_STARTER]);
    expect(JSON.stringify(mapped)).not.toContain("SECRET");
  });

  it("L5b: maps kind 'pack' rows to credit packs (known ids, Mercado Pago, BRL only), sorted", () => {
    const pack = (patch: Record<string, unknown>) => ({
      plan: "credits_5k",
      name: "5,000 credits",
      monthly_credits: 5000,
      provider: "mercadopago",
      currency: "BRL",
      amount_minor: 3690,
      sort_order: 1,
      kind: "pack",
      ...patch,
    });
    const rows = [
      pack({
        plan: "credits_25k",
        name: "25,000 credits",
        monthly_credits: 25000,
        amount_minor: 18190,
        sort_order: 3,
      }),
      pack({}),
      pack({
        plan: "credits_10k",
        name: "10,000 credits",
        monthly_credits: 10000,
        amount_minor: "7290",
        sort_order: 2,
      }),
      pack({ plan: "credits_1m" }),
      pack({ provider: "stripe" }),
      pack({ currency: "USD" }),
      pack({ amount_minor: 0 }),
      pack({ kind: "subscription" }),
      pack({ kind: undefined }),
      {
        plan: "starter",
        provider: "mercadopago",
        currency: "BRL",
        amount_minor: 4990,
        kind: "subscription",
      },
      null,
    ];
    expect(mapPackRows(rows)).toEqual(PACKS);
    expect(
      mapBillingRows({ plans: [], catalog: rows, subscription: null, wallet: null }).packs,
    ).toEqual(PACKS);
    expect(
      mapBillingRows({ plans: [], catalog: null, subscription: null, wallet: null }).packs,
    ).toBeNull();
  });

  it("L5a: ignores credit-pack catalog rows (kind pack / unknown kinds), keeps kind subscription", () => {
    const pack = {
      plan: "credits_5k",
      name: "5,000 credits",
      monthly_credits: 5000,
      provider: "mercadopago",
      currency: "BRL",
      amount_minor: 3490,
      sort_order: 1,
    };
    const mapped = mapCatalogRows([
      { ...pack, kind: "pack" },
      { ...pack, plan: "credits_x", kind: "bundle" },
      { ...pack, plan: "credits_y", kind: null },
      {
        plan: "starter",
        name: "Starter",
        monthly_credits: 20000,
        provider: "mercadopago",
        currency: "BRL",
        amount_minor: 4990,
        sort_order: 1,
        kind: "subscription",
      },
    ]);
    expect(mapped.map((e) => e.plan)).toEqual(["starter"]);
  });

  it("maps a mercadopago subscription row", () => {
    const mapped = mapBillingRows({
      plans: [],
      catalog: null,
      subscription: { plan: "starter", provider: "mercadopago", status: "active" },
      wallet: null,
    });
    expect(mapped.catalog).toBeNull();
    expect(mapped.subscription).toMatchObject({ plan: "starter", provider: "mercadopago" });
  });

  it("maps cancel_requested_at to cancelRequestedAt (a time only, no ids)", () => {
    const row = {
      plan: "starter",
      provider: "mercadopago",
      status: "active",
      cancel_at_period_end: false,
      cancel_requested_at: "2026-10-03T23:50:00+00:00",
      provider_subscription_id: "SECRET_preapproval",
    };
    const mapped = mapBillingRows({ plans: [], catalog: null, subscription: row, wallet: null });
    expect(mapped.subscription).toEqual({
      plan: "starter",
      provider: "mercadopago",
      status: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelRequestedAt: "2026-10-03T23:50:00+00:00",
    });
    expect(JSON.stringify(mapped)).not.toContain("SECRET_preapproval");
    const none = mapBillingRows({
      plans: [],
      catalog: null,
      subscription: { ...row, cancel_requested_at: null },
      wallet: null,
    });
    expect(none.subscription?.cancelRequestedAt).toBeNull();
  });
});

describe("live subscription set (paused included)", () => {
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
  const read = (path: string) => readFileSync(`${repo}${path}`, "utf8");
  const quoted = (text: string) => [...text.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);

  it("is active, trialing, past_due, unpaid, incomplete, paused", () => {
    expect([...LIVE_SUBSCRIPTION_STATUSES].sort()).toEqual(
      ["active", "incomplete", "past_due", "paused", "trialing", "unpaid"].sort(),
    );
  });

  it("matches the Edge Functions, mp_cancel_targets and the DB unique index (minus incomplete)", () => {
    const db = read("supabase/functions/_shared/db.ts");
    const edge = db.match(/export const LIVE_SUBSCRIPTION_STATUSES = \[([^\]]*)\]/);
    expect(quoted(edge?.[1] ?? "").sort()).toEqual([...LIVE_SUBSCRIPTION_STATUSES].sort());

    const l1e = read("supabase/migrations/20261003230000_l1e_mp_cancel.sql");
    const targets = l1e.match(/su\.status in \(([^)]*)\)/);
    expect(quoted(targets?.[1] ?? "").sort()).toEqual([...LIVE_SUBSCRIPTION_STATUSES].sort());

    const index = read("supabase/migrations/20261004000000_paused_live.sql");
    const predicate = index.match(
      /create unique index subscriptions_one_live_per_user[^;]*status in \(([^)]*)\)/,
    );
    expect(quoted(predicate?.[1] ?? "").sort()).toEqual(
      LIVE_SUBSCRIPTION_STATUSES.filter((status) => status !== "incomplete").sort(),
    );
  });
});
