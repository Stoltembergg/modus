#!/usr/bin/env bash
# Case 4: concurrent reservations on one wallet, from separate connections;
# plus release_expired_reservations racing settle_usage (no deadlock), and
# (B6a) concurrent deliveries of one Mercado Pago payment.
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

# 4) release_expired_reservations(user) vs settle_usage on the same expired
#    reservation. Session 1 takes the wallet lock first (settle_usage's order:
#    wallet -> reservation) and holds it; session 2 starts the release while
#    the wallet is held; then session 1 settles. If release touched the
#    reservation before locking the wallet, this is a guaranteed deadlock.
uid4="$(q "select tests.create_user('race4@example.com', true)")"
q "set role service_role; select private.reserve_credits('$uid4', 'exp-x', 100)" >/dev/null
q "update public.credit_reservations set expires_at = now() - interval '1 second' where user_id = '$uid4'"
( "$PSQL" -X -q -t -A -v ON_ERROR_STOP=1 >"$out/r1" 2>&1 <<SQL
begin;
set local role service_role;
select 'locked' from public.credit_wallets where user_id = '$uid4' for update;
select pg_sleep(1.5);
select private.settle_usage('$uid4', 'exp-x', 30, 'm', 'p') ->> 'code';
commit;
SQL
  echo "exit=$?" >>"$out/r1" ) &
sleep 0.4
( "$PSQL" -X -q -t -A -v ON_ERROR_STOP=1 >"$out/r2" 2>&1 <<SQL
set role service_role;
select 'released=' || private.release_expired_reservations('$uid4');
SQL
  echo "exit=$?" >>"$out/r2" ) &
wait
grep -qi deadlock "$out/r1" "$out/r2" && { cat "$out/r1" "$out/r2"; fail "release vs settle: deadlock"; }
grep -q '^exit=0$' "$out/r1" && grep -q '^exit=0$' "$out/r2" \
  || { cat "$out/r1" "$out/r2"; fail "release vs settle: both sessions succeed"; }
settle_code="$(grep -E '^(reservation_expired|settled)$' "$out/r1" || true)"
released="$(grep '^released=' "$out/r2" || true)"
state4="$(q "select balance || '/' || reserved from public.credit_wallets where user_id = '$uid4'")"
usage4="$(q "select status || ':' || credits from public.usage_events where user_id = '$uid4'")"
echo "release vs settle: settle=$settle_code $released wallet=$state4 usage=$usage4"
[[ "$settle_code" == reservation_expired && "$released" == released=0 && "$state4" == 1000/0 \
   && "$usage4" == unbilled:0 ]] || fail "release vs settle: consistent result"
echo "ok - release_expired_reservations racing settle_usage on the same reservation: no deadlock, refunded once, not charged"

# 5) Burst: 10 expired + 10 active reservations; for each one a settle and a
#    direct release start at the same time. No deadlock, and the wallet adds
#    up: 1000 - 10 x 10 charged on the active ones = 900, nothing reserved.
uid5="$(q "select tests.create_user('race5@example.com', true)")"
for i in $(seq 1 10); do
  q "set role service_role; select private.reserve_credits('$uid5', 'old-$i', 50)" >/dev/null
done
q "update public.credit_reservations set expires_at = now() - interval '1 second' where user_id = '$uid5'"
for i in $(seq 1 10); do
  q "set role service_role; select private.reserve_credits('$uid5', 'new-$i', 40)" >/dev/null
done
for i in $(seq 1 10); do
  for kind in old new; do
    ( "$PSQL" -X -q -t -A -c "set role service_role; select private.settle_usage('$uid5', '$kind-$i', 10, 'm', 'p') ->> 'code'" \
        >"$out/m-$kind-$i" 2>&1 || true ) &
    ( "$PSQL" -X -q -t -A -c "set role service_role; select private.release_expired_reservations('$uid5')" \
        >"$out/m-rel-$kind-$i" 2>&1 || true ) &
  done
done
wait
deadlocks="$(cat "$out"/m-* | grep -ci deadlock || true)"
errors="$(cat "$out"/m-* | grep -c 'ERROR' || true)"
expired5="$(cat "$out"/m-old-* | grep -c '^reservation_expired$' || true)"
settled5="$(cat "$out"/m-new-* | grep -c '^settled$' || true)"
state5="$(q "select balance || '/' || reserved from public.credit_wallets where user_id = '$uid5'")"
ledger5="$(q "select sum(amount) from public.credit_transactions where user_id = '$uid5'")"
echo "release/settle burst: deadlocks=$deadlocks errors=$errors expired=$expired5 settled=$settled5 wallet=$state5 ledger=$ledger5"
[[ "$deadlocks" == 0 && "$errors" == 0 && "$expired5" == 10 && "$settled5" == 10 \
   && "$state5" == 900/0 && "$ledger5" == 900 ]] \
  || { cat "$out"/m-* | sort | uniq -c; fail "release/settle burst: no deadlock, consistent balance"; }
echo "ok - 20 settles racing 20 direct releases: no deadlock, balance 900 = ledger, nothing reserved"

# 6) B6a: the same approved Mercado Pago payment delivered by 6 sessions at
#    once (invoice + payment topics, MP retries): credited exactly once.
uid6="$(q "select tests.create_user('race-mp@example.com', true)")"
co6="$(q "set role service_role; select private.mp_create_checkout('$uid6', 'starter') ->> 'checkout_id'")"
q "set role service_role; select private.mp_link_checkout('$co6', 'PRERACE', 'https://www.mercadopago.com.br/x')" >/dev/null
pre6="{\"id\":\"PRERACE\",\"status\":\"authorized\",\"external_reference\":\"$co6\",\"collector_id\":\"777\",\"amount_minor\":4990,\"currency\":\"BRL\",\"next_payment_date\":null}"
pay6='{"id":"990001","status":"approved","amount_minor":4990,"refunded_minor":0,"live_mode":false,"collector_id":"777","currency":"BRL","external_reference":null}'
exp6='{"live_mode":false,"collector_id":"777"}'
for i in $(seq 1 6); do
  if (( i % 2 )); then pre_arg="'$pre6'::jsonb"; else pre_arg="null"; fi
  ( "$PSQL" -X -q -t -A -c "set role service_role; select private.process_mp_payment('$pay6'::jsonb, $pre_arg, '$exp6'::jsonb) ->> 'code'" \
      >"$out/mp$i" 2>&1 || true ) &
done
wait
credited6="$(cat "$out"/mp* | grep -c '^credited$' || true)"
errors6="$(cat "$out"/mp* | grep -c 'ERROR' || true)"
balance6="$(q "select balance from public.credit_wallets where user_id = '$uid6'")"
ledger6="$(q "select count(*) from public.credit_transactions where idempotency_key = 'mp:payment:990001'")"
echo "mp payment x6: credited=$credited6 errors=$errors6 balance=$balance6 ledger_rows=$ledger6"
[[ "$credited6" == 1 && "$errors6" == 0 && "$balance6" == 11000 && "$ledger6" == 1 ]] \
  || { cat "$out"/mp*; fail "concurrent Mercado Pago deliveries: credited exactly once"; }
echo "ok - 6 concurrent deliveries of one approved Mercado Pago payment: credited exactly once (1000 + 10000)"

rm -rf "$out"
