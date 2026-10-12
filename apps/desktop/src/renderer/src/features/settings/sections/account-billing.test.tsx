// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BillingCatalogEntry,
  BillingCreditPack,
  BillingState,
  BillingSubscription,
} from "../../../../../shared/billing";
import {
  AccountBillingSection,
  BillingSectionView,
  cancelConfirmMessage,
  creditCount,
  creditsDescription,
  formatCredits,
  formatMoney,
  groupCatalog,
  packTitle,
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
  packs: [],
  subscription: null,
  wallet: { balance: 1000, reserved: 0, planAllowance: 1000, periodEnd: null },
  currentPlan: "free",
  pending: null,
  cancelling: false,
  lastReturn: null,
  error: null,
};

const noop = () => undefined;
const PACK_5K: BillingCreditPack = {
  packId: "credits_5k",
  name: "5,000 credits",
  credits: 5000,
  currency: "BRL",
  amountMinor: 3690,
  sortOrder: 1,
};
const markup = (state: BillingState | undefined, accessPlan?: string) =>
  renderToStaticMarkup(
    <BillingSectionView
      accessPlan={accessPlan}
      busy={false}
      onCheckout={noop}
      onPortal={noop}
      onRefresh={noop}
      onCancel={noop}
      onBuyCredits={noop}
      state={state}
    />,
  );

