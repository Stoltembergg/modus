import type Stripe from "npm:stripe@23.0.0";
import type { BillingDb } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import type { StripeApi } from "../_shared/stripe.ts";

export type WebhookDeps = {
  stripe: Pick<StripeApi, "webhooks" | "subscriptions" | "invoices">;
  db: Pick<BillingDb, "processStripeEvent">;
  webhookSecret: string;
  cryptoProvider: Stripe.CryptoProvider;
};

export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

/** Event types with an effect (B1/B3 process_stripe_event); everything else is acknowledged only. */
export const HANDLED_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
] as const;

type HandledType = (typeof HANDLED_EVENT_TYPES)[number];

function isHandled(type: string): type is HandledType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const signature = req.headers.get("stripe-signature");
    if (!signature) return json(400, { error: "missing_signature" });

    // RAW body, verified before anything parses it.
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_WEBHOOK_BODY_BYTES) {
      return json(413, { error: "body_too_large" });
    }
    let event: Stripe.Event;
    try {
      event = await deps.stripe.webhooks.constructEventAsync(
        raw,
        signature,
        deps.webhookSecret,
        undefined,
        deps.cryptoProvider,
      );
    } catch {
      return json(400, { error: "invalid_signature" });
    }

    // Live lock: only test-mode events (livemode exactly false).
    if (event.livemode !== false) return json(400, { error: "livemode_rejected" });
    if (!isHandled(event.type)) return json(200, { received: true, ignored: true });

    const objectId = (event.data.object as { id?: unknown }).id;
    if (typeof objectId !== "string" || !objectId) return json(400, { error: "missing_object_id" });

    try {
      // Never trust data.object: re-fetch the current object from the Stripe API.
      const fetched =
        event.type === "invoice.paid"
          ? await deps.stripe.invoices.retrieve(objectId)
          : await deps.stripe.subscriptions.retrieve(objectId);
      if (fetched.livemode !== false || fetched.id !== objectId) {
        return json(400, { error: "livemode_rejected" });
      }
      const result = await deps.db.processStripeEvent(
        event.id,
        event.type,
        fetched as unknown as Record<string, unknown>,
      );
      // Duplicate event ids come back as {processed: false, code: duplicate}: a no-op 200.
      return json(200, { received: true, code: String(result.code ?? "") });
    } catch (error) {
      // 500 -> Stripe retries (e.g. an invoice that arrives before its subscription).
      console.error(
        "[stripe-webhook] processing failed:",
        event.type,
        error instanceof Error ? error.name : "",
      );
      return json(500, { error: "processing_failed" });
    }
  };
}
