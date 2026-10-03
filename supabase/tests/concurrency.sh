#!/usr/bin/env bash
# Case 4: concurrent reservations on one wallet, from separate connections.
# Called by run.sh (PGHOST / PGPORT / PGUSER / PGDATABASE and PSQL set).
set -euo pipefail
PSQL="${PSQL:-psql}"
q() { "$PSQL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

uid="$(q "select tests.create_user('race@example.com', true)")"
[[ "$(q "select balance from public.credit_wallets where user_id = '$uid'")" == 1000 ]] \
  || fail "setup: balance 1000"

# 1) Two sessions, 600 + 600 > 1000. Session 1 reserves and holds its
#    transaction open; session 2 starts while the wallet row is locked and
#    must wait, then see the new balance and fail.
out="$(mktemp -d)"
( "$PSQL" -X -q -t -A -v ON_ERROR_STOP=1 >"$out/s1" 2>&1 <<SQL
begin;
set local role service_role;
select private.reserve_credits('$uid', 'race-1', 600) ->> 'created';
select pg_sleep(1.5);
commit;
SQL
  echo "exit=$?" >>"$out/s1" ) &
sleep 0.4
( "$PSQL" -X -q -t -A -v ON_ERROR_STOP=1 >"$out/s2" 2>&1 <<SQL
begin;
set local role service_role;
select private.reserve_credits('$uid', 'race-2', 600) ->> 'created';
commit;
SQL
  echo "exit=$?" >>"$out/s2" ) &
wait
ok_count="$(cat "$out/s1" "$out/s2" | grep -c '^true$' || true)"
denied="$(cat "$out/s1" "$out/s2" | grep -c 'insufficient credits' || true)"
balance="$(q "select balance from public.credit_wallets where user_id = '$uid'")"
reserved="$(q "select reserved from public.credit_wallets where user_id = '$uid'")"
echo "two sessions: succeeded=$ok_count insufficient=$denied balance=$balance reserved=$reserved"
[[ "$ok_count" == 1 && "$denied" == 1 ]] || { cat "$out"/s1 "$out"/s2; fail "exactly one of two reservations succeeds"; }
[[ "$balance" == 400 && "$reserved" == 600 ]] || fail "final balance 400 / reserved 600"
echo "ok - two concurrent reservations (600 + 600 > 1000): exactly one succeeds, balance 400 >= 0"

# 2) Twenty sessions at once, 300 each, on a fresh 1000 wallet: exactly 3 win.
uid2="$(q "select tests.create_user('race2@example.com', true)")"
for i in $(seq 1 20); do
  ( "$PSQL" -X -q -t -A -c "set role service_role; select private.reserve_credits('$uid2', 'burst-$i', 300) ->> 'created'" \
      >"$out/b$i" 2>&1 || true ) &
done
wait
wins="$(cat "$out"/b* | grep -c '^true$' || true)"
losses="$(cat "$out"/b* | grep -c 'insufficient credits' || true)"
balance2="$(q "select balance from public.credit_wallets where user_id = '$uid2'")"
rows="$(q "select count(*) from public.credit_reservations where user_id = '$uid2'")"
echo "twenty sessions: succeeded=$wins insufficient=$losses balance=$balance2 reservations=$rows"
[[ "$wins" == 3 && "$losses" == 17 && "$balance2" == 100 && "$rows" == 3 ]] \
  || fail "burst: exactly 3 of 20 reservations of 300 succeed, balance 100"
echo "ok - 20 concurrent reservations of 300 on 1000: exactly 3 succeed, balance 100 >= 0"

# 3) Same request_id from two sessions at once: one reservation, one deduction.
uid3="$(q "select tests.create_user('race3@example.com', true)")"
for i in 1 2 3 4 5; do
  ( "$PSQL" -X -q -t -A -c "set role service_role; select private.reserve_credits('$uid3', 'same-id', 100) ->> 'created'" \
      >"$out/d$i" 2>&1 || true ) &
done
wait
created="$(cat "$out"/d* | grep -c '^true$' || true)"
repeats="$(cat "$out"/d* | grep -c '^false$' || true)"
balance3="$(q "select balance from public.credit_wallets where user_id = '$uid3'")"
echo "same request_id x5: created=$created repeats=$repeats balance=$balance3"
[[ "$created" == 1 && "$repeats" == 4 && "$balance3" == 900 ]] \
  || { cat "$out"/d*; fail "concurrent duplicates: one reservation, deducted once"; }
echo "ok - 5 concurrent calls with the same request_id: one reservation, deducted once"

rm -rf "$out"
