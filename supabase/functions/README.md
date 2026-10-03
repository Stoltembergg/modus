# Supabase Edge Functions

| Function | Purpose | Gated by `STRIPE_ENABLED` |
|---|---|---|
| `create-checkout-session` | Stripe Checkout for a plan (test mode) | yes: off -> `503 stripe_disabled` for everyone |
| `create-portal-session` | Stripe Customer Portal for the caller's own customer | partly: off -> opens only for an existing Stripe subscriber |
| `stripe-webhook` | Stripe events -> `private.process_stripe_event` | **no**, always processes |
| `mp-checkout`, `mp-webhook` | Mercado Pago subscriptions (B6a) | no |
| `model-router` | Modus model router (B4a) | no |

Secrets are listed in [`.env.example`](.env.example). For the local stack, copy it to `supabase/functions/.env`. For the hosted project, set them with `supabase secrets set`.

## `STRIPE_ENABLED` (L1b)

`_shared/config.ts` `isStripeEnabled(env)` parses the flag.

**Values**
- Only the exact value `true` (whitespace trimmed) enables Stripe.
- Missing, empty, `false`, `1`, `TRUE`, `yes` or anything else means **disabled**. This is fail-closed: a deploy that forgets the secret cannot sell through Stripe. Release L1 sells Starter through Mercado Pago only.

**When disabled**
- `create-checkout-session` answers `503 {"error":"stripe_disabled"}`. It does so right after the method check, before auth, the database or Stripe.
- `create-portal-session` still opens for a user with a `subscriptions` row that has a `stripe_subscription_id` and a status in the allowlist `active`, `trialing`, `past_due` or `unpaid` (`STRIPE_PORTAL_SUBSCRIPTION_STATUSES` in `_shared/db.ts`). `incomplete`, `incomplete_expired`, `paused`, `canceled` and any unknown status fail closed. The row is looked up server-side for the authenticated user (`db.hasStripeSubscription`), never from the request. Such a user can still manage or cancel. Everyone else gets `503 stripe_disabled`.
- `stripe-webhook` is not gated. Existing Stripe subscriptions keep syncing, renewing (see L1a) and leaving audit rows in `stripe_events`.

**Unchanged**
- Every Stripe Function still refuses to boot unless `STRIPE_SECRET_KEY` is `sk_test_…`, even when the flag is off. The live lock does not depend on the flag.

**Deploy:** set `STRIPE_ENABLED` explicitly in the function secrets: `supabase secrets set STRIPE_ENABLED=false`, or `true` to sell through Stripe again. The flag is read per request.

## Billing catalog and the DB Stripe flag (L1c)

`public.get_billing_catalog()` is an RPC that anon and authenticated can call. It returns the active paid plans with their enabled providers. Each row has: plan, name, monthly_credits, provider, currency, amount_minor and sort_order. It never returns Stripe price ids or lookup keys, Mercado Pago ids, collector ids or credentials. Inactive plans (pro, max and ultra after L1a) and `free` are excluded.

The providers come from `private.billing_settings`, a single-row table:
- `stripe_enabled` defaults to `false`.
- `mercadopago_enabled` defaults to `true`.

Only a migration or service_role can change the table: anon and authenticated have no grant and no policy on it.

**Enabling Stripe takes TWO steps, and both are required:**
1. **DB flag (UI visibility):** set `private.billing_settings.stripe_enabled = true` through a migration or service_role. The catalog then lists the Stripe (USD) price, so the UI offers it.
2. **Env flag (checkout):** set `supabase secrets set STRIPE_ENABLED=true` (see above). `stripe-checkout` then accepts requests.

If the two flags disagree, nothing is sold through Stripe:
- DB `true` with env not `true`: the UI shows Stripe, but checkout answers 503 `stripe_disabled`.
- DB `false` with env `true`: the UI does not offer Stripe at all.

To disable Stripe, turn off both, starting with the env, which is the hard block.

**Tests and CI:** no test needs `STRIPE_ENABLED`. Handler tests inject `stripeEnabled`, and the SQL / integration tests (`supabase/tests/run.sh`) call `db.ts` and the RPCs directly, never the HTTP Functions. The desktop app's billing tests mock the backend.
