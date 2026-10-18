-- Cases 3, 5, 6, 7: no negative balance, reservation expiry, settlement
-- capped at the reservation, idempotency per (user_id, request_id).
begin;
set local search_path = public, extensions;
select no_plan();

select tests.create_user('a@example.com', true) as a \gset
select tests.create_user('b@example.com', true) as b \gset
select tests.as_service_role();

create function pg_temp.balance(p_user uuid) returns bigint
language sql as $$ select balance from public.credit_wallets where user_id = p_user $$;
create function pg_temp.reserved(p_user uuid) returns bigint
language sql as $$ select reserved from public.credit_wallets where user_id = p_user $$;

select is(pg_temp.balance(:'a'), 1000::bigint, 'start: free grant 1000');

-- Case 3: reserving more than the balance fails and changes nothing.
select throws_ok(format($q$select private.reserve_credits(%L, 'too-much', 1001)$q$, :'a'),
  'P0402', 'insufficient credits', 'reserve 1001 of 1000 -> insufficient credits');
select is(pg_temp.balance(:'a'), 1000::bigint, 'balance unchanged after the failed reserve');
select is((select count(*)::int from public.credit_reservations where user_id = :'a'), 0,
  'no reservation row written');
select throws_ok(format($q$update public.credit_wallets set balance = -1 where user_id = %L$q$, :'a'),
  '23514', null, 'CHECK (balance >= 0) holds even for service_role');
select throws_ok(format($q$update public.credit_wallets set reserved = -1 where user_id = %L$q$, :'a'),
  '23514', null, 'CHECK (reserved >= 0) holds even for service_role');
select throws_ok(format($q$select private.reserve_credits(%L, 'zero', 0)$q$, :'a'),
  '22023', null, 'reserve of 0 rejected');
select throws_ok(format($q$select private.reserve_credits(%L, 'neg', -5)$q$, :'a'),
  '22023', null, 'negative reserve rejected');
select lives_ok(format($q$select private.reserve_credits(%L, 'all', 1000)$q$, :'a'),
  'reserving exactly the balance works');
select is(pg_temp.balance(:'a'), 0::bigint, 'balance 0 after reserving everything');
select throws_ok(format($q$select private.reserve_credits(%L, 'one-more', 1)$q$, :'a'),
  'P0402', null, 'nothing left to reserve');
select private.settle_usage(:'a', 'all', 0, 'm', 'p') \gset settle_all_
select is(pg_temp.balance(:'a'), 1000::bigint, 'settling 0 refunds everything');

-- Case 7: idempotency per (user_id, request_id).
select (private.reserve_credits(:'a', 'req-1', 100))::text as r1 \gset
select (private.reserve_credits(:'a', 'req-1', 100))::text as r2 \gset
select is((:'r1'::jsonb ->> 'created')::boolean, true, 'first reserve creates');
select is((:'r2'::jsonb ->> 'created')::boolean, false, 'repeat returns the existing one');
select is(:'r2'::jsonb ->> 'reservation_id', :'r1'::jsonb ->> 'reservation_id', 'same reservation id');
select is((select count(*)::int from public.credit_reservations where user_id = :'a' and request_id = 'req-1'),
  1, 'one reservation row for (A, req-1)');
select is(pg_temp.balance(:'a'), 900::bigint, 'deducted once (1000 - 100)');
select is(pg_temp.reserved(:'a'), 100::bigint, 'reserved = 100');
select is((private.reserve_credits(:'a', 'req-1', 500) ->> 'amount')::bigint, 100::bigint,
  'a repeat with another amount still returns the original reservation');
select is(pg_temp.balance(:'a'), 900::bigint, 'and does not deduct again');
select is((private.reserve_credits(:'b', 'req-1', 100) ->> 'created')::boolean, true,
  'same request_id for another user is allowed');
select is(pg_temp.balance(:'b'), 900::bigint, 'B deducted independently');
select throws_ok(
  format($q$insert into public.credit_reservations (user_id, request_id, amount, expires_at) values (%L, 'req-1', 1, now())$q$, :'a'),
  '23505', null, 'UNIQUE (user_id, request_id) on credit_reservations');

