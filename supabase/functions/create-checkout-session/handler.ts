import type Stripe from "npm:stripe@23.0.0";
import type { GetUser } from "../_shared/auth.ts";
import type { BillingUrls } from "../_shared/config.ts";
import type { BillingDb } from "../_shared/db.ts";
import {
  errorResponse,
  HttpError,
  json,
  readJsonObject,
  requireBillingUrls,
} from "../_shared/http.ts";
import type { StripeApi } from "../_shared/stripe.ts";

export type CheckoutDeps = {
  stripe: Pick<StripeApi, "customers" | "checkout">;
  db: Pick<
    BillingDb,
    "getPurchasablePlan" | "getStripeCustomerId" | "hasLiveSubscription" | "claimStripeCustomer"
  >;
  getUser: GetUser;
  /** From BILLING_RETURN_URL (server env) only; throws when unset or invalid. */
  urls: () => BillingUrls;
};

const PLAN_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Checkout Session parameters from the plan (Checkout Studio, Gabriel
 * 2026-10-03 00:20). Everything identifying the buyer or the price is set
 * here from server state: customer, client_reference_id, metadata, price.
 */
export function checkoutSessionParams(input: {
  userId: string;
  plan: string;
  priceId: string;
  customerId: string;
  urls: BillingUrls;
}): Stripe.Checkout.SessionCreateParams {
  const metadata = { supabase_user_id: input.userId, plan: input.plan };
  return {
    mode: "subscription",
    ui_mode: "hosted_page",
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.urls.successUrl,
    cancel_url: input.urls.cancelUrl,
    metadata,
    subscription_data: { metadata },
    billing_address_collection: "auto",
    phone_number_collection: { enabled: false },
    automatic_tax: { enabled: false },
    allow_promotion_codes: false,
    payment_method_collection: "always",
    // submit_type, integration_identifier and origin_context: accepted by the sandbox API
    // (test Checkout Session, 2026-10-03 01:30 BRT).
    submit_type: "auto",
    integration_identifier: "hosted_mobile_app_0001",
    origin_context: "mobile_app",
  };
}

export function createCheckoutHandler(deps: CheckoutDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      // Fail closed before auth, the database or Stripe when the return page is not configured.
      const urls = requireBillingUrls(deps.urls);
      const user = await deps.getUser(req);
      if (!user) throw new HttpError(401, "unauthorized");

      const body = await readJsonObject(req);
      // Only a plan key: never a price, customer, user id, URL or metadata from the client.
      const keys = Object.keys(body);
      if (
        keys.length !== 1 ||
        keys[0] !== "plan" ||
        typeof body.plan !== "string" ||
        !PLAN_KEY.test(body.plan)
      ) {
        throw new HttpError(400, "invalid_body");
      }

      const plan = await deps.db.getPurchasablePlan(body.plan);
      if (!plan) throw new HttpError(404, "unknown_plan");
      // Plan changes of an existing subscription go through the Customer Portal
      // (upgrade always_invoice, downgrade at period end).
      if (await deps.db.hasLiveSubscription(user.id))
        throw new HttpError(409, "already_subscribed");

      let customerId = await deps.db.getStripeCustomerId(user.id);
      if (!customerId) {
        // Same idempotency key for concurrent requests -> the same customer;
        // claim_stripe_customer keeps whichever was stored first.
        const created = await deps.stripe.customers.create(
          { ...(user.email ? { email: user.email } : {}), metadata: { supabase_user_id: user.id } },
          { idempotencyKey: `modus-customer-${user.id}` },
        );
        if (created.livemode !== false) throw new HttpError(500, "livemode_customer");
        customerId = await deps.db.claimStripeCustomer(user.id, created.id);
      }

      const session = await deps.stripe.checkout.sessions.create(
        checkoutSessionParams({
          userId: user.id,
          plan: plan.plan,
          priceId: plan.stripePriceId,
          customerId,
          urls,
        }),
      );
      if (
        session.livemode !== false ||
        !session.url ||
        !session.url.startsWith("https://checkout.stripe.com/")
      ) {
        throw new HttpError(502, "unexpected_checkout_session");
      }
      return json(200, { url: session.url });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
