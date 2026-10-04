import postgres, { type TransactionSql } from "npm:postgres@3.4.9";
import type { MpExpectations } from "./config.ts";
import type { MpPayment, MpPreapproval } from "./mp.ts";

/**
 * Server-side data access for the billing Functions. Every call runs in its
 * own transaction as `service_role` (SET LOCAL ROLE), so it has exactly the
 * B1/B3 grants: the private RPCs and service_role table access, nothing more.
 * Connected through SUPABASE_DB_URL because schema `private` is not exposed
 * by the REST API (by design).
 */
export type BillingPlan = { plan: string; stripePriceId: string };

/** private.mp_create_checkout result (B6a). */
export type MpCheckout =
  | { code: "unknown_plan" }
  | { code: "already_subscribed" }
  /** L1g: a cancelled MP subscription is still paid until current_period_end. */
  | { code: "cancel_grace_active" }
  | {
      code: "created" | "reused";
      checkoutId: string;
      plan: string;
      planName: string;
      amountMinor: number;
      currency: string;
      checkoutUrl: string | null;
    };
export type MpLinkResult = {
  code: "linked" | "already_linked" | "conflict" | "not_found";
  checkoutUrl: string | null;
};
export type MpClaim = "new" | "retry" | "duplicate";
/** L1e: one of the user's live Mercado Pago subscriptions (private.mp_cancel_targets). */
export type MpCancelTarget = { preapprovalId: string; status: string; cancelRequested: boolean };

