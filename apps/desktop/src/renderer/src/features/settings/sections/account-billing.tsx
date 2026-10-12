import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type {
  BillingCatalogEntry,
  BillingCreditPack,
  BillingPlan,
  BillingProvider,
  BillingState,
  BillingWallet,
} from "../../../../../shared/billing";
import { ReadOnlyPill, SettingsList, SettingsRow, SettingsSection } from "../settings-layout";

const SECONDARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40";
const PRIMARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40";

const DANGER_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-danger text-xs transition-colors hover:bg-hover disabled:opacity-40";

/**
 * L1e/L1g: confirm copy for cancelling a Mercado Pago subscription. `accessUntil` is the
 * formatted current_period_end when the plan stays until then (an active/trialing row, L1g), or
 * null when it doesn't (a paused row: already on the Free plan's models).
 */
export function cancelConfirmMessage(
  planName: string,
  accessUntil: string | null,
  keepsPlan = true,
): string {
  const keep = !keepsPlan
    ? ""
    : accessUntil
      ? ` You keep ${planName} until ${accessUntil}; after that you move to Free.`
      : ` You keep ${planName} until the end of the period you paid for; after that you move to Free.`;
  return `Cancel your ${planName} subscription? Mercado Pago stops future charges.${keep} Nothing is refunded, and the credits you already have stay in your account.`;
}

/** L1g: the router keeps the plan for these statuses until current_period_end after a cancel. */
const GRACE_FROM = new Set(["active", "trialing"]);

const RETURN_NOTICES: Record<string, string> = {
  success: "Payment received. Your credits are added as soon as Mercado Pago confirms the payment.",
  cancel: "Checkout was cancelled. Nothing was charged.",
  portal: "Back from billing. Showing the latest plan.",
};

/**
 * Numbers and money follow the user's system locale (`locale` undefined); tests pass one.
 * "5.000" / "R$ 36,90" in pt-BR, "5,000" / "R$36.90" in en-US.
 */
export function formatCredits(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** "1 credit", "5,000 credits". */
export function creditCount(value: number, locale?: string): string {
  return `${formatCredits(value, locale)} ${value === 1 ? "credit" : "credits"}`;
}

/** Minor units → money in the user's locale (Intl only; an unknown currency code shows the code). */
export function formatMoney(amountMinor: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    const amount = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
    return `${amount} ${currency}`;
  }
}

/** A credit pack row title: "5,000 credits for R$36.90". */
export function packTitle(pack: BillingCreditPack, locale?: string): string {
  return `${creditCount(pack.credits, locale)} for ${formatMoney(pack.amountMinor, pack.currency, locale)}`;
}

