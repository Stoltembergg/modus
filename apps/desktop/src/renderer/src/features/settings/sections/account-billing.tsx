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
import type { SettingsTextKey } from "../../../../../shared/settings-text";
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../../lib/settingsText";
import { uiIntlLocale } from "../../../lib/uiIntl";
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
  t: SettingsTextFn = settingsTextFor(),
): string {
  const keep = !keepsPlan
    ? ""
    : accessUntil
      ? t("settings.account.cancelConfirmKeepUntil", { plan: planName, until: accessUntil })
      : t("settings.account.cancelConfirmKeepPeriodEnd", { plan: planName });
  return t("settings.account.cancelConfirmMessage", { plan: planName, keep });
}

/** L1g: the router keeps the plan for these statuses until current_period_end after a cancel. */
const GRACE_FROM = new Set(["active", "trialing"]);

const RETURN_NOTICES: Record<string, SettingsTextKey> = {
  success: "settings.account.returnNoticeSuccess",
  cancel: "settings.account.returnNoticeCancel",
  portal: "settings.account.returnNoticePortal",
};

/**
 * Numbers and money follow the app language (`<html lang>`, `uiIntlLocale`); tests pass one.
 * "5.000" / "R$ 36,90" in pt-BR, "5,000" / "R$36.90" in en-US.
 */
export function formatCredits(value: number, locale: string = uiIntlLocale()): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** "1 credit", "5,000 credits". */
export function creditCount(
  value: number,
  locale?: string,
  t: SettingsTextFn = settingsTextFor(),
): string {
  return t.plural("settings.account.creditCount", value, {
    count: formatCredits(value, locale),
  });
}