describe("Account billing formatting", () => {
  /** Intl may separate the currency symbol with a (narrow) no-break space. */
  const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

  it("credits and money follow the given locale (the app passes the system one)", () => {
    const pack = PACK_5K;
    expect(plain(packTitle(pack, "pt-BR"))).toBe("5.000 credits for R$ 36,90");
    expect(plain(packTitle(pack, "en-US"))).toBe("5,000 credits for R$36.90");
    expect(plain(formatMoney(10990, "BRL", "pt-BR"))).toBe("R$ 109,90");
    expect(formatMoney(900, "USD", "en-US")).toBe("$9.00");
    expect(formatCredits(10000, "pt-BR")).toBe("10.000");
    expect(creditCount(1, "en-US")).toBe("1 credit");
    // No locale: the system's, exactly what Intl.NumberFormat(undefined) gives.
    expect(formatCredits(10000)).toBe(new Intl.NumberFormat(undefined).format(10000));
    expect(formatMoney(3690, "BRL")).toBe(
      new Intl.NumberFormat(undefined, { style: "currency", currency: "BRL" }).format(36.9),
    );
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
    expect(html).toContain("Plan and credits");
    expect(html).toContain("Mercado Pago");
    expect(html).toContain(`Starter for ${formatMoney(4990, "BRL")} a month`);
    expect(html).toContain(`${creditCount(10000)} a month`);
    expect(html).not.toContain(" · ");
    expect(html).toContain("Subscribe</button>");
    expect(html).not.toMatch(/Stripe|card/i);
    expect(html).not.toContain("Subscribe with");
    expect(html).not.toContain("Choose Free");
    expect(html).not.toContain("Manage billing");
  });

  it("shows the Stripe option only when the catalog returns a stripe row", () => {
    const html = markup({ ...READY, catalog: [MP_STARTER, STRIPE_STARTER] });
    expect(html).toContain("Subscribe</button>");
    expect(html).toContain("Pay by card (Stripe)");
    expect(html).toContain(
      `${formatMoney(4990, "BRL")} a month or ${formatMoney(900, "USD")} a month`,
    );
  });

  it("has loading, error and empty catalog states without a buy button", () => {
    const loading = markup({ ...READY, status: "loading", catalog: null });
    expect(loading).toContain("Loading…");
    expect(loading).not.toContain("Subscribe</button>");
    const failed = markup({ ...READY, catalog: null });
    expect(failed).toContain("Credit packs couldn&#x27;t be loaded");
    expect(failed).toContain("Try again</button>");
    expect(failed).not.toContain("Subscribe</button>");
    const empty = markup({ ...READY, catalog: [] });
    expect(empty).toContain("Credit packs aren&#x27;t on sale");
    expect(empty).toContain("Refresh</button>");
    expect(empty).not.toContain("No plans available");
    expect(empty).not.toContain("Subscribe</button>");
    const errored = markup({ ...READY, status: "error", catalog: null, error: "Billing is down" });
    expect(errored).toContain("Billing is down");
    expect(errored).not.toContain("Subscribe</button>");
  });

  it("shows a checkout error from the Function and keeps the button usable", () => {
    const html = markup({
      ...READY,
      error: "Mercado Pago is unavailable right now. Try again in a few minutes.",
    });
    expect(html).toContain("Mercado Pago is unavailable right now");
    expect(html).toContain("Subscribe</button>");
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
        cancelRequestedAt: null,
      },
      wallet: { balance: 11000, reserved: 0, planAllowance: 10000, periodEnd: null },
      lastReturn: "success",
    });
    expect(mp).not.toContain("Subscribe</button>");
    expect(mp).not.toContain("Manage billing");
    expect(mp).toContain("billed by Mercado Pago");
    expect(mp).toContain(formatCredits(11000));
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
        cancelRequestedAt: null,
      },
    });
    expect(stripe).toContain("Manage billing");
    expect(stripe).not.toContain("Subscribe</button>");
  });

  it("disables buying while a checkout is pending in the browser", () => {
    render(
      <BillingSectionView
        busy={false}
        onCheckout={noop}
        onPortal={noop}
        onRefresh={noop}
        onCancel={noop}
        onBuyCredits={noop}
        state={{ ...READY, pending: "checkout" }}
      />,
    );
    expect(screen.getByText("Finish in your browser, then come back to Modus.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /^Subscribe$/ }) as HTMLButtonElement).disabled,
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
    fireEvent.click(await screen.findByRole("button", { name: /^Subscribe$/ }));
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

describe("Mercado Pago cancel (L1e)", () => {
  const MP_ACTIVE: BillingSubscription = {
    plan: "starter",
    provider: "mercadopago",
    status: "active",
    currentPeriodEnd: "2026-11-03T00:00:00Z",
    cancelAtPeriodEnd: false,
    cancelRequestedAt: null,
  };
  /** How the view formats MP_ACTIVE.currentPeriodEnd (client locale / zone). */
  const UNTIL = new Date("2026-11-03T00:00:00Z").toLocaleDateString();
  const subscribed = (
    sub: Partial<BillingSubscription> = {},
    patch: Partial<BillingState> = {},
  ): BillingState => ({
    ...READY,
    currentPlan: "starter",
    subscription: { ...MP_ACTIVE, ...sub },
    ...patch,
  });

  /** happy-dom has no window.confirm: install a mock for the test. */
  function stubConfirm() {
    const fn = vi.fn((_message?: string) => false);
    Object.defineProperty(window, "confirm", { value: fn, configurable: true, writable: true });
    return fn;
  }

  function mount(initial: BillingState, cancelSubscription: () => Promise<BillingState>) {
    let push: (state: BillingState) => void = () => undefined;
    const cancel = vi.fn(cancelSubscription);
    (window as { modus?: unknown }).modus = {
      billing: {
        getState: vi.fn(async () => initial),
        refresh: vi.fn(async () => initial),
        checkout: vi.fn(async () => initial),
        openPortal: vi.fn(async () => initial),
        cancelSubscription: cancel,
        onStateChange: vi.fn((listener: (state: BillingState) => void) => {
          push = listener;
          return () => undefined;
        }),
      },
    };
    render(<AccountBillingSection />);
    return { push: (state: BillingState) => act(() => push(state)), cancel };
  }

  it("active: Cancel subscription (no Subscribe), the confirm says no refund and credits stay", () => {
    const html = markup(subscribed());
    expect(html).toContain("Cancel subscription");
    expect(html).not.toContain("Subscribe</button>");
    expect(html).not.toContain("Payment pending");
    expect(cancelConfirmMessage("Starter", UNTIL)).toMatch(/Starter.*Nothing is refunded.*credits/);
  });

  it("L1g: the cancel copy promises the plan until current_period_end, then Free", () => {
    expect(cancelConfirmMessage("Starter", "11/3/2026")).toBe(
      "Cancel your Starter subscription? Mercado Pago stops future charges. You keep Starter until 11/3/2026; after that you move to Free. Nothing is refunded, and the credits you already have stay in your account.",
    );
    expect(cancelConfirmMessage("Starter", null)).toContain(
      "You keep Starter until the end of the period you paid for; after that you move to Free.",
    );
    // A paused row is already on the Free plan's models: no "you keep" promise.
    expect(cancelConfirmMessage("Starter", "11/3/2026", false)).toBe(
      "Cancel your Starter subscription? Mercado Pago stops future charges. Nothing is refunded, and the credits you already have stay in your account.",
    );
    const html = markup(subscribed());
    expect(html).toContain(
      `You keep Starter until ${UNTIL}, then Free. No refund; your credits stay.`,
    );
    expect(markup(subscribed({ status: "paused" }))).not.toContain("You keep");
  });

  it("L1g: cancelled but paid until the period end: Starter until <date>, no buttons, no Subscribe", () => {
    const grace = subscribed({ status: "canceled", cancelAtPeriodEnd: true });
    const html = markup(grace);
    expect(html).toContain(`Cancelled. You keep Starter until ${UNTIL}.`);
    expect(html).toContain("Subscription cancelled");
    expect(html).toContain(`You keep Starter until ${UNTIL}; after that you move to Free`);
    expect(html).not.toContain(">Cancel subscription</button>");
    expect(html).not.toContain("Check again");
    expect(html).not.toContain("Subscribe</button>");
    expect(html).not.toContain("renews");
    // A late cancelRequestedAt never brings back the "cancel requested" state here.
    expect(
      markup(
        subscribed({
          status: "canceled",
          cancelAtPeriodEnd: true,
          cancelRequestedAt: "2026-10-03T23:50:00Z",
        }),
      ),
    ).not.toContain("Waiting for Mercado Pago to confirm");
    // Without a date the copy still holds.
    expect(
      markup(subscribed({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: null })),
    ).toContain("Cancelled. You keep Starter until the period ends.");
  });

  it("L1g: after the period end the grace row is gone and Free + Subscribe are back", async () => {
    const confirm = stubConfirm().mockReturnValue(true);
    const grace = subscribed({ status: "canceled", cancelAtPeriodEnd: true });
    const { push } = mount(subscribed(), async () => grace);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(confirm).toHaveBeenCalledWith(cancelConfirmMessage("Starter", UNTIL));
    await screen.findByText(`Cancelled. You keep Starter until ${UNTIL}.`);
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    // The next read no longer finds the row (current_period_end passed): Free.
    push(READY);
    await screen.findByRole("button", { name: /^Subscribe$/ });
    expect(screen.getByText("Tops up to 1,000 credits each month.")).toBeTruthy();
    confirm.mockRestore();
  });

  it("L1g: while waiting for Mercado Pago the requested copy repeats the until-date", () => {
    const html = markup(subscribed({ cancelRequestedAt: "2026-10-03T23:50:00Z" }));
    expect(html).toContain(`Waiting for Mercado Pago to confirm. You keep Starter until ${UNTIL}.`);
  });

  it("incomplete: Payment pending with Cancel and try again, never a Subscribe button", () => {
    const html = markup(subscribed({ status: "incomplete" }));
    expect(html).toContain("Payment pending");
    expect(html).toContain("Cancel and try again");
    expect(html).not.toContain("Subscribe</button>");
    expect(html).not.toContain(">Cancel subscription<");
  });

  it("cancelling: no cancel / subscribe buttons, only the disabled Cancelling… state", () => {
    render(
      <BillingSectionView
        busy={false}
        onCheckout={noop}
        onPortal={noop}
        onRefresh={noop}
        onCancel={noop}
        onBuyCredits={noop}
        state={subscribed({}, { cancelling: true })}
      />,
    );
    const button = screen.getByRole("button", { name: "Cancelling…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
  });

  it("the requested state comes from cancelRequestedAt, not cancelAtPeriodEnd", () => {
    const requested = markup(subscribed({ cancelRequestedAt: "2026-10-03T23:50:00Z" }));
    expect(requested).toContain("Waiting for Mercado Pago to confirm");
    expect(requested).toContain("Check again");
    expect(requested).not.toContain("Subscribe</button>");
    // cancel_at_period_end is Stripe's / L1g's: it never means "cancel requested" for MP.
    const periodEnd = markup(subscribed({ cancelAtPeriodEnd: true }));
    expect(periodEnd).not.toContain("Waiting for Mercado Pago to confirm");
    expect(periodEnd).toContain("Cancel subscription");
  });

  it("paused: Subscription paused, Cancel subscription visible, Subscribe blocked", () => {
    const html = markup(subscribed({ status: "paused" }));
    expect(html).toContain("Subscription paused");
    expect(html).toContain("only the Free plan&#x27;s models");
    expect(html).toContain(">Cancel subscription</button>");
    expect(html).not.toContain("Subscribe</button>");
    expect(html).not.toContain("Payment pending");
  });

  it("Current plan pill: '<Plan> (paused)' while paused, the plain plan name otherwise", () => {
    const view = (state: BillingState) =>
      render(
        <BillingSectionView
          busy={false}
          onCheckout={noop}
          onPortal={noop}
          onRefresh={noop}
          onCancel={noop}
          onBuyCredits={noop}
          state={state}
        />,
      );
    view(subscribed({ status: "paused" }));
    expect(screen.getByText("Starter (paused)")).toBeTruthy();
    cleanup();
    view(subscribed({ provider: "stripe", status: "paused" }));
    expect(screen.getByText("Starter (paused)")).toBeTruthy();
    cleanup();
    view(subscribed());
    expect(screen.getByText("Starter")).toBeTruthy();
    expect(screen.queryByText(/\(paused\)/)).toBeNull();
  });

  it("paused: Cancel subscription asks to confirm, then calls cancelSubscription()", async () => {
    const confirm = stubConfirm().mockReturnValue(true);
    const { cancel } = mount(subscribed({ status: "paused" }), async () => READY);
    // The status line and the row title; a paused subscription does not "renew".
    expect(await screen.findAllByText(/^Subscription paused\.?$/)).toHaveLength(2);
    expect(screen.queryByText(/renews/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(confirm).toHaveBeenCalledWith(cancelConfirmMessage("Starter", UNTIL, false));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith());
    await screen.findByRole("button", { name: /^Subscribe$/ });
  });

  it("Stripe subscribers get no Mercado Pago cancel button", () => {
    const html = markup(subscribed({ provider: "stripe" }));
    expect(html).not.toContain("Cancel subscription");
    expect(html).toContain("Manage billing");
  });

  it("active: declining the confirm does nothing; accepting calls cancelSubscription()", async () => {
    const confirm = stubConfirm().mockReturnValueOnce(false);
    const { cancel } = mount(subscribed(), async () => READY);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(confirm).toHaveBeenCalledWith(cancelConfirmMessage("Starter", UNTIL));
    expect(cancel).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith());
    await screen.findByRole("button", { name: /^Subscribe$/ });
    confirm.mockRestore();
  });

  it("cancel not confirmed yet: Subscribe stays blocked until the status leaves the live set", async () => {
    const confirm = stubConfirm().mockReturnValue(true);
    const requested = subscribed({ cancelRequestedAt: "2026-10-03T23:50:00Z" });
    const { push } = mount(subscribed(), async () => requested);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    await screen.findByText(/Waiting for Mercado Pago to confirm/);
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    // A refresh that still reads the live row keeps it blocked.
    push(requested);
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    // A late `authorized` webhook (status active again, request kept): still requested, blocked.
    push(subscribed({ status: "active", cancelRequestedAt: "2026-10-03T23:50:00Z" }));
    expect(screen.getByText(/Waiting for Mercado Pago to confirm/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    // The webhook confirms: the live subscription is gone, Subscribe is back.
    push(READY);
    await screen.findByRole("button", { name: /^Subscribe$/ });
    confirm.mockRestore();
  });

  it("incomplete -> Cancel and try again -> Cancelling… -> Subscribe", async () => {
    const confirm = stubConfirm();
    let finish: (state: BillingState) => void = () => undefined;
    const { push, cancel } = mount(
      subscribed({ status: "incomplete" }),
      () =>
        new Promise<BillingState>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel and try again" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    push(subscribed({ status: "incomplete" }, { cancelling: true }));
    await screen.findByRole("button", { name: "Cancelling…" });
    expect(screen.queryByRole("button", { name: /^Subscribe$/ })).toBeNull();
    await act(async () => finish(READY));
    await screen.findByRole("button", { name: /^Subscribe$/ });
    confirm.mockRestore();
  });

  it("a cancel error is shown and the button stays available", () => {
    const html = markup(
      subscribed(
        { status: "incomplete" },
        { error: "Mercado Pago is unavailable right now. Try again in a few minutes." },
      ),
    );
    expect(html).toContain("Mercado Pago is unavailable");
    expect(html).toContain("Cancel and try again");
  });
});

describe("L5b credit packs", () => {
  const PACKS: BillingCreditPack[] = [
    PACK_5K,
    {
      packId: "credits_10k",
      name: "10,000 credits",
      credits: 10000,
      currency: "BRL",
      amountMinor: 7290,
      sortOrder: 2,
    },
    {
      packId: "credits_25k",
      name: "25,000 credits",
      credits: 25000,
      currency: "BRL",
      amountMinor: 18190,
      sortOrder: 3,
    },
  ];
  /** Mercado Pago subscriptions off server-side: the catalog has no plan, only packs. */
  const PACKS_ONLY: BillingState = { ...READY, catalog: [], packs: PACKS };

  it("subscriptions off: Buy credits for each pack, no Subscribe and no empty-catalog row", () => {
    const html = markup(PACKS_ONLY);
    for (const pack of PACKS) expect(html).toContain(packTitle(pack));
    expect(html.match(/Buy credits<\/button>/g)).toHaveLength(3);
    expect(html).toContain("One-time payment with Pix or card. Purchased credits never expire.");
    expect(html).toContain("Credit packs</h3>");
    expect(html).toContain(
      "Buy credit packs in your browser with Pix or card, in Brazilian reais. Your credits are added as soon as Mercado Pago confirms the payment.",
    );
    expect(html).not.toContain("Subscribe</button>");
    expect(html).not.toContain("aren&#x27;t on sale");
    expect(html).not.toContain("No plans available");
    expect(html).not.toContain("billed monthly");
    expect(html).not.toContain(" · ");
  });

  it("'billed monthly' only when a subscription plan is on sale (never while loading or failed)", () => {
    expect(markup(READY)).toContain("billed monthly");
    expect(markup({ ...PACKS_ONLY, status: "loading", catalog: null })).not.toContain(
      "billed monthly",
    );
    expect(markup({ ...READY, catalog: null, packs: null })).not.toContain("billed monthly");
  });

  it("no packs at all: 'Credit packs aren't on sale' with a Refresh button that refreshes", () => {
    const onRefresh = vi.fn();
    render(
      <BillingSectionView
        busy={false}
        onCheckout={noop}
        onPortal={noop}
        onRefresh={onRefresh}
        onCancel={noop}
        onBuyCredits={noop}
        state={{ ...READY, catalog: [], packs: [] }}
      />,
    );
    expect(screen.getByText("Credit packs aren't on sale")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("Free plus a Starter pack: the plan stays Free and the pack's Starter access is said plainly", () => {
    const html = markup(PACKS_ONLY, "starter");
    expect(html).toContain(">Free<");
    expect(html).toContain(
      "Tops up to 1,000 credits each month. Your credit pack unlocks Starter models.",
    );
  });

  it("a 25k pack (router plan pro) says Pro models", () => {
    const plans = [
      ...PLANS,
      { plan: "pro", name: "Pro", priceUsdCents: 0, monthlyCredits: 25000, purchasable: false },
    ];
    expect(markup({ ...PACKS_ONLY, plans }, "pro")).toContain(
      "Your credit pack unlocks Pro models.",
    );
    // Not in the loaded plans list: the plan id, capitalized.
    expect(markup(PACKS_ONLY, "pro")).toContain("Your credit pack unlocks Pro models.");
  });

  it("no access line when the router plan is the current plan, unknown, or a subscription grants it", () => {
    for (const html of [markup(PACKS_ONLY, "free"), markup(PACKS_ONLY)]) {
      expect(html).not.toContain("unlocks");
    }
    const subscribed = markup(
      {
        ...PACKS_ONLY,
        currentPlan: "starter",
        subscription: {
          plan: "starter",
          provider: "mercadopago",
          status: "active",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          cancelRequestedAt: null,
        },
      },
      "pro",
    );
    expect(subscribed).not.toContain("unlocks");
  });

  it("the Credits row uses the real remaining allowance and purchased credits, never a fixed 1,000", () => {
    const wallet = {
      balance: 9640,
      reserved: 0,
      planAllowance: 1000,
      periodEnd: null,
      purchased: 9000,
      allowance: 640,
    };
    expect(creditsDescription(wallet, "Free", "en-US")).toBe(
      "640 credits from your Free plan are used first, then 9,000 credits purchased, which never expire.",
    );
    expect(creditsDescription({ ...wallet, purchased: 0, allowance: 380 }, "Free", "pt-BR")).toBe(
      "380 credits from your Free plan.",
    );
    expect(creditsDescription({ ...wallet, balance: 9639, reserved: 1 }, "Free", "en-US")).toBe(
      "639 credits from your Free plan are used first, then 9,000 credits purchased, which never expire. Another 1 credit is held for requests in progress.",
    );
    const { purchased: _p, allowance: _a, ...unknownLots } = wallet;
    expect(creditsDescription(unknownLots, "Free")).toBe(
      "Credits from your Free plan are used first, then purchased credits, which never expire.",
    );
    const html = markup({ ...PACKS_ONLY, wallet });
    expect(html).toContain(creditsDescription(wallet, "Free"));
    // The Credits row shows the remaining allowance; 1,000 only appears as the plan's monthly top-up.
    expect(creditsDescription(wallet, "Free")).not.toContain(formatCredits(1000));
    expect(html).toContain(`>${formatCredits(9640)}<`);
  });

  it("splits allowance and purchased correctly when credits are reserved (adds up to balance pill)", () => {
    const wallet = {
      balance: 9640,
      reserved: 360,
      planAllowance: 1000,
      periodEnd: null,
      allowance: 1000,
      purchased: 9000,
    };
    expect(creditsDescription(wallet, "Free", "en-US")).toBe(
      "640 credits from your Free plan are used first, then 9,000 credits purchased, which never expire. Another 360 credits are held for requests in progress.",
    );
    expect(640 + 9000).toBe(wallet.balance);
    const html = markup({ ...PACKS_ONLY, wallet });
    expect(html).toContain(`>${formatCredits(9640)}<`);
    expect(html).toContain(creditsDescription(wallet, "Free"));

    const exceededAllowance = {
      balance: 9000,
      reserved: 1500,
      planAllowance: 1000,
      periodEnd: null,
      allowance: 1000,
      purchased: 9500,
    };
    expect(creditsDescription(exceededAllowance, "Free", "en-US")).toBe(
      "0 credits from your Free plan are used first, then 9,000 credits purchased, which never expire. Another 1,500 credits are held for requests in progress.",
    );
  });

  it("Current plan row for not-subscribed users describes monthly top-up neutrally", () => {
    // Free never bought -> exactly "Tops up to 1,000 credits each month." (no "change your plan")
    const freeNeverBought = markup(READY);
    expect(freeNeverBought).toContain("Tops up to 1,000 credits each month.");
    expect(freeNeverBought).not.toContain("change your plan");

    render(
      <BillingSectionView
        busy={false}
        onCheckout={noop}
        onPortal={noop}
        onRefresh={noop}
        onCancel={noop}
        onBuyCredits={noop}
        state={READY}
      />,
    );
    expect(screen.getByText("Tops up to 1,000 credits each month.")).toBeTruthy();
    cleanup();

    // Free + Starter pack access -> "Tops up to 1,000 credits each month. Your credit pack unlocks Starter models."
    const freeWithStarter = markup(PACKS_ONLY, "starter");
    expect(freeWithStarter).toContain(
      "Tops up to 1,000 credits each month. Your credit pack unlocks Starter models.",
    );

    // Free with purchased > 0 and no access plan -> "Tops up to 1,000 credits each month. Credit packs don't change your plan."
    const freeWithPurchased = markup({
      ...READY,
      wallet: {
        balance: 6000,
        reserved: 0,
        planAllowance: 1000,
        periodEnd: null,
        allowance: 1000,
        purchased: 5000,
      },
    });
    expect(freeWithPurchased).toContain(
      "Tops up to 1,000 credits each month. Credit packs don&#x27;t change your plan.",
    );
  });

  it("with a subscription plan on sale, packs are offered next to Subscribe", () => {
    const html = markup({ ...READY, packs: PACKS });
    expect(html).toContain("Subscribe</button>");
    expect(html.match(/Buy credits<\/button>/g)).toHaveLength(3);
  });

  it("no packs (or the catalog failed): no Buy credits section", () => {
    expect(markup(READY)).not.toContain("Buy credits");
    expect(markup({ ...READY, catalog: null, packs: null })).not.toContain("Buy credits");
    expect(markup({ ...PACKS_ONLY, status: "loading" })).not.toContain("Buy credits</button>");
  });

  it("a subscriber can still buy credits", () => {
    const html = markup({
      ...PACKS_ONLY,
      currentPlan: "starter",
      subscription: {
        plan: "starter",
        provider: "mercadopago",
        status: "active",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        cancelRequestedAt: null,
      },
    });
    expect(html).toContain("Cancel subscription");
    expect(html.match(/Buy credits<\/button>/g)).toHaveLength(3);
  });

  it("clicking Buy credits passes only the pack id; disabled while a checkout is pending", () => {
    const onBuyCredits = vi.fn();
    const view = (state: BillingState) =>
      render(
        <BillingSectionView
          busy={false}
          onCheckout={noop}
          onPortal={noop}
          onRefresh={noop}
          onCancel={noop}
          onBuyCredits={onBuyCredits}
          state={state}
        />,
      );
    view(PACKS_ONLY);
    fireEvent.click(screen.getByRole("button", { name: `Buy ${formatCredits(10000)} credits` }));
    expect(onBuyCredits).toHaveBeenCalledWith("credits_10k");
    cleanup();
    view({ ...PACKS_ONLY, pending: "checkout" });
    for (const button of screen.getAllByRole("button", { name: /^Buy .* credits$/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("AccountBillingSection sends billing.buyCredits({ packId }) and shows the reply", async () => {
    const after: BillingState = { ...PACKS_ONLY, pending: "checkout" };
    const buyCredits = vi.fn(async (_input: { packId: string }) => after);
    (window as { modus?: unknown }).modus = {
      billing: {
        getState: vi.fn(async () => PACKS_ONLY),
        refresh: vi.fn(async () => PACKS_ONLY),
        checkout: vi.fn(async () => PACKS_ONLY),
        openPortal: vi.fn(async () => PACKS_ONLY),
        cancelSubscription: vi.fn(async () => PACKS_ONLY),
        buyCredits,
        onStateChange: vi.fn(() => () => undefined),
      },
    };
    render(<AccountBillingSection />);
    const button = await screen.findByRole("button", {
      name: `Buy ${formatCredits(25000)} credits`,
    });
    fireEvent.click(button);
    await waitFor(() => expect(buyCredits).toHaveBeenCalledWith({ packId: "credits_25k" }));
    await screen.findByText("Finish in your browser, then come back to Modus.");
  });
});
