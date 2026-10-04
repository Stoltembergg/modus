import {
  BILLING_PLAN_KEY_PATTERN,
  type BillingCatalogEntry,
  type BillingPlan,
  type BillingProvider,
  type BillingSubscription,
  type BillingWallet,
  isBillingProvider,
} from "../../shared/billing";

/**
 * Subscription statuses that count as live: shown in Account and blocking a new Checkout. Same
 * list as the Edge Functions (_shared/db.ts) and L1e's mp_cancel_targets; the DB's one-live-per-
 * user index covers all of them except `incomplete`. `paused` (a Mercado Pago pause) is live: no
 * second subscription on top of it, and it can be cancelled.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
] as const;

export type BillingSnapshot = {
  plans: BillingPlan[];
  /** get_billing_catalog() rows; null when that RPC failed (plans / wallet still load). */
  catalog: BillingCatalogEntry[] | null;
  subscription: BillingSubscription | null;
  wallet: BillingWallet | null;
};

export type BillingFunctionName =
  | "create-checkout-session"
  | "create-portal-session"
  | "mp-checkout";

/** Edge Function that opens a checkout for each provider (both: POST { plan } -> { url }). */
export const CHECKOUT_FUNCTIONS: Record<BillingProvider, BillingFunctionName> = {
  mercadopago: "mp-checkout",
  stripe: "create-checkout-session",
};

export type BillingFunctionResult =
  | { ok: true; url: string }
  | { ok: false; status: number; code: string };

/** L1e mp-cancel answers (never an id): nothing live, confirmed, or requested (not yet). */
export const CANCEL_RESULT_CODES = ["no_subscription", "canceled", "cancel_requested"] as const;
export type CancelResultCode = (typeof CANCEL_RESULT_CODES)[number];

export type BillingCancelResult =
  | { ok: true; code: CancelResultCode }
  | { ok: false; status: number; code: string };

/**
 * Billing reads (RLS: the caller's own rows, plus the public catalog RPC) and the checkout /
 * portal Functions. Implemented by
 * the Supabase backend so the access token never leaves main.
 */
export interface BillingBackend {
  fetchBilling(userId: string): Promise<BillingSnapshot>;
  createBillingSession(
    fn: BillingFunctionName,
    body: Record<string, string>,
  ): Promise<BillingFunctionResult>;
  /**
   * L1e: POST mp-cancel with an empty body. The Function finds the caller's own live Mercado
   * Pago subscription from the JWT; no id is ever sent.
   */
  cancelSubscription(): Promise<BillingCancelResult>;
}

export const CHECKOUT_URL_PREFIX = "https://checkout.stripe.com/";
export const PORTAL_URL_PREFIX = "https://billing.stripe.com/";
/** mp-checkout only ever returns Mercado Pago's own (Brazil) init_point (MP_CHECKOUT_HOST). */
export const MP_CHECKOUT_URL_PREFIX = "https://www.mercadopago.com.br/";

export const CHECKOUT_URL_PREFIXES: Record<BillingProvider, string> = {
  mercadopago: MP_CHECKOUT_URL_PREFIX,
  stripe: CHECKOUT_URL_PREFIX,
};

/** Only provider-hosted https pages (exact origin) are ever opened in the browser. */
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

/** get_billing_catalog() rows → display entries; anything malformed is dropped. */
export function mapCatalogRows(rows: unknown[]): BillingCatalogEntry[] {
  return rows.flatMap((raw): BillingCatalogEntry[] => {
    const row = (raw ?? {}) as Record<string, unknown>;
    // L5a: the catalog also lists one-off credit packs (kind 'pack'); they are not
    // subscription plans, so this UI never offers them as one (L5b adds the packs UI).
    // Rows without a kind come from a server before L5a: subscriptions.
    if (row.kind !== undefined && row.kind !== "subscription") return [];
    const plan = str(row.plan);
    const currency = str(row.currency);
    const amountMinor = num(row.amount_minor);
    if (
      !plan ||
      !BILLING_PLAN_KEY_PATTERN.test(plan) ||
      !isBillingProvider(row.provider) ||
      !currency ||
      !/^[A-Z]{3}$/.test(currency) ||
      amountMinor <= 0
    ) {
      return [];
    }
    return [
      {
        plan,
        name: str(row.name) ?? plan,
        monthlyCredits: num(row.monthly_credits),
        provider: row.provider,
        currency,
        amountMinor,
        sortOrder: num(row.sort_order),
      },
    ];
  });
}

/** PostgREST rows → display data. Stripe ids are dropped here (only `purchasable` survives). */
export function mapBillingRows(rows: {
  plans: unknown[];
  /** null: the catalog RPC failed. */
  catalog: unknown[] | null;
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
    catalog: rows.catalog ? mapCatalogRows(rows.catalog) : null,
    subscription:
      sub && str(sub.plan)
        ? {
            plan: str(sub.plan) ?? "free",
            // B6a: subscriptions.provider defaults to 'stripe'.
            provider: sub.provider === "mercadopago" ? "mercadopago" : "stripe",
            status: str(sub.status) ?? "unknown",
            currentPeriodEnd: str(sub.current_period_end),
            cancelAtPeriodEnd: sub.cancel_at_period_end === true,
            cancelRequestedAt: str(sub.cancel_requested_at),
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
