/**
 * Billing (Mercado Pago, optionally Stripe, via Supabase Edge Functions) contract shared by main,
 * preload and renderer.
 *
 * Only display data crosses IPC. The Supabase access token, provider customer / subscription ids
 * and the Checkout / Portal URLs stay in the main process (see main/billing/billing-service.ts).
 */

/** Plan keys follow the public.plans CHECK: lowercase, starts with a letter. */
export const BILLING_PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export type BillingPlan = {
  plan: string;
  name: string;
  priceUsdCents: number;
  monthlyCredits: number;
  /** false for Free (no Stripe price). */
  purchasable: boolean;
};

/** Checkout providers the catalog may offer (public.get_billing_catalog().provider). */
export type BillingProvider = "mercadopago" | "stripe";

export const BILLING_PROVIDERS: readonly BillingProvider[] = ["mercadopago", "stripe"];

export function isBillingProvider(value: unknown): value is BillingProvider {
  return typeof value === "string" && (BILLING_PROVIDERS as readonly string[]).includes(value);
}

/**
 * One sellable (plan, provider, currency) row from public.get_billing_catalog() (L1c): public
 * data only. Stripe rows exist only while the DB flag private.billing_settings.stripe_enabled is
 * on; checkout is still gated server-side by STRIPE_ENABLED.
 */
export type BillingCatalogEntry = {
  plan: string;
  name: string;
  monthlyCredits: number;
  provider: BillingProvider;
  /** ISO 4217, e.g. "BRL". */
  currency: string;
  /** Minor units (centavos / cents). */
  amountMinor: number;
  sortOrder: number;
};

export type BillingSubscription = {
  plan: string;
  /** Who bills this subscription; decides whether the Stripe Portal applies. */
  provider: BillingProvider;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingWallet = {
  balance: number;
  reserved: number;
  planAllowance: number;
  periodEnd: string | null;
};

export type BillingReturnStatus = "success" | "cancel" | "portal";

export const BILLING_RETURN_STATUSES: readonly BillingReturnStatus[] = [
  "success",
  "cancel",
  "portal",
];

export function isBillingReturnStatus(value: unknown): value is BillingReturnStatus {
  return (
    typeof value === "string" && (BILLING_RETURN_STATUSES as readonly string[]).includes(value)
  );
}

export type BillingStatus = "unavailable" | "signed-out" | "loading" | "ready" | "error";

export type BillingState = {
  status: BillingStatus;
  plans: BillingPlan[];
  /** Sellable offers from get_billing_catalog(); null when the catalog could not be loaded. */
  catalog: BillingCatalogEntry[] | null;
  /** The live subscription (active, trialing, past_due, unpaid, incomplete), if any. */
  subscription: BillingSubscription | null;
  wallet: BillingWallet | null;
  /** subscription.plan when subscribed, otherwise "free". */
  currentPlan: string;
  /** A Checkout / Portal page was opened in the browser and not returned from yet. */
  pending: "checkout" | "portal" | null;
  /**
   * L1e: a Mercado Pago cancellation request is in flight. Once it returns, a subscription that
   * is still live with cancelAtPeriodEnd means "cancel requested, waiting for Mercado Pago".
   */
  cancelling: boolean;
  lastReturn: BillingReturnStatus | null;
  error: string | null;
};

/** Only a plan key (+ provider, default Mercado Pago); the server maps it to the price. */
export type BillingCheckoutInput = { plan: string; provider?: BillingProvider };
