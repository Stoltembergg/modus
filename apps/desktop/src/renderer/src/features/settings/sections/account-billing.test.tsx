// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingCatalogEntry, BillingState } from "../../../../../shared/billing";
import {
  AccountBillingSection,
  BillingSectionView,
  formatCredits,
  formatMoney,
  formatPrice,
  groupCatalog,
} from "./account-billing";

afterEach(() => {
  cleanup();
  delete (window as { modus?: unknown }).modus;
});

const PLANS = [
  { plan: "free", name: "Free", priceUsdCents: 0, monthlyCredits: 1000, purchasable: false },
  {
    plan: "starter",
    name: "Starter",
    priceUsdCents: 900,
    monthlyCredits: 10000,
    purchasable: true,
  },
];

const MP_STARTER: BillingCatalogEntry = {
  plan: "starter",
  name: "Starter",
  monthlyCredits: 10000,
  provider: "mercadopago",
  currency: "BRL",
  amountMinor: 4990,
  sortOrder: 1,
};
const STRIPE_STARTER: BillingCatalogEntry = {
  ...MP_STARTER,
  provider: "stripe",
  currency: "USD",
  amountMinor: 900,
};

const READY: BillingState = {
  status: "ready",
  plans: PLANS,
  catalog: [MP_STARTER],
  subscription: null,
  wallet: { balance: 1000, reserved: 0, planAllowance: 1000, periodEnd: null },
  currentPlan: "free",
  pending: null,
  lastReturn: null,
  error: null,
};

const noop = () => undefined;
const markup = (state: BillingState | undefined) =>
  renderToStaticMarkup(
    <BillingSectionView
      busy={false}
      onCheckout={noop}
      onPortal={noop}
      onRefresh={noop}
      state={state}
    />,
  );

describe("Account billing formatting", () => {
  it("formats BRL from minor units with pt-BR separators", () => {
    expect(formatMoney(4990, "BRL")).toBe("R$ 49,90");
    expect(formatMoney(10990, "BRL")).toBe("R$ 109,90");
    expect(formatMoney(900, "USD")).toBe("$9.00");
    expect(formatCredits(10000)).toBe("10,000");
    expect(formatPrice(0)).toBe("Free");
    expect(formatPrice(1999)).toBe("$19.99/mo");
  });

  it("groups catalog rows per plan with Mercado Pago first", () => {
    const grouped = groupCatalog([STRIPE_STARTER, MP_STARTER]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.offers.map((offer) => offer.provider)).toEqual(["mercadopago", "stripe"]);
  });
});

describe("Account billing section", () => {
  it("renders nothing until signed in", () => {
    expect(markup(undefined)).toBe("");
    expect(markup({ ...READY, status: "signed-out" })).toBe("");
    expect(markup({ ...READY, status: "unavailable" })).toBe("");
  });

  it("offers Starter through Mercado Pago in BRL and hides Stripe without a stripe row", () => {
    const html = markup(READY);
    expect(html).toContain("Plan &amp; credits");
    expect(html).toContain("Mercado Pago");
    expect(html).toContain("Starter · R$ 49,90/mo");
    expect(html).toContain("10,000 credits per month");
    expect(html).toContain("Subscribe with Mercado Pago");
    expect(html).not.toMatch(/Stripe|card/i);
    expect(html).not.toContain("Choose Free");
    expect(html).not.toContain("Manage billing");
  });

  it("shows the Stripe option only when the catalog returns a stripe row", () => {
    const html = markup({ ...READY, catalog: [MP_STARTER, STRIPE_STARTER] });
    expect(html).toContain("Subscribe with Mercado Pago");
    expect(html).toContain("Pay by card (Stripe)");
    expect(html).toContain("R$ 49,90/mo or $9.00/mo");
  });

  it("has loading, error and empty catalog states without a buy button", () => {
    const loading = markup({ ...READY, status: "loading", catalog: null });
    expect(loading).toContain("Loading…");
    expect(loading).not.toContain("Subscribe with");
    const failed = markup({ ...READY, catalog: null });
    expect(failed).toContain("Plans unavailable");
    expect(failed).not.toContain("Subscribe with");
    const empty = markup({ ...READY, catalog: [] });
    expect(empty).toContain("No plans available");
    expect(empty).not.toContain("Subscribe with");
    const errored = markup({ ...READY, status: "error", catalog: null, error: "Billing is down" });
    expect(errored).toContain("Billing is down");
    expect(errored).not.toContain("Subscribe with");
  });

  it("shows a checkout error from the Function and keeps the button usable", () => {
    const html = markup({
      ...READY,
      error: "Mercado Pago is unavailable right now. Try again in a few minutes.",
    });
    expect(html).toContain("Mercado Pago is unavailable right now");
    expect(html).toContain("Subscribe with Mercado Pago");
  });

  it("does not offer a purchase to a subscribed user; Stripe subscribers keep the Portal", () => {
    const mp = markup({
      ...READY,
      currentPlan: "starter",
      subscription: {
        plan: "starter",
        provider: "mercadopago",
        status: "active",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
      wallet: { balance: 11000, reserved: 0, planAllowance: 10000, periodEnd: null },
      lastReturn: "success",
    });
    expect(mp).not.toContain("Subscribe with");
    expect(mp).not.toContain("Manage billing");
    expect(mp).toContain("billed by Mercado Pago");
    expect(mp).toContain("11,000");
    expect(mp).toContain("Payment received");
    expect(mp).not.toContain("Stripe");

    const stripe = markup({
      ...READY,
      currentPlan: "starter",
      subscription: {
        plan: "starter",
        provider: "stripe",
        status: "active",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });
    expect(stripe).toContain("Manage billing");
    expect(stripe).not.toContain("Subscribe with");
  });

  it("disables buying while a checkout is pending in the browser", () => {
    render(
      <BillingSectionView
        busy={false}
        onCheckout={noop}
        onPortal={noop}
        onRefresh={noop}
        state={{ ...READY, pending: "checkout" }}
      />,
    );
    expect(screen.getByText("Finish in your browser, then come back to Modus.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Subscribe with Mercado Pago/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("sends {plan, provider} through window.modus.billing.checkout on click", async () => {
    const checkout = vi.fn(async () => ({ ...READY, pending: "checkout" as const }));
    (window as { modus?: unknown }).modus = {
      billing: {
        getState: vi.fn(async () => ({ ...READY, catalog: [MP_STARTER, STRIPE_STARTER] })),
        refresh: vi.fn(async () => READY),
        checkout,
        openPortal: vi.fn(async () => READY),
        onStateChange: vi.fn(() => () => undefined),
      },
    };
    render(<AccountBillingSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Subscribe with Mercado Pago/ }));
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith({ plan: "starter", provider: "mercadopago" }),
    );
    await screen.findByText("Finish in your browser, then come back to Modus.");
  });

  it("passes the stripe provider when the Stripe option is clicked", async () => {
    const checkout = vi.fn(async () => READY);
    (window as { modus?: unknown }).modus = {
      billing: {
        getState: vi.fn(async () => ({ ...READY, catalog: [MP_STARTER, STRIPE_STARTER] })),
        refresh: vi.fn(async () => READY),
        checkout,
        openPortal: vi.fn(async () => READY),
        onStateChange: vi.fn(() => () => undefined),
      },
    };
    render(<AccountBillingSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Pay by card \(Stripe\)/ }));
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith({ plan: "starter", provider: "stripe" }),
    );
  });
});
