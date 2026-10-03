import postgres, { type TransactionSql } from "npm:postgres@3.4.9";

/**
 * Server-side data access for the billing Functions. Every call runs in its
 * own transaction as `service_role` (SET LOCAL ROLE), so it has exactly the
 * B1/B3 grants: the private RPCs and service_role table access, nothing more.
 * Connected through SUPABASE_DB_URL because schema `private` is not exposed
 * by the REST API (by design).
 */
export type BillingPlan = { plan: string; stripePriceId: string };

export interface BillingDb {
  /** A purchasable plan (active, with a Stripe price); null for unknown / free / inactive. */
  getPurchasablePlan(plan: string): Promise<BillingPlan | null>;
  getStripeCustomerId(userId: string): Promise<string | null>;
  hasLiveSubscription(userId: string): Promise<boolean>;
  /** private.claim_stripe_customer: keeps the stored customer when there is one. */
  claimStripeCustomer(userId: string, customerId: string): Promise<string>;
  /** private.process_stripe_event with the object re-fetched from the Stripe API. */
  processStripeEvent(
    eventId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** Subscription statuses that still own a paid plan (a second Checkout would double-bill). */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
];

export function createPostgresBillingDb(dbUrl: string): BillingDb {
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 20, prepare: false });

  async function asServiceRole<T>(run: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx`set local role service_role`;
      return await run(tx);
    })) as T;
  }

  return {
    getPurchasablePlan: (plan) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select plan, stripe_price_id from public.plans
           where plan = ${plan} and active and stripe_price_id is not null`;
        return rows.length ? { plan: rows[0].plan, stripePriceId: rows[0].stripe_price_id } : null;
      }),

    getStripeCustomerId: (userId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`select stripe_customer_id from public.profiles where id = ${userId}`;
        return rows[0]?.stripe_customer_id ?? null;
      }),

    hasLiveSubscription: (userId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select 1 from public.subscriptions
           where user_id = ${userId} and status = any(${LIVE_SUBSCRIPTION_STATUSES})
           limit 1`;
        return rows.length > 0;
      }),

    claimStripeCustomer: (userId, customerId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`select private.claim_stripe_customer(${userId}, ${customerId}) as id`;
        return rows[0].id as string;
      }),

    processStripeEvent: (eventId, type, payload) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select private.process_stripe_event(${eventId}, ${type}, ${tx.json(payload as postgres.JSONValue)}) as result`;
        return rows[0].result as Record<string, unknown>;
      }),
  };
}
