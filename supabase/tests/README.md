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
7. Runs `supabase/functions/_shared/db.integration.ts` with Deno: the real
   `db.ts` (`npm:postgres`) against this cluster, over `127.0.0.1`.

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
- `concurrency.sh`: concurrent reservations from separate connections (2 sessions, a burst of 20, and 5 calls with the same `request_id`), and `release_expired_reservations` racing `settle_usage` (a forced interleaving that deadlocks if the release does not lock the wallet first, plus a burst of 20 + 20).

- `supabase/functions/_shared/db.integration.ts`: the Functions' real `db.ts` through `npm:postgres`. `process_stripe_event` receives a jsonb object (not a JSON string), `customer.subscription.created` and Starter `invoice.paid` (+10000) are processed and recorded in `stripe_events`, a repeated `invoice.paid` grants nothing, and an upgrade invoice grants the difference.

Each pgTAP file runs inside a transaction and rolls back. `concurrency.sh` commits, but only into the throwaway cluster.
