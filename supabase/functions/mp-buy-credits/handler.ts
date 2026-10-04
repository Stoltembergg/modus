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
import { type MpApi, MpApiError, type MpPreference } from "../_shared/mp.ts";
import { MP_CHECKOUT_HOST } from "../mp-checkout/handler.ts";

export type MpBuyCreditsDeps = {
  api: Pick<MpApi, "createPreference">;
  db: Pick<BillingDb, "mpCreatePurchase" | "mpLinkPurchase">;
  getUser: GetUser;
  urls: () => BillingUrls;
  /** `${SUPABASE_URL}/functions/v1/mp-webhook?source_news=webhooks` (never from the request). */
  notificationUrl: string;
  expect: MpExpectations;
  now?: () => number;
};

/** The only packs a client may name (L5a seeds exactly these in public.credit_packs). */
export const CREDIT_PACK_IDS = ["credits_5k", "credits_10k", "credits_25k"] as const;

/** L5b: a Checkout Pro link for a pack expires 30 minutes after it was created. */
export const PACK_CHECKOUT_TTL_MS = 30 * 60 * 1000;

export function mpNotificationUrl(supabaseUrl: string): string {
  // source_news=webhooks: Mercado Pago sends only the Webhooks format (data.id + x-signature),
  // never the legacy IPN (?id=&topic=) that mp-webhook rejects.
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/mp-webhook?source_news=webhooks`;
}

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
 * L5b: POST { packId } -> { url } of a Mercado Pago Checkout Pro page for a one-off credit
 * pack (Pix or card, a single installment). Only the pack id comes from the client: the
 * purchase is recorded first (private.mp_create_purchase: credits and price from
 * public.credit_packs, frozen; a blocked account is refused), and its id is the preference's
 * external_reference and X-Idempotency-Key. The payment is credited by mp-webhook
 * (private.process_mp_purchase_payment) against that frozen purchase, never here.
 */
export function createMpBuyCreditsHandler(
  deps: MpBuyCreditsDeps,
): (req: Request) => Promise<Response> {
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
        keys[0] !== "packId" ||
        typeof body.packId !== "string" ||
        !(CREDIT_PACK_IDS as readonly string[]).includes(body.packId)
      ) {
        throw new HttpError(400, "invalid_body");
      }
      if (!user.email) throw new HttpError(400, "email_required");

      const purchase = await deps.db.mpCreatePurchase(user.id, body.packId);
      if (purchase.code === "unknown_pack") throw new HttpError(404, "unknown_pack");
      if (purchase.code === "blocked") throw new HttpError(403, "account_blocked");

      let pref: MpPreference;
      try {
        pref = await deps.api.createPreference(
          {
            packId: purchase.packId,
            title: `Modus ${purchase.name}`,
            externalReference: purchase.purchaseId,
            payerEmail: user.email,
            amountMinor: purchase.amountMinor,
            currency: purchase.currency,
            notificationUrl: deps.notificationUrl,
            backUrls: {
              success: urls.successUrl,
              pending: urls.successUrl,
              failure: urls.cancelUrl,
            },
            expiresAt: new Date((deps.now ?? Date.now)() + PACK_CHECKOUT_TTL_MS),
          },
          purchase.purchaseId,
        );
      } catch (error) {
        if (error instanceof MpApiError) {
          console.error("[mp-buy-credits] preference failed:", `${error.kind}:${error.status}`);
          throw new HttpError(502, "mercadopago_unavailable");
        }
        throw error;
      }
      if (
        pref.external_reference !== purchase.purchaseId ||
        pref.amount_minor !== purchase.amountMinor ||
        pref.currency !== purchase.currency ||
        pref.collector_id !== deps.expect.collectorId ||
        !isMpCheckoutUrl(pref.init_point)
      ) {
        throw new HttpError(502, "unexpected_preference");
      }

      const linked = await deps.db.mpLinkPurchase(purchase.purchaseId, pref.id, pref.init_point);
      if (linked.code === "conflict") throw new HttpError(409, "purchase_conflict");
      if (linked.code === "not_found" || !linked.checkoutUrl)
        throw new HttpError(500, "purchase_lost");
      return json(200, { url: linked.checkoutUrl });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
