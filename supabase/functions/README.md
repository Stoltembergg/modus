# Supabase Edge Functions

| Function | Purpose | Gated by `STRIPE_ENABLED` |
|---|---|---|
| `create-checkout-session` | Stripe Checkout for a plan (test mode) | yes: off -> `503 stripe_disabled` for everyone |
| `create-portal-session` | Stripe Customer Portal for the caller's own customer | partly: off -> opens only for an existing Stripe subscriber |
| `stripe-webhook` | Stripe events -> `private.process_stripe_event` | **no**, always processes |
| `mp-checkout`, `mp-webhook` | Mercado Pago subscriptions (B6a) | no |
| `mp-cancel` | Cancel the caller's own Mercado Pago subscription (L1e), `verify_jwt = true` | no |
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

## `mp-cancel` (L1e)

Deploy with `verify_jwt = true`. The handler also validates the JWT itself (`createGetUser`, like `mp-checkout`); no user means `401 unauthorized`.

**Request:** `POST` with an empty body or `{}`. Any field (for example a preapproval id) is `400 invalid_body`, before any lookup. The preapproval ids come only from the database: `private.mp_cancel_targets(user)` returns the caller's own live Mercado Pago rows (`incomplete`, `active`, `trialing`, `past_due`, `unpaid`, `paused`).

**Per target:**
1. `PUT /preapproval/{id}` with `{"status":"canceled"}`. Mercado Pago spells it `canceled`; `cancelled` from MP is normalized to the same status.
2. If that answer is not `canceled` (or the PUT failed), `GET /preapproval/{id}` re-reads it.
3. If MP reads `canceled`, the preapproval goes through `private.process_mp_preapproval`, the same path as `mp-webhook`. That is the only place the status changes.
4. A row still live afterwards is only flagged (`private.mp_mark_cancel_requested`: `subscriptions.cancel_requested_at = coalesce(cancel_requested_at, now())`). It stays live, so a new checkout stays blocked until the webhook confirms. `cancel_at_period_end` is not written by mp-cancel (L1g writes it in `process_mp_preapproval`, see 6).
5. Later Mercado Pago webhooks keep `cancel_requested_at` while the row stays live (a late `authorized`, `paused`, or a payment). `process_mp_preapproval` clears it only when the status leaves the live set (L1e replaces the B6a function with that single change).
6. **L1g: paid until the period end.** When MP confirms the cancel, `process_mp_preapproval` sets the row to `canceled` (it leaves the live set: `cancel_requested_at` cleared, no mp-cancel target, the one-live index is free). If the row was `active` / `trialing` and `current_period_end > now()`, it also sets `cancel_at_period_end = true`; `current_period_end` is never moved by the cancel. A repeat or late webhook on the canceled row keeps that. `incomplete`, `paused` or an already-ended period get no grace. `model-router` (`getPlan` in `_shared/router-db.ts`) keeps the plan for `provider = 'mercadopago' and status = 'canceled' and cancel_at_period_end and current_period_end > now()`; after that date the same query returns Free. No cron, nothing runs at the period end. `process_mp_payment` clears `cancel_requested_at` and `cancel_at_period_end` when a refund (`canceled`) or chargeback (`blocked`) moves a row out of the live set, and an approved payment that (re)activates a row clears `cancel_at_period_end`. Stripe rows are unchanged: the grace condition requires `provider = 'mercadopago'`.

**Response** (never an id): `200 {"code":"no_subscription"}` (nothing live: a no-op), `200 {"code":"canceled"}`, `200 {"code":"cancel_requested"}` (not confirmed yet), or `502 mercadopago_unavailable` when MP neither accepted the PUT nor reads `canceled` (nothing changed). Repeats are safe. No refund: credits already granted stay.

**Secrets:** `MP_ACCESS_TOKEN`, `MP_COLLECTOR_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`. These are the same ones `mp-checkout` uses.
