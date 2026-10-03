#!/usr/bin/env bash
# B1 SQL tests: start a throwaway local Postgres, load the Supabase shim
# (shim/supabase_shim.sql), apply supabase/migrations/*.sql in order, run the
# pgTAP files in database/ with pg_prove, then the concurrency check.
# Exits non-zero on any failure. Never touches a remote database.
#
# Needs: Postgres 15+ server binaries (initdb, pg_ctl, psql), pgTAP installed
# for that server, and pg_prove (Debian: postgresql-17 postgresql-17-pgtap
# libtap-parser-sourcehandler-pgtap-perl). Override the binaries with PG_BIN.
#
# Auth: no `trust` over TCP. The unix socket lives in a private mktemp dir
# (mode 0700, socket 0700) and uses trust, so only the user running this
# script can reach it; psql, pg_prove and concurrency.sh go through it.
# 127.0.0.1 (used by the Deno integration test) requires scram-sha-256 with a
# random per-run password that is never printed. Same mode locally and in CI.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [[ -z "${PG_BIN:-}" ]]; then
  for candidate in /usr/lib/postgresql/*/bin; do
    [[ -x "$candidate/initdb" ]] && PG_BIN="$candidate"
  done
fi
if [[ -z "${PG_BIN:-}" || ! -x "$PG_BIN/initdb" ]]; then
  echo "run.sh: Postgres server binaries not found (set PG_BIN)" >&2
  exit 2
fi
command -v pg_prove >/dev/null || { echo "run.sh: pg_prove not found" >&2; exit 2; }
command -v deno >/dev/null || { echo "run.sh: deno not found (needed for the db.ts integration test)" >&2; exit 2; }

work="$(mktemp -d)"
chmod 700 "$work"
export PGHOST="$work" PGPORT="${PGPORT_TEST:-55432}" PGUSER=postgres PGDATABASE=postgres
cleanup() {
  "$PG_BIN/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Random per-run password for TCP (hex: URL-safe, no quoting issues).
db_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
[[ ${#db_password} -eq 48 ]] || { echo "run.sh: could not generate a password" >&2; exit 2; }
(umask 077 && printf '%s\n' "$db_password" >"$work/pwfile")
"$PG_BIN/initdb" -D "$work/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 \
  --pwfile="$work/pwfile" --no-sync >/dev/null
rm -f "$work/pwfile"
"$PG_BIN/pg_ctl" -D "$work/data" -l "$work/server.log" -w \
  -o "-p $PGPORT -k $work -c unix_socket_permissions=0700 -c listen_addresses=127.0.0.1 -c fsync=off" \
  start >/dev/null

# Guard: TCP without the password must be refused (no trust on 127.0.0.1).
if PGPASSWORD="" PGPASSFILE=/dev/null "$PG_BIN/psql" -X -q -w -h 127.0.0.1 -c 'select 1' >/dev/null 2>&1; then
  echo "run.sh: 127.0.0.1 accepted a connection without a password" >&2
  exit 1
fi
echo "== auth: socket (private dir) + scram-sha-256 on 127.0.0.1; passwordless TCP refused"

psql_run() { "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "== shim"
psql_run -f "$here/shim/supabase_shim.sql"
echo "== migrations"
for migration in "$root"/supabase/migrations/*.sql; do
  echo "   $(basename "$migration")"
  psql_run -f "$migration"
done

psql_run -f "$here/shim/test_helpers.sql"

echo "== pgTAP"
pg_prove --ext .sql -v "$here"/database/*.test.sql

echo "== concurrency"
PSQL="$PG_BIN/psql" bash "$here/concurrency.sh"

echo "== functions db.ts (npm:postgres, real cluster)"
(cd "$root/supabase/functions" &&
  MODUS_TEST_DB_URL="postgres://postgres:$db_password@127.0.0.1:$PGPORT/postgres" \
    deno test --allow-env --allow-net=127.0.0.1 --allow-read --allow-import _shared/db.integration.ts)

echo "== all SQL tests passed"
