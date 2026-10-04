# Supabase SQL tests (B1)

`run.sh` checks the migrations in `supabase/migrations/` against a **throwaway
local Postgres**. It never connects to the Supabase project.

```sh
npm run test:supabase      # or: bash supabase/tests/run.sh
```

The script:

1. Starts a temporary cluster (`initdb` + `pg_ctl`, unix socket plus
   `127.0.0.1`, port 55432 or `$PGPORT_TEST`). The cluster is removed on exit.
   Auth: the unix socket sits in a private `mktemp -d` directory (0700) and
   uses `trust`. `127.0.0.1` requires `scram-sha-256` with a random password
   generated per run and never printed. The script checks that a TCP
   connection without the password is refused.
2. Loads `shim/supabase_shim.sql`.
3. Applies every `supabase/migrations/*.sql` in order.
4. Loads `shim/test_helpers.sql`.
5. Runs the pgTAP files in `database/` with `pg_prove`.
6. Runs `concurrency.sh`.
7. Runs `supabase/functions/_shared/db.integration.ts`,
   `supabase/functions/model-router/router.integration.ts`,
   `supabase/functions/mp-webhook/mp.integration.ts` and
   `supabase/functions/mp-cancel/cancel.integration.ts` with Deno: the real
   `db.ts` / `router-db.ts` (`npm:postgres`) against this cluster, over
   `127.0.0.1` (the router with a fake OpenAI-compatible upstream, Mercado Pago
   with a fake MP API: the real one is never called).

It exits non-zero on any failure.

## Requirements

- Postgres 15+ server binaries.
- pgTAP for that server, and `pg_prove`.
- Deno 2 (for step 7).

On Debian/Ubuntu:

```sh
sudo apt-get install postgresql postgresql-17-pgtap libtap-parser-sourcehandler-pgtap-perl
```

Set `PG_BIN` to point at another `bin/` directory.

CI runs the same script in the `supabase · pgTAP · integration` job of
`.github/workflows/ci.yml` (Postgres 17 from PGDG, pgTAP, `pg_prove`, Deno
2.9.7), followed by `npm run test:functions`.

## The Supabase shim (`shim/supabase_shim.sql`)

The shim reproduces only what the migrations and tests rely on:

- **Roles:** `anon`, `authenticated`, `service_role` (`BYPASSRLS`), `authenticator`, `supabase_auth_admin`, and `supabase_admin` (a second grantor of default privileges; on hosted Supabase it is the superuser).
- **Schema `auth`:** `auth.users` with the columns the triggers read (`id`, `email`, `email_confirmed_at`, `raw_user_meta_data`, …), plus `auth.uid()`, `auth.role()` and `auth.jwt()`. These read the `request.jwt.claims` setting, the same way PostgREST sets it.
- **Supabase's permissive defaults**, so the tests prove the migration's REVOKEs actually work:
  - `USAGE` on `public` for the API roles.
  - Default privileges, for both `postgres` and `supabase_admin`, granting `ALL` on new public tables, sequences and functions to `anon`, `authenticated` and `service_role`.
  - Postgres' own default `EXECUTE` to `PUBLIC` on new functions.
- **pgTAP**, installed in schema `extensions`.

The shim does not emulate GoTrue, PostgREST or storage. It also skips `pg_cron`: the separate cron migration does nothing unless the extension is installed.

`shim/test_helpers.sql` adds the test-only schema `tests`:

- `create_user` inserts into `auth.users`, which fires the real triggers.
- `authenticate_as`, `as_anon`, `as_service_role` and `clear_authentication` switch the role and the JWT claims for the current transaction.

It is never part of a migration.

## Files

