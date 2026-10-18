import { createGetUser } from "../_shared/auth.ts";
import {
  isStripeEnabled,
  lazyBillingUrls,
  loadSupabaseConfig,
  requireTestModeStripeKey,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createStripeClient } from "../_shared/stripe.ts";
import { createPortalHandler } from "./handler.ts";

// Throws at boot (the Function does not start) unless STRIPE_SECRET_KEY is sk_test_, even
// when STRIPE_ENABLED is off (the live lock never depends on the flag).
const stripeKey = requireTestModeStripeKey(Deno.env);
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createPortalHandler({
    stripe: createStripeClient(stripeKey),
    db: createPostgresBillingDb(supabase.dbUrl),
    getUser: createGetUser(supabase),
    urls: lazyBillingUrls(Deno.env),
    stripeEnabled: () => isStripeEnabled(Deno.env),
  }),
);
