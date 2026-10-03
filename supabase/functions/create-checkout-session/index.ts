import { createGetUser } from "../_shared/auth.ts";
import {
  loadBillingUrls,
  loadSupabaseConfig,
  requireTestModeStripeKey,
} from "../_shared/config.ts";
import { createPostgresBillingDb } from "../_shared/db.ts";
import { createStripeClient } from "../_shared/stripe.ts";
import { createCheckoutHandler } from "./handler.ts";

// Throws at boot (the Function does not start) unless STRIPE_SECRET_KEY is sk_test_.
const stripeKey = requireTestModeStripeKey(Deno.env);
const supabase = loadSupabaseConfig(Deno.env);

Deno.serve(
  createCheckoutHandler({
    stripe: createStripeClient(stripeKey),
    db: createPostgresBillingDb(supabase.dbUrl),
    getUser: createGetUser(supabase),
    urls: loadBillingUrls(Deno.env),
  }),
);
