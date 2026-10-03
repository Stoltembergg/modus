# Supabase SQL tests (B1)

`run.sh` checks the migrations in `supabase/migrations/` against a **throwaway
local Postgres**. It never connects to the Supabase project.

```sh
npm run test:supabase      # or: bash supabase/tests/run.sh
```

The script:

1. Starts a temporary cluster (`initdb` + `pg_ctl`, unix socket only, port
   55432 or `$PGPORT_TEST`). The cluster is removed on exit.
2. Loads `shim/supabase_shim.sql`.
3. Applies every `supabase/migrations/*.sql` in order.
4. Loads `shim/test_helpers.sql`.
5. Runs the pgTAP files in `database/` with `pg_prove`.
6. Runs `concurrency.sh`.

It exits non-zero on any failure.

## Requirements

- Postgres 15+ server binaries.
- pgTAP for that server, and `pg_prove`.

On Debian/Ubuntu:

```sh
sudo apt-get install postgresql postgresql-17-pgtap libtap-parser-sourcehandler-pgtap-perl
```

Set `PG_BIN` to point at another `bin/` directory.

## The Supabase shim (`shim/supabase_shim.sql`)

The shim reproduces only what the migrations and tests rely on:

- **Roles:** `anon`, `authenticated`, `service_role` (`BYPASSRLS`), `authenticator`, and `supabase_auth_admin`.
- **Schema `auth`:** `auth.users` with the columns the triggers read (`id`, `email`, `email_confirmed_at`, `raw_user_meta_data`, …), plus `auth.uid()`, `auth.role()` and `auth.jwt()`. These read the `request.jwt.claims` setting, the same way PostgREST sets it.
- **Supabase's permissive defaults**, so the tests prove the migration's REVOKEs actually work:
  - `USAGE` on `public` for the API roles.
  - Default privileges granting `ALL` on new public tables, sequences and functions to `anon`, `authenticated` and `service_role`.
  - Postgres' own default `EXECUTE` to `PUBLIC` on new functions.
- **pgTAP**, installed in schema `extensions`.

The shim does not emulate GoTrue, PostgREST or storage. It also skips `pg_cron`: the migration only schedules the expiry sweep when the extension is available.

`shim/test_helpers.sql` adds the test-only schema `tests`:

- `create_user` inserts into `auth.users`, which fires the real triggers.
- `authenticate_as`, `as_anon`, `as_service_role` and `clear_authentication` switch the role and the JWT claims for the current transaction.

It is never part of a migration.

## Files

- `database/01_rpc_privileges.test.sql`: who can call the RPCs; every private function is `SECURITY DEFINER` with `search_path=''`; a hostile `search_path` is ignored.
- `database/02_rls_grants.test.sql`: row isolation between users; no client writes except own `display_name` / `avatar_url`; anon reads only `plans`.
- `database/03_credits.test.sql`: no negative balance; idempotency per `(user_id, request_id)`; settlement capped at the reservation and idempotent; expired reservations refunded.
- `database/04_signup_free_grant.test.sql`: profile and wallet created on signup; the Free credits are granted once, at email confirmation; the plans seed.
- `concurrency.sh`: concurrent reservations from separate connections (2 sessions, a burst of 20, and 5 calls with the same `request_id`).

Each pgTAP file runs inside a transaction and rolls back. `concurrency.sh` commits, but only into the throwaway cluster.