function planLabel(plans: readonly BillingPlan[], plan: string): string {
  return (
    plans.find((entry) => entry.plan === plan)?.name ??
    `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
  );
}

/**
 * The Credits row, from real numbers only. `allowance` / `purchased` are absent when the lots
 * could not be read; then the row says only how the two kinds are spent. Server rules
 * (supabase/migrations/20261004040000_l5a_credit_packs.sql): the plan allowance is spent
 * first, then purchased lots oldest first; lots never expire.
 */
export function creditsDescription(
  wallet: BillingWallet,
  planName: string,
  locale?: string,
  /** On Free the debt also comes out of the next monthly top-up (renew_free_credits_for_user). */
  onFreePlan = false,
): string {
  const held = wallet.reserved;
  const parts: string[] = [];
  if (wallet.allowance === undefined || wallet.purchased === undefined) {
    parts.push(
      `Credits from your ${planName} plan are used first, then purchased credits, which never expire.`,
    );
  } else {
    const allowanceLeft = Math.max(0, wallet.allowance - held);
    const purchasedLeft = wallet.purchased - Math.max(0, held - wallet.allowance);
    if (purchasedLeft > 0) {
      parts.push(
        `${creditCount(allowanceLeft, locale)} from your ${planName} plan are used first, then ${creditCount(purchasedLeft, locale)} purchased, which never expire.`,
      );
    } else {
      parts.push(`${creditCount(allowanceLeft, locale)} from your ${planName} plan.`);
    }
  }
  if (held > 0) {
    parts.push(
      `Another ${creditCount(held, locale)} ${held === 1 ? "is" : "are"} held for requests in progress.`,
    );
  }
  const owed = wallet.shortfallOwed;
  if (typeof owed === "number" && owed > 0) {
    parts.push(
      `You owe ${creditCount(owed, locale)} from a refunded purchase. ${
        owed === 1 ? "It's" : "They're"
      } deducted as you use Modus${onFreePlan ? " and from your next free monthly credits" : ""}.`,
    );
  }
  return parts.join(" ");
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
  /** L5b: Mercado Pago Checkout Pro for a credit pack (only the pack id). */
  onBuyCredits(packId: BillingCreditPack["packId"]): void;
  /**
   * The plan the Modus router grants right now (GET /v1/models `plan`): the subscription plan
   * or, with unspent purchased credits, the pack's access plan. Undefined while unknown.
   */
  accessPlan?: string | undefined;
};

/** L5b: one row per credit pack, a "Buy credits" button each. */
function CreditPackRows({
  packs,
  disabled,
  onBuyCredits,
}: {
  packs: BillingCreditPack[];
  disabled: boolean;
  onBuyCredits(packId: BillingCreditPack["packId"]): void;
}) {
  return (
    <>
      {packs.map((pack) => (
        <SettingsRow
          control={
            <button
              aria-label={`Buy ${formatCredits(pack.credits)} credits`}
              className={PRIMARY_BUTTON}
              disabled={disabled}
              onClick={() => onBuyCredits(pack.packId)}
              type="button"
            >
              <IconExternalLink size={13} stroke={2} />
              Buy credits
            </button>
          }
          description="One-time payment with Pix or card. Purchased credits never expire."
          key={pack.packId}
          title={packTitle(pack)}
        />
      ))}
    </>
  );
}

/** Presentational: everything comes from BillingState (display data only). */
export function BillingSectionView({
  state,
  busy,
  onCheckout,
  onPortal,
  onRefresh,
  onCancel,
  onBuyCredits,
  accessPlan,
}: ViewProps) {
  if (!state || state.status === "unavailable" || state.status === "signed-out") return null;
  const current: BillingPlan | undefined = state.plans.find(
    (plan) => plan.plan === state.currentPlan,
  );
  const subscribed = Boolean(state.subscription);
  const renews = formatDate(state.subscription?.currentPeriodEnd ?? null);
  const loading = state.status === "loading";
  const catalog = state.catalog ? groupCatalog(state.catalog) : null;
  const packs = state.packs ?? [];
  /**
   * L5b: with Mercado Pago subscriptions switched off server-side the catalog has no plan to
   * subscribe to: show only the credit packs (no Subscribe, no "No plans available").
   */
  const packsOnly = catalog !== null && catalog.length === 0 && packs.length > 0;
  const plansOnSale = catalog !== null && catalog.length > 0;
  /** Unspent purchased credits unlock a higher plan's models (router getPlan). */
  const packAccess =
    accessPlan && accessPlan !== "free" && accessPlan !== state.currentPlan && !subscribed
      ? planLabel(state.plans, accessPlan)
      : null;
  const stripeSubscription = state.subscription?.provider === "stripe";
  const mpSubscription = state.subscription?.provider === "mercadopago";
  /** Requested (in flight, or flagged and waiting for Mercado Pago's confirmation). */
  const mpCancelling =
    mpSubscription && (state.cancelling || Boolean(state.subscription?.cancelRequestedAt));
  const paymentPending = mpSubscription && state.subscription?.status === "incomplete";
  const planName = current?.name ?? state.currentPlan;
  const paused = state.subscription?.status === "paused";
  /** L1g: cancelled by Mercado Pago, still paid until current_period_end (then Free). */
  const ending =
    mpSubscription &&
    state.subscription?.status === "canceled" &&
    state.subscription.cancelAtPeriodEnd;
  /** Whether a cancel now keeps the plan until the period end (same rule as the server). */
  const keepsPlan = GRACE_FROM.has(state.subscription?.status ?? "");
  const rawStatus = state.subscription?.status ?? "";
  const statusLabel = paymentPending
    ? "Payment pending"
    : paused
      ? "Subscription paused"
      : `${rawStatus.charAt(0).toUpperCase()}${rawStatus.slice(1).replace(/_/g, " ")}`;

  const fallbackPlanDescription = (() => {
    const parts: string[] = [];
    if (current && current.monthlyCredits > 0) {
      parts.push(`Tops up to ${creditCount(current.monthlyCredits)} each month.`);
    }
    if (packAccess) {
      parts.push(`Your credit pack unlocks ${packAccess} models.`);
    } else if ((state.wallet?.purchased ?? 0) > 0) {
      parts.push("Credit packs don't change your plan.");
    }
    return parts.join(" ");
  })();

  return (
    <SettingsSection
      description={
        plansOnSale
          ? "Plans are paid through Mercado Pago in your browser, billed monthly in Brazilian reais. Your credits are added as soon as Mercado Pago confirms the payment."
          : "Buy credit packs in your browser with Pix or card, in Brazilian reais. Your credits are added as soon as Mercado Pago confirms the payment."
      }
      title="Plan and credits"
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
                {loading ? "Loading…" : paused ? `${planName} (paused)` : planName}
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
            ending
              ? renews
                ? `Cancelled. You keep ${planName} until ${renews}.`
                : `Cancelled. You keep ${planName} until the period ends.`
              : subscribed
                ? `${statusLabel}${
                    mpCancelling
                      ? ", cancelling."
                      : state.subscription?.cancelAtPeriodEnd
                        ? renews
                          ? `, ends on ${renews}.`
                          : ", ends when the period ends."
                        : renews && !paused
                          ? `, renews on ${renews}.`
                          : "."
                  }`
                : fallbackPlanDescription
          }
          title="Current plan"
        />
        <SettingsRow
          control={<ReadOnlyPill>{formatCredits(state.wallet?.balance ?? 0)}</ReadOnlyPill>}
          description={
            state.wallet
              ? creditsDescription(state.wallet, planName, undefined, state.currentPlan === "free")
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
          ) : ending ? (
            <SettingsRow
              control={null}
              description={`Mercado Pago won't charge you again. You keep ${planName} until ${
                renews ?? "the period ends"
              }; after that you move to Free and can subscribe again. Your credits stay.`}
              title="Subscription cancelled"
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
                  : keepsPlan && renews
                    ? `Cancellation requested. Waiting for Mercado Pago to confirm. You keep ${planName} until ${renews}.`
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
                      if (window.confirm(cancelConfirmMessage(planName, renews, keepsPlan))) {
                        onCancel();
                      }
                    }}
                    type="button"
                  >
                    Cancel subscription
                  </button>
                }
                description={
                  keepsPlan && renews
                    ? `Stops future Mercado Pago charges. You keep ${planName} until ${renews}, then Free. No refund; your credits stay.`
                    : "Stops future Mercado Pago charges. No refund; your credits stay."
                }
                title="Cancel subscription"
              />
            </>
          )
        ) : loading || packsOnly ? null : catalog === null ? (
          <SettingsRow
            control={
              <button
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={onRefresh}
                type="button"
              >
                Try again
              </button>
            }
            description="Check your connection, then try again."
            title="Credit packs couldn't be loaded"
          />
        ) : catalog.length === 0 ? (
          <SettingsRow
            control={
              <button
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={onRefresh}
                type="button"
              >
                Refresh
              </button>
            }
            description="Nothing is for sale right now. Refresh to check again."
            title="Credit packs aren't on sale"
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
              description={`${creditCount(plan.monthlyCredits)} a month`}
              key={plan.plan}
              title={`${plan.name} for ${plan.offers
                .map((offer) => `${formatMoney(offer.amountMinor, offer.currency)} a month`)
                .join(" or ")}`}
            />
          ))
        )}
      </SettingsList>
      {!loading && packs.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 font-medium text-fg text-xs">Credit packs</h3>
          <SettingsList>
            <CreditPackRows
              disabled={busy || loading || Boolean(state.pending)}
              onBuyCredits={onBuyCredits}
              packs={packs}
            />
          </SettingsList>
        </div>
      ) : null}
    </SettingsSection>
  );
}

export function AccountBillingSection({ accessPlan }: { accessPlan?: string | undefined } = {}) {
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
      onBuyCredits={(packId) => void run(() => window.modus.billing.buyCredits({ packId }))}
      state={state}
      accessPlan={accessPlan}
    />
  );
}
