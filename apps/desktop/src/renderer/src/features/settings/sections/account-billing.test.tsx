import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BillingState } from "../../../../../shared/billing";
import { BillingSectionView, formatCredits, formatPrice } from "./account-billing";

const PLANS = [
  { plan: "free", name: "Free", priceUsdCents: 0, monthlyCredits: 1000, purchasable: false },
  {
    plan: "starter",
    name: "Starter",
    priceUsdCents: 900,
    monthlyCredits: 10000,
    purchasable: true,
  },
  { plan: "pro", name: "Pro", priceUsdCents: 2000, monthlyCredits: 25000, purchasable: true },
];

const READY: BillingState = {
  status: "ready",
  plans: PLANS,
  subscription: null,
  wallet: { balance: 1000, reserved: 0, planAllowance: 1000, periodEnd: null },
  currentPlan: "free",
  pending: null,
  lastReturn: null,
  error: null,
};

const noop = () => undefined;
const render = (state: BillingState | undefined) =>
  renderToStaticMarkup(
    <BillingSectionView
      busy={false}
      onCheckout={noop}
      onPortal={noop}
      onRefresh={noop}
      state={state}
    />,
  );

describe("Account billing section", () => {
  it("formats prices and credits", () => {
    expect(formatPrice(0)).toBe("Free");
    expect(formatPrice(900)).toBe("$9/mo");
    expect(formatPrice(1999)).toBe("$19.99/mo");
    expect(formatCredits(150000)).toBe("150,000");
  });

  it("renders nothing until signed in", () => {
    expect(render(undefined)).toBe("");
    expect(render({ ...READY, status: "signed-out" })).toBe("");
    expect(render({ ...READY, status: "unavailable" })).toBe("");
  });

  it("offers Checkout for paid plans when there is no subscription", () => {
    const markup = render(READY);
    expect(markup).toContain("Plan &amp; credits");
    expect(markup).toContain("Choose Starter");
    expect(markup).toContain("Choose Pro");
    expect(markup).not.toContain("Choose Free");
    expect(markup).not.toContain("Manage billing");
  });

  it("offers the Portal when subscribed and shows the return notice", () => {
    const markup = render({
      ...READY,
      currentPlan: "pro",
      subscription: {
        plan: "pro",
        status: "active",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
      wallet: { balance: 26000, reserved: 0, planAllowance: 25000, periodEnd: null },
      lastReturn: "success",
    });
    expect(markup).toContain("Manage billing");
    expect(markup).not.toContain("Choose Starter");
    expect(markup).toContain("26,000");
    expect(markup).toContain("Payment received");
  });
});