-- Case 6: settle caps at the reservation, refunds the rest, is idempotent.
select (private.settle_usage(:'a', 'req-1', 40, 'gpt-x', 'openai', 120, 80))::text as s1 \gset
select is((:'s1'::jsonb ->> 'charged')::bigint, 40::bigint, 'charged the actual 40');
select is((:'s1'::jsonb ->> 'refunded')::bigint, 60::bigint, 'refunded 60');
select is(pg_temp.balance(:'a'), 960::bigint, 'balance 1000 - 40');
select is(pg_temp.reserved(:'a'), 0::bigint, 'reserved back to 0');
select is((select status from public.credit_reservations where user_id = :'a' and request_id = 'req-1'),
  'settled', 'reservation marked settled');
select is((select credits from public.usage_events where user_id = :'a' and request_id = 'req-1'),
  40::bigint, 'usage_events row with 40 credits');
select is((select status from public.usage_events where user_id = :'a' and request_id = 'req-1'),
  'billed', 'usage_events row status billed');
select is((:'s1'::jsonb ->> 'code'), 'settled', 'settle code: settled');
select (private.settle_usage(:'a', 'req-1', 999, 'gpt-x', 'openai'))::text as s2 \gset
select is((:'s2'::jsonb ->> 'settled_now')::boolean, false, 'second settle is a no-op');
select is((:'s2'::jsonb ->> 'code'), 'already_settled', 'repeat code: already_settled');
select is((private.reserve_credits(:'a', 'req-1', 100) ->> 'created')::boolean, false,
  'reserving a settled request_id again: created false (router: 409 idempotency_conflict)');
select is((:'s2'::jsonb ->> 'charged')::bigint, 40::bigint, 'and reports the original charge');
select is(pg_temp.balance(:'a'), 960::bigint, 'balance unchanged by the repeat');
select is((select count(*)::int from public.usage_events where user_id = :'a' and request_id = 'req-1'),
  1, 'still one usage row');
select is((select count(*)::int from public.credit_transactions where user_id = :'a' and ref = 'req-1'),
  2, 'ledger: one reserve + one settle row');

select private.reserve_credits(:'a', 'req-2', 50) \gset ignore_
select (private.settle_usage(:'a', 'req-2', 75, 'gpt-x', 'openai'))::text as s3 \gset
select is((:'s3'::jsonb ->> 'charged')::bigint, 50::bigint, 'actual 75 > reserved 50 -> charged 50 (cap)');
select is((:'s3'::jsonb ->> 'refunded')::bigint, 0::bigint, 'nothing refunded');
select is(pg_temp.balance(:'a'), 910::bigint, 'balance 960 - 50, never below what was reserved');
select is((select sum(amount) from public.credit_transactions where user_id = :'a'), 910::numeric,
  'ledger sums to the balance');
select throws_ok(format($q$select private.settle_usage(%L, 'nope', 1, 'm', 'p')$q$, :'a'),
  'P0404', null, 'settling an unknown request fails');

-- Case 5: an expired reservation is refunded by the next reserve_credits.
select is(pg_temp.balance(:'b'), 900::bigint, 'B: 100 reserved (req-1)');
update public.credit_reservations set expires_at = now() - interval '1 minute'
 where user_id = :'b' and request_id = 'req-1';
select is(pg_temp.balance(:'b'), 900::bigint, 'B: still 900 before anyone notices the expiry');
select (private.reserve_credits(:'b', 'req-2', 10))::text as e1 \gset
select is((:'e1'::jsonb ->> 'balance')::bigint, 990::bigint,
  'next reserve: 100 returned first, then 10 deducted (900 + 100 - 10)');
select is((select status from public.credit_reservations where user_id = :'b' and request_id = 'req-1'),
  'expired', 'old reservation marked expired');
select is(pg_temp.reserved(:'b'), 10::bigint, 'reserved = only the new 10');
select is((select amount from public.credit_transactions where user_id = :'b' and idempotency_key = 'expire:req-1'),
  100::bigint, 'ledger refund row expire:req-1');