/** Minor units → money in the user's locale (Intl only; an unknown currency code shows the code). */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: string = uiIntlLocale(),
): string {
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
export function packTitle(
  pack: BillingCreditPack,
  locale?: string,
  t: SettingsTextFn = settingsTextFor(),
): string {
  return t("settings.account.packTitle", {
    credits: creditCount(pack.credits, locale, t),
    price: formatMoney(pack.amountMinor, pack.currency, locale),
  });
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
  t: SettingsTextFn = settingsTextFor(),
): string {
  const held = wallet.reserved;
  const parts: string[] = [];
  if (wallet.allowance === undefined || wallet.purchased === undefined) {
    parts.push(t("settings.account.creditsUnknownLots", { plan: planName }));
  } else {
    const allowanceLeft = Math.max(0, wallet.allowance - held);
    const purchasedLeft = wallet.purchased - Math.max(0, held - wallet.allowance);
    if (purchasedLeft > 0) {
      parts.push(
        t("settings.account.creditsAllowanceAndPurchased", {
          allowance: creditCount(allowanceLeft, locale, t),
          plan: planName,
          purchased: creditCount(purchasedLeft, locale, t),
        }),
      );
    } else {
      parts.push(
        t("settings.account.creditsAllowanceOnly", {
          allowance: creditCount(allowanceLeft, locale, t),
          plan: planName,
        }),
      );
    }
  }
  if (held > 0) {
    parts.push(
      t.plural("settings.account.creditsHeld", held, {
        credits: creditCount(held, locale, t),
      }),
    );
  }
  const owed = wallet.shortfallOwed;
  if (typeof owed === "number" && owed > 0) {
    const extra = onFreePlan ? t("settings.account.creditsOwedFreeTopUp") : "";
    parts.push(
      t.plural("settings.account.creditsOwed", owed, {
        credits: creditCount(owed, locale, t),
        extra,
      }),
    );
  }
  return parts.join(" ");
}

const PROVIDER_LABEL: Record<BillingProvider, SettingsTextKey> = {
  mercadopago: "settings.account.subscribe",
  stripe: "settings.account.payByCardStripe",
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
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(uiIntlLocale());
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
  const t = useSettingsText();
  return (
    <>
      {packs.map((pack) => (
        <SettingsRow
          control={
            <button
              aria-label={t("settings.account.buyCreditsAria", {
                count: formatCredits(pack.credits),
              })}
              className={PRIMARY_BUTTON}
              disabled={disabled}
              onClick={() => onBuyCredits(pack.packId)}
              type="button"
            >
              <IconExternalLink size={13} stroke={2} />
              {t("settings.account.buyCredits")}
            </button>
          }
          key={pack.packId}
          title={packTitle(pack, undefined, t)}
        />
      ))}
    </>
  );
}

const SUB_STATUS_KEY: Record<string, SettingsTextKey> = {
  active: "settings.account.subStatusActive",
  trialing: "settings.account.subStatusTrialing",
  past_due: "settings.account.subStatusPastDue",
  canceled: "settings.account.subStatusCanceled",
  unpaid: "settings.account.subStatusUnpaid",
  incomplete: "settings.account.subStatusIncomplete",
  paused: "settings.account.subStatusPaused",
};

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
  const t = useSettingsText();
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
    ? t("settings.account.statusPaymentPending")
    : paused
      ? t("settings.account.statusSubscriptionPaused")
      : SUB_STATUS_KEY[rawStatus]
        ? t(SUB_STATUS_KEY[rawStatus])
        : `${rawStatus.charAt(0).toUpperCase()}${rawStatus.slice(1).replace(/_/g, " ")}`;

  const fallbackPlanDescription = (() => {
    const parts: string[] = [];
    if (current && current.monthlyCredits > 0) {
      parts.push(
        t("settings.account.fallbackPlanTopsUp", {
          credits: creditCount(current.monthlyCredits, undefined, t),
        }),
      );
    }
    if (packAccess) {
      parts.push(t("settings.account.fallbackPlanPackAccess", { plan: packAccess }));
    } else if ((state.wallet?.purchased ?? 0) > 0) {
      parts.push(t("settings.account.fallbackPlanCreditPacksNoChange"));
    }
    return parts.join(" ");
  })();

  const returnNotice = state.lastReturn ? RETURN_NOTICES[state.lastReturn] : undefined;

  return (
    <SettingsSection
      description={
        plansOnSale
          ? t("settings.account.sectionPlansOnSaleDescription")
          : t("settings.account.sectionPacksOnlyDescription")
      }
      title={t("settings.account.sectionPlanAndCreditsTitle")}
    >
      {state.error ? <p className="mb-3 text-danger text-xs">{state.error}</p> : null}
      {returnNotice ? <p className="mb-3 text-success text-xs">{t(returnNotice)}</p> : null}
      {state.pending ? (
        <p className="mb-3 text-fg-muted text-xs">{t("settings.account.pendingBrowserNotice")}</p>
      ) : null}
      <SettingsList>
        <SettingsRow
          control={
            <div className="flex items-center gap-2">
              <ReadOnlyPill>
                {loading
                  ? t("settings.account.loading")
                  : paused
                    ? t("settings.account.planPausedPill", { plan: planName })
                    : planName}
              </ReadOnlyPill>
              <button
                aria-label={t("settings.account.refreshPlanAria")}
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
                ? t("settings.account.planEndingWithDate", { plan: planName, date: renews })
                : t("settings.account.planEndingPeriodEnd", { plan: planName })
              : subscribed
                ? `${statusLabel}${
                    mpCancelling
                      ? t("settings.account.subCancellingSuffix")
                      : state.subscription?.cancelAtPeriodEnd
                        ? renews
                          ? t("settings.account.subEndsOnSuffix", { date: renews })
                          : t("settings.account.subEndsPeriodEndSuffix")
                        : renews && !paused
                          ? t("settings.account.subRenewsOnSuffix", { date: renews })
                          : "."
                  }`
                : fallbackPlanDescription
          }
          title={t("settings.account.currentPlanTitle")}
        />
        <SettingsRow
          control={<ReadOnlyPill>{formatCredits(state.wallet?.balance ?? 0)}</ReadOnlyPill>}
          description={
            state.wallet
              ? creditsDescription(
                  state.wallet,
                  planName,
                  undefined,
                  state.currentPlan === "free",
                  t,
                )
              : t("settings.account.creditsUnconfirmedEmail")
          }
          title={t("settings.account.creditsTitle")}
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
                  {t("settings.account.manageBilling")}
                </button>
              }
              description={t("settings.account.changePlanStripeDescription")}
              title={t("settings.account.changePlanTitle")}
            />
          ) : ending ? (
            <SettingsRow
              control={null}
              description={t("settings.account.subscriptionEndedDescription", {
                plan: planName,
                until: renews ?? t("settings.account.thePeriodEnds"),
              })}
              title={t("settings.account.subscriptionCancelledTitle")}
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
                  {state.cancelling
                    ? t("settings.account.cancelling")
                    : t("settings.account.checkAgain")}
                </button>
              }
              description={
                state.cancelling
                  ? t("settings.account.cancellingWithMercadoPago")
                  : keepsPlan && renews
                    ? t("settings.account.cancelRequestedKeepUntil", {
                        plan: planName,
                        date: renews,
                      })
                    : t("settings.account.cancelRequestedCanResubscribe")
              }
              title={t("settings.account.cancelling")}
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
                  {t("settings.account.cancelAndTryAgain")}
                </button>
              }
              description={t("settings.account.paymentPendingDescription")}
              title={t("settings.account.statusPaymentPending")}
            />
          ) : (
            <>
              {paused ? (
                <SettingsRow
                  control={null}
                  description={t("settings.account.subscriptionPausedDescription")}
                  title={t("settings.account.statusSubscriptionPaused")}
                />
              ) : (
                <SettingsRow
                  control={null}
                  description={t("settings.account.subscriptionBilledByMpDescription")}
                  title={t("settings.account.billingTitle")}
                />
              )}
              <SettingsRow
                control={
                  <button
                    className={DANGER_BUTTON}
                    disabled={busy || loading}
                    onClick={() => {
                      if (window.confirm(cancelConfirmMessage(planName, renews, keepsPlan, t))) {
                        onCancel();
                      }
                    }}
                    type="button"
                  >
                    {t("settings.account.cancelSubscription")}
                  </button>
                }
                description={
                  keepsPlan && renews
                    ? t("settings.account.cancelSubscriptionKeepsPlanDescription", {
                        plan: planName,
                        date: renews,
                      })
                    : t("settings.account.cancelSubscriptionDescription")
                }
                title={t("settings.account.cancelSubscription")}
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
                {t("settings.account.tryAgain")}
              </button>
            }
            description={t("settings.account.catalogFailedDescription")}
            title={t("settings.account.catalogFailedTitle")}
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
                {t("settings.account.refresh")}
              </button>
            }
            description={t("settings.account.catalogEmptyDescription")}
            title={t("settings.account.catalogEmptyTitle")}
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
                      {t(PROVIDER_LABEL[offer.provider])}
                    </button>
                  ))}
                </div>
              }
              description={t("settings.account.creditsPerMonth", {
                credits: creditCount(plan.monthlyCredits, undefined, t),
              })}
              key={plan.plan}
              title={t("settings.account.planOfferTitle", {
                plan: plan.name,
                price: plan.offers
                  .map((offer) =>
                    t("settings.account.pricePerMonth", {
                      price: formatMoney(offer.amountMinor, offer.currency),
                    }),
                  )
                  .join(t("settings.account.priceOrJoin")),
              })}
            />
          ))
        )}
      </SettingsList>
      {!loading && packs.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 font-medium text-fg text-xs">
            {t("settings.account.creditPacksHeading")}
          </h3>
          <p className="mb-3 text-xs leading-4 text-fg-muted">
            {t("settings.account.creditPacksDescription")}
          </p>
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
