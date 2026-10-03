/**
 * Billing (Stripe via Supabase Edge Functions) contract shared by main, preload and renderer.
 *
 * Only display data crosses IPC. The Supabase access token, Stripe customer / subscription ids
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

export type BillingSubscription = {
  plan: string;
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
  /** The live subscription (active, trialing, past_due, unpaid, incomplete), if any. */
  subscription: BillingSubscription | null;
  wallet: BillingWallet | null;
  /** subscription.plan when subscribed, otherwise "free". */
  currentPlan: string;
  /** A Checkout / Portal page was opened in the browser and not returned from yet. */
  pending: "checkout" | "portal" | null;
  lastReturn: BillingReturnStatus | null;
  error: string | null;
};

export type BillingCheckoutInput = { plan: string };
