import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type {
  BillingCatalogEntry,
  BillingPlan,
  BillingProvider,
  BillingState,
} from "../../../../../shared/billing";
import { ReadOnlyPill, SettingsList, SettingsRow, SettingsSection } from "../settings-layout";

const SECONDARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40";
const PRIMARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40";

const DANGER_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-danger text-xs transition-colors hover:bg-hover disabled:opacity-40";

/** L1e: confirm copy for cancelling an active Mercado Pago subscription. */
export function cancelConfirmMessage(planName: string): string {
  return `Cancel your ${planName} subscription? Mercado Pago stops future charges. Nothing is refunded, and the credits you already have stay in your account.`;
}

const RETURN_NOTICES: Record<string, string> = {
  success: "Payment received. Your plan updates as soon as the payment is confirmed.",
  cancel: "Checkout was cancelled. Nothing was charged.",
  portal: "Back from billing. Showing the latest plan.",
};

export function formatCredits(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPrice(cents: number): string {
  return cents === 0 ? "Free" : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}/mo`;
}

/** Minor units → localized money: BRL as "R$ 49,90" (pt-BR), other currencies in en-US. */
export function formatMoney(amountMinor: number, currency: string): string {
  const locale = currency === "BRL" ? "pt-BR" : "en-US";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
      .format(amountMinor / 100)
      .replace(/\u00a0/g, " ");
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

const PROVIDER_LABEL: Record<BillingProvider, string> = {
  mercadopago: "Subscribe",
  stripe: "Pay by card (Stripe)",
};

type CatalogPlan = {
  plan: string;
  name: string;
  monthlyCredits: number;
  offers: BillingCatalogEntry[];
};

/** Catalog rows → one entry per plan (catalog order), Mercado Pago offer first. */
export function groupCatalog(catalog: BillingCatalogEntry[]): CatalogPlan[] {
  const byPlan = new Map<string, CatalogPlan>();
  const sorted = [...catalog].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.plan.localeCompare(b.plan),
  );
  for (const entry of sorted) {
    const group = byPlan.get(entry.plan) ?? {
      plan: entry.plan,
      name: entry.name,
      monthlyCredits: entry.monthlyCredits,
      offers: [],
    };
    group.offers.push(entry);
    byPlan.set(entry.plan, group);
  }
  for (const group of byPlan.values()) {
    group.offers.sort((a, b) =>
      a.provider === "mercadopago" ? -1 : b.provider === "mercadopago" ? 1 : 0,
    );
  }
  return [...byPlan.values()];
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

type ViewProps = {
  state: BillingState | undefined;
  busy: boolean;
  onCheckout(plan: string, provider: BillingProvider): void;
  onPortal(): void;
  onRefresh(): void;
  /** L1e: cancel the own Mercado Pago subscription (main finds it; no id here). */
  onCancel(): void;
};

/** Presentational: everything comes from BillingState (display data only). */
export function BillingSectionView({
  state,
  busy,
  onCheckout,
  onPortal,
  onRefresh,
  onCancel,
}: ViewProps) {
  if (!state || state.status === "unavailable" || state.status === "signed-out") return null;
  const current: BillingPlan | undefined = state.plans.find(
    (plan) => plan.plan === state.currentPlan,
  );
  const subscribed = Boolean(state.subscription);
  const renews = formatDate(state.subscription?.currentPeriodEnd ?? null);
  const loading = state.status === "loading";
  const catalog = state.catalog ? groupCatalog(state.catalog) : null;
  const stripeSubscription = state.subscription?.provider === "stripe";
  const mpSubscription = state.subscription?.provider === "mercadopago";
  /** Requested (in flight, or flagged and waiting for Mercado Pago's confirmation). */
  const mpCancelling =
    mpSubscription && (state.cancelling || Boolean(state.subscription?.cancelRequestedAt));
  const paymentPending = mpSubscription && state.subscription?.status === "incomplete";
  const planName = current?.name ?? state.currentPlan;
  const paused = state.subscription?.status === "paused";
  const statusLabel = paymentPending
    ? "payment pending"
    : paused
      ? "Subscription paused"
      : (state.subscription?.status ?? "");

  return (
    <SettingsSection
      description="Plans are paid through Mercado Pago in your browser, billed monthly in Brazilian reais. Credits are added as soon as the payment is confirmed."
      title="Plan & credits"
    >
      {state.error ? <p className="mb-3 text-danger text-xs">{state.error}</p> : null}
      {state.lastReturn && RETURN_NOTICES[state.lastReturn] ? (
        <p className="mb-3 text-success text-xs">{RETURN_NOTICES[state.lastReturn]}</p>
      ) : null}
      {state.pending ? (
        <p className="mb-3 text-fg-muted text-xs">
          Finish in your browser, then come back to Modus.
        </p>
      ) : null}
      <SettingsList>
        <SettingsRow
          control={
            <div className="flex items-center gap-2">
              <ReadOnlyPill>
                {loading ? "Loading…" : (current?.name ?? state.currentPlan)}
              </ReadOnlyPill>
              <button
                aria-label="Refresh plan"
                className={SECONDARY_BUTTON}
                disabled={busy || loading}
                onClick={onRefresh}
                type="button"
              >
                <IconRefresh size={14} stroke={1.7} />
              </button>
            </div>
          }
          description={
            subscribed
              ? `${statusLabel}${
                  mpCancelling
                    ? " · cancelling"
                    : state.subscription?.cancelAtPeriodEnd
                      ? renews
                        ? ` · ends ${renews}`
                        : " · ends at period end"
                      : renews && !paused
                        ? ` · renews ${renews}`
                        : ""
                }`
              : "No paid subscription."
          }
          title="Current plan"
        />
        <SettingsRow
          control={<ReadOnlyPill>{formatCredits(state.wallet?.balance ?? 0)}</ReadOnlyPill>}
          description={
            state.wallet
              ? `Monthly allowance ${formatCredits(state.wallet.planAllowance)}${
                  state.wallet.reserved > 0
                    ? ` · ${formatCredits(state.wallet.reserved)} reserved`
                    : ""
                }`
              : "Credits appear after your email is confirmed."
          }
          title="Credits"
        />
        {subscribed ? (
          stripeSubscription ? (
            <SettingsRow
              control={
                <button
                  className={PRIMARY_BUTTON}
                  disabled={busy || loading}
                  onClick={onPortal}
                  type="button"
                >
                  <IconExternalLink size={13} stroke={2} />
                  Manage billing
                </button>
              }
              description="Upgrade, downgrade, cancel or update the payment method in Stripe."
              title="Change plan"
            />
          ) : mpCancelling ? (
            <SettingsRow
              control={
                <button
                  className={SECONDARY_BUTTON}
                  disabled={busy || loading || state.cancelling}
                  onClick={onCancel}
                  type="button"
                >
                  {state.cancelling ? "Cancelling…" : "Check again"}
                </button>
              }
              description={
                state.cancelling
                  ? "Cancelling with Mercado Pago…"
                  : "Cancellation requested. Waiting for Mercado Pago to confirm; you can subscribe again once it does."
              }
              title="Cancelling…"
            />
          ) : paymentPending ? (
            <SettingsRow
              control={
                <button
                  className={PRIMARY_BUTTON}
                  disabled={busy || loading}
                  onClick={onCancel}
                  type="button"
                >
                  Cancel and try again
                </button>
              }
              description="Mercado Pago hasn't confirmed a payment for this subscription. If you didn't finish paying, cancel it and subscribe again."
              title="Payment pending"
            />
          ) : (
            <>
              {paused ? (
                <SettingsRow
                  control={null}
                  description="Mercado Pago paused this subscription: no charges, and only the Free plan's models until it resumes. Your credits stay. Cancel it to subscribe again later."
                  title="Subscription paused"
                />
              ) : (
                <SettingsRow
                  control={null}
                  description="Your subscription is billed by Mercado Pago. Payments and receipts are in your Mercado Pago account."
                  title="Billing"
                />
              )}
              <SettingsRow
                control={
                  <button
                    className={DANGER_BUTTON}
                    disabled={busy || loading}
                    onClick={() => {
                      if (window.confirm(cancelConfirmMessage(planName))) onCancel();
                    }}
                    type="button"
                  >
                    Cancel subscription
                  </button>
                }
                description="Stops future Mercado Pago charges. No refund; your credits stay."
                title="Cancel subscription"
              />
            </>
          )
        ) : loading ? null : catalog === null ? (
          <SettingsRow
            control={null}
            description="Plans couldn't be loaded. Refresh to try again."
            title="Plans unavailable"
          />
        ) : catalog.length === 0 ? (
          <SettingsRow
            control={null}
            description="No plans are on sale right now. Check back later."
            title="No plans available"
          />
        ) : (
          catalog.map((plan) => (
            <SettingsRow
              control={
                <div className="flex items-center gap-2">
                  {plan.offers.map((offer) => (
                    <button
                      className={
                        offer.provider === "mercadopago" ? PRIMARY_BUTTON : SECONDARY_BUTTON
                      }
                      disabled={busy || loading || Boolean(state.pending)}
                      key={`${offer.provider}:${offer.currency}`}
                      onClick={() => onCheckout(plan.plan, offer.provider)}
                      type="button"
                    >
                      <IconExternalLink size={13} stroke={2} />
                      {PROVIDER_LABEL[offer.provider]}
                    </button>
                  ))}
                </div>
              }
              description={`${formatCredits(plan.monthlyCredits)} credits per month`}
              key={plan.plan}
              title={`${plan.name} · ${plan.offers
                .map((offer) => `${formatMoney(offer.amountMinor, offer.currency)}/mo`)
                .join(" or ")}`}
            />
          ))
        )}
      </SettingsList>
    </SettingsSection>
  );
}

export function AccountBillingSection() {
  const [state, setState] = useState<BillingState | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const billing = window.modus?.billing;
    if (!billing) return;
    let active = true;
    void billing
      .getState()
      .then((next: BillingState) => {
        if (active) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = billing.onStateChange((next: BillingState) => setState(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<BillingState>): Promise<void> {
    setBusy(true);
    try {
      setState(await action());
    } catch {
      // Main already reports errors through BillingState.
    } finally {
      setBusy(false);
    }
  }

  return (
    <BillingSectionView
      busy={busy}
      onCheckout={(plan, provider) =>
        void run(() => window.modus.billing.checkout({ plan, provider }))
      }
      onPortal={() => void run(() => window.modus.billing.openPortal())}
      onRefresh={() => void run(() => window.modus.billing.refresh())}
      onCancel={() => void run(() => window.modus.billing.cancelSubscription())}
      state={state}
    />
  );
}
