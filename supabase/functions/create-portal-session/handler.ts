import type { GetUser } from "../_shared/auth.ts";
import type { BillingUrls } from "../_shared/config.ts";
import type { BillingDb } from "../_shared/db.ts";
import { errorResponse, HttpError, json, readJsonObject } from "../_shared/http.ts";
import type { StripeApi } from "../_shared/stripe.ts";

export type PortalDeps = {
  stripe: Pick<StripeApi, "billingPortal">;
  db: Pick<BillingDb, "getStripeCustomerId">;
  getUser: GetUser;
  urls: BillingUrls;
};

/** Customer Portal for the caller's OWN stripe_customer_id (from the profile, never the body). */
export function createPortalHandler(deps: PortalDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const user = await deps.getUser(req);
      if (!user) throw new HttpError(401, "unauthorized");
      const body = await readJsonObject(req, { allowEmpty: true });
      if (Object.keys(body).length > 0) throw new HttpError(400, "invalid_body");

      const customerId = await deps.db.getStripeCustomerId(user.id);
      if (!customerId) throw new HttpError(404, "no_billing_account");
      const session = await deps.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: deps.urls.portalReturnUrl,
      });
      if (session.livemode !== false || !session.url.startsWith("https://billing.stripe.com/")) {
        throw new HttpError(502, "unexpected_portal_session");
      }
      return json(200, { url: session.url });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