-- Settling an expired (already refunded) reservation does not raise and does
-- not charge: reservation_expired + a 0-credit 'unbilled' usage row, once.
select (private.settle_usage(:'b', 'req-1', 5, 'm', 'p', 10, 20))::text as x1 \gset
select is((:'x1'::jsonb ->> 'settled_now')::boolean, false, 'expired settle: settled_now false');
select is(:'x1'::jsonb ->> 'code', 'reservation_expired', 'expired settle: code reservation_expired');
select is((:'x1'::jsonb ->> 'charged')::bigint, 0::bigint, 'expired settle: charged 0');
select is(pg_temp.balance(:'b'), 990::bigint, 'expired settle: no charge');
select is(pg_temp.reserved(:'b'), 10::bigint, 'expired settle: reserved untouched');
select is((select credits from public.usage_events where user_id = :'b' and request_id = 'req-1'),
  0::bigint, 'expired settle: usage row with 0 credits');
select is((select status from public.usage_events where user_id = :'b' and request_id = 'req-1'),
  'unbilled', 'expired settle: usage row status unbilled');
select (private.settle_usage(:'b', 'req-1', 50, 'm', 'p'))::text as x2 \gset
select is(:'x2'::jsonb ->> 'code', 'reservation_expired', 'repeat expired settle: same answer');
select is((select count(*)::int from public.usage_events where user_id = :'b' and request_id = 'req-1'),
  1, 'repeat expired settle: still one usage row (UNIQUE (user_id, request_id))');
select is(pg_temp.balance(:'b'), 990::bigint, 'repeat expired settle: still no charge');
select is((private.reserve_credits(:'b', 'req-1', 100) ->> 'created')::boolean, false,
  'the expired request_id stays taken: created false (router: 409 idempotency_conflict)');
select is((private.reserve_credits(:'b', 'req-1', 7) ->> 'created')::boolean, false,
  'expired request_id with a different amount: created false');
select is(pg_temp.balance(:'b'), 990::bigint, 'and nothing deducted');
select throws_ok(
  format($q$insert into public.usage_events (user_id, request_id, model, provider, credits, status) values (%L, 'bad', 'm', 'p', 5, 'unbilled')$q$, :'b'),
  '23514', null, 'CHECK: unbilled usage rows carry 0 credits');
select throws_ok(
  format($q$insert into public.usage_events (user_id, request_id, model, provider, credits, status) values (%L, 'bad', 'm', 'p', 0, 'completed')$q$, :'b'),
  '23514', null, 'CHECK: usage status is billed / unbilled');

-- Expired but not swept yet: settle releases it itself (refund) and does
-- not charge.
select private.reserve_credits(:'b', 'late', 40) \gset ignore_
select is(pg_temp.balance(:'b'), 950::bigint, 'B: 40 reserved (late)');
update public.credit_reservations set expires_at = now() - interval '1 second'
 where user_id = :'b' and request_id = 'late';
select is(private.settle_usage(:'b', 'late', 30, 'm', 'p') ->> 'code', 'reservation_expired',
  'unswept expired settle: reservation_expired');
select is(pg_temp.balance(:'b'), 990::bigint, 'unswept expired settle: 40 refunded, 0 charged');
select is((select status from public.credit_reservations where user_id = :'b' and request_id = 'late'),
  'expired', 'unswept expired settle: reservation marked expired');
select is((select amount from public.credit_transactions where user_id = :'b' and idempotency_key = 'expire:late'),
  40::bigint, 'unswept expired settle: ledger refund row');

-- An expired reservation also lets a reserve that needed those credits pass.
select private.reserve_credits(:'b', 'big', 990) \gset ignore_
select is(pg_temp.balance(:'b'), 0::bigint, 'B: everything reserved');
update public.credit_reservations set expires_at = now() - interval '1 second'
 where user_id = :'b' and request_id = 'big';
select is((private.reserve_credits(:'b', 'after-expiry', 500) ->> 'created')::boolean, true,
  'reserve 500 succeeds because the expired 990 is released first');
select is(pg_temp.balance(:'b'), 490::bigint, 'B: 990 back, 500 out');

-- The sweep (pg_cron path) releases expired reservations of every user.
update public.credit_reservations set expires_at = now() - interval '1 second'
 where status = 'active';
select is(private.release_expired_reservations(), 2, 'sweep releases the 2 remaining active ones');
select is(pg_temp.balance(:'b'), 1000::bigint, 'B fully restored');
select is((select count(*)::int from public.credit_wallets where reserved <> 0), 0, 'nothing reserved anywhere');
select is(private.release_expired_reservations(), 0, 'a second sweep finds nothing');

select * from finish();
rollback;