export interface BillingDb {
  /** A purchasable plan (active, with a Stripe price); null for unknown / free / inactive. */
  getPurchasablePlan(plan: string): Promise<BillingPlan | null>;
  getStripeCustomerId(userId: string): Promise<string | null>;
  hasLiveSubscription(userId: string): Promise<boolean>;
  /**
   * L1b: the user has a subscriptions row with a stripe_subscription_id whose status is in
   * STRIPE_PORTAL_SUBSCRIPTION_STATUSES (allowlist). Lets an existing Stripe subscriber open
   * the Portal while STRIPE_ENABLED is off.
   */
  hasStripeSubscription(userId: string): Promise<boolean>;
  /** private.claim_stripe_customer: keeps the stored customer when there is one. */
  claimStripeCustomer(userId: string, customerId: string): Promise<string>;
  /** private.process_stripe_event with the object re-fetched from the Stripe API. */
  processStripeEvent(
    eventId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** B6a: private.mp_create_checkout (creates or reuses the user's open checkout). */
  mpCreateCheckout(userId: string, plan: string): Promise<MpCheckout>;
  mpLinkCheckout(checkoutId: string, preapprovalId: string, url: string): Promise<MpLinkResult>;
  mpClaimNotification(requestId: string, topic: string, dataId: string): Promise<MpClaim>;
  mpFinishNotification(requestId: string, result: string): Promise<void>;
  /** Marks the notification processed in the SAME transaction (requestId). */
  processMpPreapproval(
    pre: MpPreapproval,
    expect: MpExpectations,
    requestId: string | null,
  ): Promise<Record<string, unknown>>;
  processMpPayment(
    payment: MpPayment,
    pre: MpPreapproval | null,
    expect: MpExpectations,
    requestId: string | null,
  ): Promise<Record<string, unknown>>;
  /** L1e: the user's own live Mercado Pago subscriptions; the only source of preapproval ids. */
  mpCancelTargets(userId: string): Promise<MpCancelTarget[]>;
  /** L1e: flags a requested (not yet confirmed) cancellation; never sets the status. */
  mpMarkCancelRequested(userId: string, preapprovalId: string): Promise<"marked" | "not_found">;
}

export function mpExpectJson(expect: MpExpectations): Record<string, unknown> {
  return { live_mode: expect.liveMode, collector_id: expect.collectorId };
}

/**
 * Subscription statuses that still own a paid plan (a second Checkout would double-bill).
 * B6a: across providers (Stripe and Mercado Pago rows); 'paused' is a Mercado Pago pause.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
];

/**
 * L1b: Stripe statuses that may open the Customer Portal while STRIPE_ENABLED is off. An
 * ALLOWLIST: incomplete, incomplete_expired, paused, canceled and any future / unknown status
 * fail closed (subscriptions.status has no CHECK constraint, so the list lives here).
 */
export const STRIPE_PORTAL_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid"];

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

    hasStripeSubscription: (userId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select 1 from public.subscriptions
           where user_id = ${userId} and stripe_subscription_id is not null
             and status = any(${STRIPE_PORTAL_SUBSCRIPTION_STATUSES})
           limit 1`;
        return rows.length > 0;
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

    mpCreateCheckout: (userId, plan) =>
      asServiceRole(async (tx) => {
        const rows = await tx`select private.mp_create_checkout(${userId}, ${plan}) as r`;
        const r = rows[0].r as Record<string, unknown>;
        if (
          r.code === "unknown_plan" ||
          r.code === "already_subscribed" ||
          r.code === "cancel_grace_active"
        )
          return { code: r.code };
        if (r.code !== "created" && r.code !== "reused")
          throw new Error("unexpected checkout code");
        return {
          code: r.code,
          checkoutId: String(r.checkout_id),
          plan: String(r.plan),
          planName: String(r.plan_name),
          amountMinor: Number(r.amount_minor),
          currency: String(r.currency),
          checkoutUrl: typeof r.checkout_url === "string" ? r.checkout_url : null,
        };
      }),

    mpLinkCheckout: (checkoutId, preapprovalId, url) =>
      asServiceRole(async (tx) => {
        const rows =
          await tx`select private.mp_link_checkout(${checkoutId}, ${preapprovalId}, ${url}) as r`;
        const r = rows[0].r as Record<string, unknown>;
        return {
          code: r.code as MpLinkResult["code"],
          checkoutUrl: typeof r.checkout_url === "string" ? r.checkout_url : null,
        };
      }),

    mpClaimNotification: (requestId, topic, dataId) =>
      asServiceRole(async (tx) => {
        const rows =
          await tx`select private.mp_claim_notification(${requestId}, ${topic}, ${dataId}) as r`;
        return rows[0].r as MpClaim;
      }),

    mpFinishNotification: (requestId, result) =>
      asServiceRole(async (tx) => {
        await tx`select private.mp_finish_notification(${requestId}, ${result})`;
      }),

    processMpPreapproval: (pre, expect, requestId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select private.process_mp_preapproval(
            ${tx.json(pre as unknown as postgres.JSONValue)},
            ${tx.json(mpExpectJson(expect) as postgres.JSONValue)},
            ${requestId}) as r`;
        return rows[0].r as Record<string, unknown>;
      }),

    processMpPayment: (payment, pre, expect, requestId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`
          select private.process_mp_payment(
            ${tx.json(payment as unknown as postgres.JSONValue)},
            ${pre ? tx.json(pre as unknown as postgres.JSONValue) : null},
            ${tx.json(mpExpectJson(expect) as postgres.JSONValue)},
            ${requestId}) as r`;
        return rows[0].r as Record<string, unknown>;
      }),

    mpCancelTargets: (userId) =>
      asServiceRole(async (tx) => {
        const rows = await tx`select private.mp_cancel_targets(${userId}) as r`;
        const list = Array.isArray(rows[0].r) ? (rows[0].r as Record<string, unknown>[]) : [];
        return list.flatMap((t) =>
          typeof t.preapproval_id === "string" && typeof t.status === "string"
            ? [
                {
                  preapprovalId: t.preapproval_id,
                  status: t.status,
                  cancelRequested: t.cancel_requested === true,
                },
              ]
            : [],
        );
      }),

    mpMarkCancelRequested: (userId, preapprovalId) =>
      asServiceRole(async (tx) => {
        const rows =
          await tx`select private.mp_mark_cancel_requested(${userId}, ${preapprovalId}) as r`;
        return (rows[0].r as { code?: unknown }).code === "marked" ? "marked" : "not_found";
      }),
  };
}
