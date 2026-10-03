import { describe, expect, it, vi } from "vitest";
import type { BillingState } from "../../shared/billing";
import { AuthBackendError } from "../auth/auth-backend";
import {
  authState,
  createFakeAuth,
  createFakeBillingBackend,
  SECRET_CHECKOUT_URL,
  SECRET_PORTAL_URL,
  snapshot,
  USER_ID,
} from "./billing.test-helpers";
import { isStripeHostedUrl, mapBillingRows } from "./billing-backend";
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
          status: "active",
          currentPeriodEnd: "2026-11-03T03:00:00Z",
          cancelAtPeriodEnd: false,
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

  it("opens Checkout for a plan key only and never exposes the session URL", async () => {
    const { service, backend, openExternal, events } = setup();
    await service.refresh();
    const state = await service.startCheckout("starter");
    expect(backend.createBillingSession).toHaveBeenCalledWith("create-checkout-session", {
      plan: "starter",
    });
    expect(openExternal).toHaveBeenCalledWith(SECRET_CHECKOUT_URL);
    expect(state.pending).toBe("checkout");
    expect(JSON.stringify(events)).not.toContain("cs_test_SECRET");
  });

  it("refuses unknown, free or malformed plans before calling the Function", async () => {
    const { service, backend } = setup();
    await service.refresh();
    for (const plan of ["free", "enterprise", "Pro", "price_123", ""]) {
      expect((await service.startCheckout(plan)).error).toMatch(/not available/);
    }
    expect(backend.createBillingSession).not.toHaveBeenCalled();
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
    expect((await service.startCheckout("pro")).error).toMatch(/Manage billing/);
    backend.createBillingSession.mockRejectedValueOnce(new AuthBackendError("network", "x"));
    expect((await service.openPortal()).error).toMatch(/connection/);
  });

  it("never opens a URL that is not Stripe-hosted", async () => {
    const { service, backend, openExternal } = setup();
    await service.refresh();
    for (const url of [
      "https://checkout.stripe.com.evil.example/c/pay",
      "http://checkout.stripe.com/c/pay",
      "https://billing.stripe.com/p/session/x",
      "javascript:alert(1)",
    ]) {
      backend.createBillingSession.mockResolvedValueOnce({ ok: true, url });
      expect((await service.startCheckout("pro")).error).toMatch(/unavailable/);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refreshes on billing/return and again while the webhook catches up", async () => {
    const { service, backend, timers } = setup();
    await service.refresh();
    await service.startCheckout("pro");
    backend.fetchBilling.mockClear();
    const state = await service.handleReturn("success");
    expect(state).toMatchObject({ pending: null, lastReturn: "success" });
    expect(backend.fetchBilling).toHaveBeenCalledTimes(1);
    expect(timers.map((timer) => timer.ms)).toEqual([4_000, 12_000]);
    for (const timer of timers) timer.run();
    await vi.waitFor(() => expect(backend.fetchBilling).toHaveBeenCalledTimes(3));
    service.dispose();
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
      subscription: {
        plan: "pro",
        status: "active",
        current_period_end: null,
        cancel_at_period_end: true,
      },
      wallet: { balance: 26000, reserved: 0, plan_allowance: 25000, period_end: null },
    });
    expect(mapped.plans.map((plan) => [plan.plan, plan.purchasable, plan.monthlyCredits])).toEqual([
      ["free", false, 1000],
      ["pro", true, 25000],
    ]);
    expect(mapped.subscription).toMatchObject({ plan: "pro", cancelAtPeriodEnd: true });
    expect(mapped.wallet).toMatchObject({ balance: 26000, planAllowance: 25000 });
    expect(JSON.stringify(mapped)).not.toContain("price_");
  });
});