- `database/01_rpc_privileges.test.sql`: who can call the RPCs; every private function is `SECURITY DEFINER` with `search_path=''`; a hostile `search_path` is ignored.
- `database/02_rls_grants.test.sql`: row isolation between users; no client writes except own `display_name` / `avatar_url` (https only); `updated_at` trigger; anon reads only `plans`.
- `database/03_credits.test.sql`: no negative balance; idempotency per `(user_id, request_id)`; settlement capped at the reservation and idempotent; expired reservations refunded; settling an expired reservation returns `reservation_expired` and records an `unbilled` 0-credit usage row.
- `database/04_signup_free_grant.test.sql`: profile and wallet created on signup; the Free credits are granted once, at email confirmation; non-https avatars in the metadata are dropped; the plans seed.
- `database/05_default_privileges.test.sql`: tables, sequences and functions created after the migration are closed to `anon` / `authenticated`.
- `database/06_stripe_events.test.sql`: `process_stripe_event` (duplicates, unknown price / customer, livemode, subscription upsert, invoice credits and their grant rules: billing_reason, amount_paid, proration lines, line choice).
- `database/07_billing_upgrades.test.sql` (B3): mid-period upgrades (`subscription_update` invoices with `amount_paid > 0` grant `max(0, new - plan_allowance)` once per invoice), downgrades never remove credits, the renewal resets the allowance, and `private.claim_stripe_customer`.
- `database/08_model_router.test.sql` (B4a): `router_requests` has no client access; `router_claim_request` (claimed / `idempotency_replay` / `idempotency_conflict`, per user, malformed input rejected); `router_reserve` (402, at most 4 active reservations per user with expired ones released first, 429 leaves nothing behind); release through `settle_usage(0)` and the cap at the reservation; the Free models; cascade on user delete.
- `database/09_mercadopago.test.sql` (B6a): `plan_prices` (BRL seed), one live subscription per user (partial unique index, Stripe and MP), `mp_create_checkout` (reuses the open checkout, supersedes another plan, already subscribed), `mp_link_checkout`, notification claim / finish (retry after a failure), `process_mp_preapproval` (`authorized` -> `incomplete`, pause, cancel, mismatches), `process_mp_payment` (credit only on the first `approved` of a linked invoice, amount frozen in the checkout, collector / live_mode / currency / reference checks, cumulative proportional reversals with `reversed_amount` and shortfall, charged_back blocks, full refund cancels, `rejected_duplicate` on a second live subscription), privileges.
- `database/10_l1a_inactive_plans.test.sql` (L1a): only Starter is for sale. `pro` / `max` / `ultra` are `active = false` (no row deleted, prices unchanged; L1f later doubled the paid credits); the Stripe checkout query and `mp_create_checkout` refuse them; `process_stripe_event` records an inactive-plan price as `rejected_inactive_plan` with no credit ledger change and no subscription upsert (subscription created / updated, first and upgrade invoices, Pro -> Max), fail-closed (an invoice before its subscription row, a canceled row). "Inactive" = off-sale: a subscription already stored on that plan keeps syncing its status and deletion and keeps renewing with credits (`subscription_cycle`, same subscription id and plan, not canceled: Pro renews 50000 once); Pro -> Starter follows B3. Tests 06, 07 and 09 reactivate those plans inside their transaction to keep exercising the paid-plan rules.
- `database/12_l1f_double_credits.test.sql` (L1f): paid plans grant twice the monthly credits (starter 20000, pro 50000, max 140000, ultra 300000), Free stays 1000, USD / BRL prices unchanged. The migration is re-applied (`\ir`) on a simulated pre-L1f state: it changes no wallet balance, reservation, `plan_allowance`, period or ledger row, and re-running it keeps the same values. The next `subscription_cycle` credits the new amount (Starter +20000; an existing off-sale Pro subscriber +50000) and resets `plan_allowance`.
- `database/13_l1e_mp_cancel.test.sql` (L1e): `private.mp_cancel_targets` returns only the user's own live Mercado Pago rows (`incomplete`, `active`, `trialing`, `past_due`, `unpaid`, `paused`; never Stripe rows, never another user's); `private.mp_mark_cancel_requested` only sets `subscriptions.cancel_requested_at` (coalesce: a repeat keeps the first time) on the caller's own live MP row (never the status, `cancel_at_period_end`, another user's row, a Stripe row or a malformed id: 22023), and changes no credits. Late webhooks that keep the row live (`authorized`, `paused`, a repeated payment) keep the flag; the replaced `process_mp_preapproval` (same SECURITY DEFINER / search_path / grants) clears it only when the status leaves the live set. The column is timestamptz, nullable, readable by the owner, never writable by anon / authenticated. Cancel confirmed through `process_mp_preapproval` (`canceled`, flag cleared, checkout closed, credits kept), then no target is left, and a new checkout is possible (incomplete -> "Cancel and try again"). Both functions are SECURITY DEFINER with `search_path = ''`, service_role only.
- `concurrency.sh`: concurrent reservations from separate connections (2 sessions, a burst of 20, and 5 calls with the same `request_id`), and `release_expired_reservations` racing `settle_usage` (a forced interleaving that deadlocks if the release does not lock the wallet first, plus a burst of 20 + 20), and 6 concurrent deliveries of one approved Mercado Pago payment (credited once).

- `supabase/functions/model-router/router.integration.ts`: the model-router handler with the real `router-db.ts`: a call reserves and settles the real usage (the rest refunded, `usage_events` billed), a repeated key is 409 replay / conflict, a model outside the plan is refused before any reservation, an upstream failure refunds everything, a stream cut by the client settles the partial estimate (capped), 402 reserves nothing, 6 concurrent calls never go negative, no reservation is left active, and every seeded `allowed_models` id is in the server model table.
- `supabase/functions/mp-webhook/mp.integration.ts`: `mp-checkout` (record, preapproval, link; a second call reuses it) and `mp-webhook` with real signatures: `authorized` -> `incomplete`, a DB failure on the first delivery leaves the notification unprocessed (500), the MP retry with the same `x-request-id` credits exactly once, later deliveries are `duplicate` / `already_credited`, a partial then full refund debits proportionally and cancels, an unlinked payment credits nothing.
- `supabase/functions/mp-cancel/cancel.integration.ts` (L1e): `mp-checkout` + `mp-webhook` + `mp-cancel` with a fake MP API: an `incomplete` subscription, another user gets `no_subscription` and no MP call, an unconfirmed cancel is `cancel_requested` (row still `incomplete`, `cancel_requested_at` set, `cancel_at_period_end` untouched), a late `authorized` webhook keeps the flag, the confirmed one is `canceled` through `process_mp_preapproval`, a repeat is a no-op, a late `authorized` webhook does not revive it, and a fresh checkout works.
- `supabase/functions/_shared/db.integration.ts`: the Functions' real `db.ts` through `npm:postgres`. `process_stripe_event` receives a jsonb object (not a JSON string), `customer.subscription.created` and Starter `invoice.paid` (+20000) are processed and recorded in `stripe_events`, a repeated `invoice.paid` grants nothing, and an upgrade invoice grants the difference.

Each pgTAP file runs inside a transaction and rolls back. `concurrency.sh` commits, but only into the throwaway cluster.
