import type { BillingPlan, BillingSubscription, BillingWallet } from "../../shared/billing";

/** Subscription statuses that block a new Checkout (same list as the Edge Function). */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
] as const;

export type BillingSnapshot = {
  plans: BillingPlan[];
  subscription: BillingSubscription | null;
  wallet: BillingWallet | null;
};

export type BillingFunctionName = "create-checkout-session" | "create-portal-session";

export type BillingFunctionResult =
  | { ok: true; url: string }
  | { ok: false; status: number; code: string };

/**
 * Billing reads (RLS: the caller's own rows) and the two Stripe session Functions. Implemented by
 * the Supabase backend so the access token never leaves main.
 */
export interface BillingBackend {
  fetchBilling(userId: string): Promise<BillingSnapshot>;
  createBillingSession(
    fn: BillingFunctionName,
    body: Record<string, string>,
  ): Promise<BillingFunctionResult>;
}

export const CHECKOUT_URL_PREFIX = "https://checkout.stripe.com/";
export const PORTAL_URL_PREFIX = "https://billing.stripe.com/";

/** Only Stripe-hosted https pages are ever opened in the browser. */
export function isStripeHostedUrl(raw: unknown, prefix: string): raw is string {
  if (typeof raw !== "string" || !raw.startsWith(prefix) || raw.length > 4096) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      `${url.origin}/` === prefix &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** PostgREST rows → display data. Stripe ids are dropped here (only `purchasable` survives). */
export function mapBillingRows(rows: {
  plans: unknown[];
  subscription: unknown;
  wallet: unknown;
}): BillingSnapshot {
  const plans = rows.plans.flatMap((raw): BillingPlan[] => {
    const row = raw as Record<string, unknown>;
    const plan = str(row.plan);
    if (!plan) return [];
    return [
      {
        plan,
        name: str(row.name) ?? plan,
        priceUsdCents: num(row.price_usd_cents),
        monthlyCredits: num(row.monthly_credits),
        purchasable: Boolean(str(row.stripe_price_id)),
      },
    ];
  });
  const sub = rows.subscription as Record<string, unknown> | null;
  const wallet = rows.wallet as Record<string, unknown> | null;
  return {
    plans,
    subscription:
      sub && str(sub.plan)
        ? {
            plan: str(sub.plan) ?? "free",
            status: str(sub.status) ?? "unknown",
            currentPeriodEnd: str(sub.current_period_end),
            cancelAtPeriodEnd: sub.cancel_at_period_end === true,
          }
        : null,
    wallet: wallet
      ? {
          balance: num(wallet.balance),
          reserved: num(wallet.reserved),
          planAllowance: num(wallet.plan_allowance),
          periodEnd: str(wallet.period_end),
        }
      : null,
  };
}
