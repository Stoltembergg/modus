import {
  loadSupabaseConfig,
  requireTestModeStripeKey,
  requireWebhookSecret,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createStripeClient, subtleCryptoProvider } from "../_shared/stripe.ts";
import { createWebhookHandler } from "./handler.ts";

// Throws at boot (the Function does not start) unless STRIPE_SECRET_KEY is sk_test_.
const stripeKey = requireTestModeStripeKey(Deno.env);
const webhookSecret = requireWebhookSecret(Deno.env);
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createWebhookHandler({
    stripe: createStripeClient(stripeKey),
    db: createPostgresBillingDb(supabase.dbUrl),
    webhookSecret,
    cryptoProvider: subtleCryptoProvider,
  }),
);
