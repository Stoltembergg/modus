import type { GetUser } from "../_shared/auth.ts";
import type { BillingUrls, MpExpectations } from "../_shared/config.ts";
import type { BillingDb } from "../_shared/db.ts";
import {
  errorResponse,
  HttpError,
  json,
  readJsonObject,
  requireBillingUrls,
} from "../_shared/http.ts";
import { type MpApi, MpApiError, type MpPreapproval } from "../_shared/mp.ts";

export type MpCheckoutDeps = {
  api: Pick<MpApi, "createPreapproval">;
  db: Pick<BillingDb, "mpCreateCheckout" | "mpLinkCheckout">;
  getUser: GetUser;
  urls: () => BillingUrls;
  expect: MpExpectations;
};

const PLAN_KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** init_point must be Mercado Pago's own (Brazil) checkout page. */
export const MP_CHECKOUT_HOST = "www.mercadopago.com.br";

function isMpCheckoutUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === MP_CHECKOUT_HOST &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * B6a, server only (no app UI yet): POST { plan } -> { url } of a Mercado Pago subscription
 * checkout (preapproval, status pending). The checkout record is created first
 * (private.mp_create_checkout: price from plan_prices, frozen; one open checkout per user,
 * reused), and its id is the preapproval's external_reference and X-Idempotency-Key. Nothing
 * from the client but the plan key; the payer email is the account's.
 */
export function createMpCheckoutHandler(deps: MpCheckoutDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const urls = requireBillingUrls(deps.urls);
      const user = await deps.getUser(req);
      if (!user) throw new HttpError(401, "unauthorized");

      const body = await readJsonObject(req);
      const keys = Object.keys(body);
      if (
        keys.length !== 1 ||
        keys[0] !== "plan" ||
        typeof body.plan !== "string" ||
        !PLAN_KEY.test(body.plan)
      ) {
        throw new HttpError(400, "invalid_body");
      }
      // Mercado Pago rejects the payment when payer_email differs from the payer's account.
      if (!user.email) throw new HttpError(400, "email_required");

      const checkout = await deps.db.mpCreateCheckout(user.id, body.plan);
      if (checkout.code === "unknown_plan") throw new HttpError(404, "unknown_plan");
      if (checkout.code === "already_subscribed") throw new HttpError(409, "already_subscribed");
      if (checkout.checkoutUrl) {
        if (!isMpCheckoutUrl(checkout.checkoutUrl))
          throw new HttpError(502, "unexpected_preapproval");
        return json(200, { url: checkout.checkoutUrl });
      }

      let pre: MpPreapproval;
      try {
        pre = await deps.api.createPreapproval(
          {
            reason: `Modus ${checkout.planName}`,
            externalReference: checkout.checkoutId,
            payerEmail: user.email,
            amountMinor: checkout.amountMinor,
            currency: checkout.currency,
            backUrl: urls.successUrl,
          },
          checkout.checkoutId,
        );
      } catch (error) {
        if (error instanceof MpApiError) {
          console.error("[mp-checkout] preapproval failed:", `${error.kind}:${error.status}`);
          throw new HttpError(502, "mercadopago_unavailable");
        }
        throw error;
      }
      if (
        pre.external_reference !== checkout.checkoutId ||
        pre.amount_minor !== checkout.amountMinor ||
        pre.currency !== checkout.currency ||
        pre.collector_id !== deps.expect.collectorId ||
        !isMpCheckoutUrl(pre.init_point)
      ) {
        throw new HttpError(502, "unexpected_preapproval");
      }

      const linked = await deps.db.mpLinkCheckout(checkout.checkoutId, pre.id, pre.init_point);
      if (linked.code === "conflict") throw new HttpError(409, "checkout_conflict");
      if (linked.code === "not_found" || !linked.checkoutUrl)
        throw new HttpError(500, "checkout_lost");
      return json(200, { url: linked.checkoutUrl });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
