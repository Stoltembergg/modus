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
[[ "$credited6" == 1 && "$errors6" == 0 && "$balance6" == 21000 && "$ledger6" == 1 ]] \
  || { cat "$out"/mp*; fail "concurrent Mercado Pago deliveries: credited exactly once"; }
echo "ok - 6 concurrent deliveries of one approved Mercado Pago payment: credited exactly once (1000 + 20000)"


# 7) Free monthly renewal: one due Free user, renewed by many sessions at once
#    (direct per-user calls and the cron batch). Session 1 renews and holds
#    its transaction open; the others run meanwhile (wallet locked: SKIP
#    LOCKED -> busy / skipped, never waiting or granting) and again after it
#    committed (not due). Exactly one renewal row: topped up 0 -> 1000 once.
uid7="$(q "select tests.create_user('race-free@example.com', true)")"
q "update public.credit_wallets set balance = 0, period_end = now() - interval '1 second' where user_id = '$uid7'" >/dev/null
( "$PSQL" -X -q -t -A -v ON_ERROR_STOP=1 >"$out/fr0" 2>&1 <<SQL
begin;
set local role service_role;
select private.renew_free_credits_for_user('$uid7') ->> 'code';
select pg_sleep(1.2);
commit;
SQL
  echo "exit=$?" >>"$out/fr0" ) &
sleep 0.4
for i in $(seq 1 8); do
  if (( i % 2 )); then call="private.renew_free_credits_for_user('$uid7') ->> 'code'"; else call="private.renew_free_credits()"; fi
  ( "$PSQL" -X -q -t -A -c "set role service_role; select $call" >"$out/fr$i" 2>&1 || true ) &
done
wait
for i in $(seq 1 8); do
  if (( i % 2 )); then call="private.renew_free_credits_for_user('$uid7') ->> 'code'"; else call="private.renew_free_credits()"; fi
  ( "$PSQL" -X -q -t -A -c "set role service_role; select $call" >"$out/fs$i" 2>&1 || true ) &
done
wait
renewed7="$(cat "$out"/fr0 | grep -c '^renewed$' || true)"
busy7="$(cat "$out"/fr[1-8] | grep -c '^busy$' || true)"
# Second round: not due (or busy while a sibling of this round holds the lock).
notdue7="$(cat "$out"/fs* | grep -cE '^(not_due|busy)$' || true)"
again7="$(cat "$out"/fs* | grep -c '^renewed$' || true)"
errors7="$(cat "$out"/fr* "$out"/fs* | grep -c 'ERROR' || true)"
balance7="$(q "select balance || ':' || plan_allowance from public.credit_wallets where user_id = '$uid7'")"
ledger7="$(q "select count(*) from public.credit_transactions where user_id = '$uid7' and idempotency_key like 'free-renewal:%'")"
echo "free renewal x17: renewed=$renewed7 busy=$busy7 not_due_or_busy_after=$notdue7 renewed_after=$again7 errors=$errors7 wallet=$balance7 ledger_rows=$ledger7"
[[ "$renewed7" == 1 && "$busy7" == 4 && "$notdue7" == 4 && "$again7" == 0 && "$errors7" == 0 \
   && "$balance7" == 1000:1000 && "$ledger7" == 1 ]] \
  || { cat "$out"/fr* "$out"/fs*; fail "concurrent Free renewals: renewed exactly once"; }
echo "ok - Free renewal racing itself (per-user + cron batch, wallet held): renewed once (0 -> 1000), others busy / not due"

# 8) L5a: purchased-credit lots under concurrent usage. Allowance 1000 + two
#    5k lots; 20 sessions reserve + settle 500 each (10000) while 4 sessions
#    deliver the approval of a third 5k purchase. Credited once; consumed
#    allowance first, then the lots oldest first (the newest lot untouched);
#    sum(lots remaining) never exceeds balance + reserved; no deadlock.
uid8="$(q "select tests.create_user('race-lots@example.com', true)")"
exp8='{"live_mode":false,"collector_id":"777"}'
for n in 1 2 3; do
  eval "pur8_$n=\"\$(q \"set role service_role; select private.mp_create_purchase('$uid8', 'credits_5k') ->> 'purchase_id'\")\""
done
pay8() { echo "{\"id\":\"$1\",\"status\":\"approved\",\"amount_minor\":3490,\"refunded_minor\":0,\"live_mode\":false,\"collector_id\":\"777\",\"currency\":\"BRL\",\"external_reference\":\"$2\"}"; }
q "set role service_role; select private.process_mp_purchase_payment('$(pay8 880001 "$pur8_1")'::jsonb, '$exp8'::jsonb)" >/dev/null
q "update public.credit_lots set created_at = now() - interval '2 hours' where purchase_id = '$pur8_1'" >/dev/null
q "set role service_role; select private.process_mp_purchase_payment('$(pay8 880002 "$pur8_2")'::jsonb, '$exp8'::jsonb)" >/dev/null
q "update public.credit_lots set created_at = now() - interval '1 hour' where purchase_id = '$pur8_2'" >/dev/null
[[ "$(q "select balance from public.credit_wallets where user_id = '$uid8'")" == 11000 ]] || fail "setup: 1000 + 2 x 5000"
for i in $(seq 1 20); do
  ( "$PSQL" -X -q -t -A >"$out/lot$i" 2>&1 <<SQL || true
set role service_role;
select private.reserve_credits('$uid8', 'lots-$i', 500) ->> 'created';
select (private.settle_usage('$uid8', 'lots-$i', 500, 'm', 'p') ->> 'charged');
SQL
  ) &
  if (( i % 5 == 0 )); then
    ( "$PSQL" -X -q -t -A -c "set role service_role; select private.process_mp_purchase_payment('$(pay8 880003 "$pur8_3")'::jsonb, '$exp8'::jsonb) ->> 'code'" \
        >"$out/lotpay$i" 2>&1 || true ) &
  fi
done
wait
charged8="$(cat "$out"/lot[0-9]* | grep -c '^500$' || true)"
credited8="$(cat "$out"/lotpay* | grep -c '^credited$' || true)"
errors8="$(cat "$out"/lot* | grep -c 'ERROR' || true)"
wallet8="$(q "select balance || '+' || reserved from public.credit_wallets where user_id = '$uid8'")"
lots8="$(q "select string_agg(remaining::text, ',' order by created_at, id) from public.credit_lots where user_id = '$uid8'")"
inv8="$(q "select (select coalesce(sum(remaining), 0) from public.credit_lots where user_id = '$uid8') <= (select balance + reserved from public.credit_wallets where user_id = '$uid8')")"
echo "lots under load: charged=$charged8 credited=$credited8 errors=$errors8 wallet=$wallet8 lots=$lots8 invariant=$inv8"
[[ "$charged8" == 20 && "$credited8" == 1 && "$errors8" == 0 && "$wallet8" == 6000+0 \
   && "$lots8" == 0,1000,5000 && "$inv8" == t ]] \
  || { cat "$out"/lot*; fail "concurrent usage across allowance -> lots"; }
echo "ok - 20 concurrent reserve/settle (10000) + 4 deliveries of a purchase: allowance then oldest lots, credited once, invariant kept"

rm -rf "$out"
