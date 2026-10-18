-- L5a: refund of a pack whose credits are held by an active reservation.
-- Verifies that refunded unspent credits held in flight are tracked via shortfall_owed,
-- that refunded lots are excluded from allowance calculations, lots trigger consumption,
-- and router access plans, that shortfall is collected upon reservation settlement/release
-- or free renewal, and that spent credits remain in shortfall without recovery.

begin;
set local search_path = public, extensions;
select no_plan();

\set expect '{"live_mode": false, "collector_id": "777"}'

create function pg_temp.pay(p_ref uuid, p_id text, p_status text default 'approved',
                            p_amount bigint default 3690, p_refunded bigint default 0,
                            p_live boolean default false, p_collector text default '777',
                            p_currency text default 'BRL')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'status_detail', null,
    'amount_minor', p_amount, 'refunded_minor', p_refunded, 'live_mode', p_live,
    'collector_id', p_collector, 'currency', p_currency, 'external_reference', p_ref::text)
$$;
grant execute on function pg_temp.pay(uuid, text, text, bigint, bigint, boolean, text, text) to service_role;

create function pg_temp.process(p_pay jsonb) returns text language sql as $$
  select private.process_mp_purchase_payment(p_pay, '{"live_mode": false, "collector_id": "777"}', null) ->> 'code'
$$;
grant execute on function pg_temp.process(jsonb) to service_role;

create function pg_temp.buy(p_user uuid, p_pack text) returns uuid language sql as $$
  select (private.mp_create_purchase(p_user, p_pack) ->> 'purchase_id')::uuid
$$;
grant execute on function pg_temp.buy(uuid, text) to service_role;

-- balance+reserved | lots remaining (oldest first)
create function pg_temp.state(p_user uuid) returns text language sql as $$
  select (select balance || '+' || reserved from public.credit_wallets where user_id = p_user) || '|'
      || coalesce((select string_agg(remaining::text, ',' order by created_at, id)
                     from public.credit_lots where user_id = p_user), '')
$$;
grant execute on function pg_temp.state(uuid) to service_role;

create function pg_temp.signed_up(p_user uuid, p_ago interval) returns void language sql as $$
  update public.credit_transactions set created_at = now() - p_ago
   where user_id = p_user and idempotency_key = 'free-initial:' || p_user::text
$$;

create function pg_temp.user_at(p_id uuid, p_email text) returns uuid language sql as $$
  insert into auth.users (id, email, email_confirmed_at) values (p_id, p_email, now()) returning id
$$;

create function pg_temp.owed(p_user uuid) returns bigint language sql as $$
  select shortfall_owed from public.credit_wallets where user_id = p_user
$$;
grant execute on function pg_temp.owed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Schema checks
-- ---------------------------------------------------------------------------
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
            where oid = 'private.collect_shortfall(uuid, text, text, bigint)'::regprocedure),
  'private.collect_shortfall: SECURITY DEFINER, search_path=""');

select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated'), ('service_role')) r (role)
    where has_function_privilege(r.role, 'private.collect_shortfall(uuid, text, text, bigint)', 'execute')),
  0, 'private.collect_shortfall: no anon / authenticated / service_role execute');

select ok(has_table_privilege('service_role', 'private.open_credit_shortfalls', 'select')
      and not has_table_privilege('anon', 'private.open_credit_shortfalls', 'select')
      and not has_table_privilege('authenticated', 'private.open_credit_shortfalls', 'select'),
  'private.open_credit_shortfalls: service_role can select; anon and authenticated cannot');



-- ---------------------------------------------------------------------------
-- User A (full refund with an active reservation)
-- ---------------------------------------------------------------------------
select pg_temp.user_at('00000000-0000-4000-8000-0000000000a1', 'a21@test.dev') as a \gset
select is(pg_temp.state(:'a'), '1000+0|', 'User A initial state: 1000+0|');
select throws_ok(format('update public.credit_wallets set shortfall_owed = -1 where user_id = %L', :'a'),
  '23514', null, 'shortfall_owed can never be negative (check constraint)');

-- 1. buy credits_5k (p1), process pay(p1,'7101') -> 'credited'; state '6000+0|5000'; purchase_access_plan(a) = 'starter'
select tests.as_service_role();
select pg_temp.buy(:'a', 'credits_5k') as p1 \gset
select is(pg_temp.process(pg_temp.pay(:'p1', '7101')), 'credited', 'A: buy credits_5k payment 7101 credited');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '6000+0|5000', 'A: state 6000+0|5000');
select tests.as_service_role();
select is(private.purchase_access_plan(:'a'), 'starter', 'A: purchase_access_plan is starter');
select tests.clear_authentication();

-- 2. reserve_credits(a, 'a-r1', 5800) created; state '200+5800|5000'
select tests.as_service_role();
select is((private.reserve_credits(:'a', 'a-r1', 5800) ->> 'created')::boolean, true, 'A: reserve_credits a-r1 created');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '200+5800|5000', 'A: state 200+5800|5000');

-- 3. process pay(p1,'7101','refunded',3690,3690) -> 'reversed'; state '0+5800|0';
-- lot (payment_id 7101) reversed_credits||':'||shortfall||':'||status||':'||remaining = '5000:4800:refunded:0';
-- owed(a) = 4800 (only the part stuck in the reservation); purchase_access_plan(a) is null;
-- non_purchased_credits(a) = 5800; redelivering the same refund -> 'already_credited' and owed still 4800
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p1', '7101', 'refunded', 3690, 3690)), 'reversed', 'A: refund reversed');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '0+5800|0', 'A: state 0+5800|0');
select is((select reversed_credits || ':' || shortfall || ':' || status || ':' || remaining
             from public.credit_lots where payment_id = 7101),
  '5000:4800:refunded:0', 'A: lot 7101 reversed_credits:shortfall:status:remaining is 5000:4800:refunded:0');
select is(pg_temp.owed(:'a'), 4800::bigint, 'A: owed is 4800 (only the part stuck in reservation)');
select tests.as_service_role();
select is(private.purchase_access_plan(:'a'), null, 'A: purchase_access_plan is null');
select tests.clear_authentication();
select is((select private.non_purchased_credits(:'a')), 5800::bigint, 'A: non_purchased_credits is 5800');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p1', '7101', 'refunded', 3690, 3690)), 'already_credited',
  'A: redelivering the same refund is already_credited');
select tests.clear_authentication();
select is(pg_temp.owed(:'a'), 4800::bigint, 'A: owed still 4800 after redelivery');

-- 4. settle_usage(a,'a-r1',5000,'m','p') (lives_ok, no credited lot left) -> charged 5000,
-- 'shortfall_collected' 800, 'balance' 0; state '0+0|0'; owed 4000;
-- ledger row idempotency_key 'shortfall:a-r1' amount -800; settle again -> code 'already_settled', owed still 4000
select tests.as_service_role();
select private.settle_usage(:'a', 'a-r1', 5000, 'm', 'p') as s1 \gset
select is((:'s1'::jsonb ->> 'code'), 'settled', 'A: closing the request with no credited lot left settles without error');
select is((:'s1'::jsonb ->> 'charged')::bigint, 5000::bigint, 'A: charged 5000');
select is((:'s1'::jsonb ->> 'shortfall_collected')::bigint, 800::bigint, 'A: shortfall_collected 800');
select is((:'s1'::jsonb ->> 'balance')::bigint, 0::bigint, 'A: balance 0');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '0+0|0', 'A: state 0+0|0');
select is(pg_temp.owed(:'a'), 4000::bigint, 'A: owed 4000');
select is((select amount from public.credit_transactions
            where user_id = :'a' and idempotency_key = 'shortfall:a-r1'),
  (-800)::bigint, 'A: ledger row idempotency_key shortfall:a-r1 amount -800');
select tests.as_service_role();
select is(private.settle_usage(:'a', 'a-r1', 5000, 'm', 'p') ->> 'code', 'already_settled',
  'A: settle again returns code already_settled');
select lives_ok(format($$select private.settle_usage(%L, 'a-r1', 5000, 'm', 'p')$$, :'a'),
  'A: settle_usage repeat lives_ok');
select tests.clear_authentication();
select is(pg_temp.owed(:'a'), 4000::bigint, 'A: owed still 4000 after settle again');

-- 5. The exploit is closed: the wallet balance is 0 — the 4800 refunded credits that were reserved
-- are not available (assert balance = 0 and that non_purchased_credits(a) = 0).
-- Also assert no wallet in the test has balance < 0 or shortfall_owed < 0.
select is((select balance from public.credit_wallets where user_id = :'a'), 0::bigint,
  'A: exploit closed: wallet balance is 0');
select is((select private.non_purchased_credits(:'a')), 0::bigint,
  'A: exploit closed: non_purchased_credits is 0');
select is((select count(*)::int from public.credit_wallets where balance < 0 or shortfall_owed < 0), 0,
  'no wallet in the test has balance < 0 or shortfall_owed < 0');

-- 6. Free renewal: pg_temp.signed_up(a, '40 days'); update credit_wallets set period_end = null where user_id = a;
-- renew_free_credits_for_user(a) -> code 'renewed', amount 1000, shortfall_collected 1000;
-- state '0+0|0'; owed 3000; ledger has a free-renewal +1000 row and a 'free-renewal-shortfall:%' adjust row of -1000.
select pg_temp.signed_up(:'a', '40 days');
update public.credit_wallets set period_end = null where user_id = :'a';
select tests.as_service_role();
select private.renew_free_credits_for_user(:'a') as r1 \gset
select is((:'r1'::jsonb ->> 'code'), 'renewed', 'A: renew_free_credits_for_user code is renewed');
select is((:'r1'::jsonb ->> 'amount')::bigint, 1000::bigint, 'A: renew_free_credits_for_user amount is 1000');
select is((:'r1'::jsonb ->> 'shortfall_collected')::bigint, 1000::bigint,
  'A: renew_free_credits_for_user shortfall_collected is 1000');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '0+0|0', 'A: state 0+0|0');
select is(pg_temp.owed(:'a'), 3000::bigint, 'A: owed is 3000');
select is((select amount from public.credit_transactions
            where user_id = :'a' and idempotency_key like 'free-renewal:%' and kind = 'renewal'),
  1000::bigint, 'A: ledger has free-renewal +1000 row');
select is((select amount from public.credit_transactions
            where user_id = :'a' and idempotency_key like 'free-renewal-shortfall:%' and kind = 'adjust'),
  (-1000)::bigint, 'A: ledger has free-renewal-shortfall adjust -1000 row');

-- 7. Renewal is idempotent: set period_end = null again; renew -> code 'already_renewed',
-- shortfall_collected 0; state '0+0|0'; owed 3000; exactly one 'free-renewal-shortfall:%' row.
update public.credit_wallets set period_end = null where user_id = :'a';
select tests.as_service_role();
select private.renew_free_credits_for_user(:'a') as r2 \gset
select is((:'r2'::jsonb ->> 'code'), 'already_renewed', 'A: repeat renewal code is already_renewed');
select is((:'r2'::jsonb ->> 'shortfall_collected')::bigint, 0::bigint,
  'A: repeat renewal shortfall_collected is 0');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '0+0|0', 'A: state 0+0|0');
select is(pg_temp.owed(:'a'), 3000::bigint, 'A: owed still 3000');
select is((select count(*)::int from public.credit_transactions
            where user_id = :'a' and idempotency_key like 'free-renewal-shortfall:%'),
  1, 'A: exactly one free-renewal-shortfall row');

-- 8. New pack: buy credits_5k (p2), process pay(p2,'7102') -> 'credited'; state '5000+0|0,5000'
-- (back-date the first lot's created_at by 1 hour first so the order is stable, as file 18 does);
-- purchase_access_plan(a) = 'starter'.
update public.credit_lots set created_at = now() - interval '1 hour' where user_id = :'a';
select tests.as_service_role();
select pg_temp.buy(:'a', 'credits_5k') as p2 \gset
select is(pg_temp.process(pg_temp.pay(:'p2', '7102')), 'credited', 'A: new pack payment 7102 credited');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '5000+0|0,5000', 'A: state 5000+0|0,5000');
select tests.as_service_role();
select is(private.purchase_access_plan(:'a'), 'starter', 'A: purchase_access_plan is starter');
select tests.clear_authentication();

-- 9. Expired reservation release also collects: reserve_credits(a,'a-r2',1000);
-- update public.credit_reservations set expires_at = now() - interval '1 minute' where request_id = 'a-r2';
-- release_expired_reservations(a) = 1; owed 2000; state '4000+0|0,4000'
-- (the refunded lot is never consumed; the new credited lot is).
select tests.as_service_role();
select is((private.reserve_credits(:'a', 'a-r2', 1000) ->> 'created')::boolean, true, 'A: reserve a-r2 1000 created');
select tests.clear_authentication();
update public.credit_reservations set expires_at = now() - interval '1 minute' where request_id = 'a-r2';
select tests.as_service_role();
select is(private.release_expired_reservations(:'a'), 1, 'A: release_expired_reservations returns 1');
select tests.clear_authentication();
select is(pg_temp.owed(:'a'), 2000::bigint, 'A: owed is 2000');
select is(pg_temp.state(:'a'), '4000+0|0,4000',
  'A: state 4000+0|0,4000 (refunded lot never consumed; new credited lot is)');

-- ---------------------------------------------------------------------------
-- User B (partial refund with an active reservation; consumption order)
-- ---------------------------------------------------------------------------
select pg_temp.user_at('00000000-0000-4000-8000-0000000000b1', 'b21@test.dev') as b \gset

-- 1. buy credits_5k (p3), pay(p3,'7201') credited; reserve 'b-r1' 5800; state '200+5800|5000'
select tests.as_service_role();
select pg_temp.buy(:'b', 'credits_5k') as p3 \gset
select is(pg_temp.process(pg_temp.pay(:'p3', '7201')), 'credited', 'B: buy credits_5k payment 7201 credited');
select is((private.reserve_credits(:'b', 'b-r1', 5800) ->> 'created')::boolean, true, 'B: reserve b-r1 5800 created');
select tests.clear_authentication();
select is(pg_temp.state(:'b'), '200+5800|5000', 'B: state 200+5800|5000');

-- 2. partial refund 50%: pay(p3,'7201', p_amount => 3690, p_refunded => 1845) -> 'reversed';
-- lot '2500:2300:credited:2500'; state '0+5800|2500'; owed 2300;
-- non_purchased_credits(b) = 3300; purchase_access_plan(b) = 'starter'
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p3', '7201', p_amount => 3690, p_refunded => 1845)), 'reversed',
  'B: partial refund (50%) reversed');
select tests.clear_authentication();
select is((select reversed_credits || ':' || shortfall || ':' || status || ':' || remaining
             from public.credit_lots where payment_id = 7201),
  '2500:2300:credited:2500', 'B: lot 7201 reversed_credits:shortfall:status:remaining is 2500:2300:credited:2500');
select is(pg_temp.state(:'b'), '0+5800|2500', 'B: state 0+5800|2500');
select is(pg_temp.owed(:'b'), 2300::bigint, 'B: owed is 2300');
select is((select private.non_purchased_credits(:'b')), 3300::bigint, 'B: non_purchased_credits is 3300');
select tests.as_service_role();
select is(private.purchase_access_plan(:'b'), 'starter', 'B: purchase_access_plan is starter');
select tests.clear_authentication();

-- 3. settle_usage(b,'b-r1',300,'m','p'): shortfall_collected 2300; state '3200+0|2500';
-- owed 0; non_purchased_credits(b) = 700 (1000 allowance - 300 spent)
select tests.as_service_role();
select private.settle_usage(:'b', 'b-r1', 300, 'm', 'p') as sb1 \gset
select is((:'sb1'::jsonb ->> 'shortfall_collected')::bigint, 2300::bigint, 'B: shortfall_collected is 2300');
select tests.clear_authentication();
select is(pg_temp.state(:'b'), '3200+0|2500', 'B: state 3200+0|2500');
select is(pg_temp.owed(:'b'), 0::bigint, 'B: owed is 0');
select is((select private.non_purchased_credits(:'b')), 700::bigint,
  'B: non_purchased_credits is 700 (1000 allowance - 300 spent)');

-- 4. reserve 'b-r2' 1000 and settle 1000: state '2200+0|2200'
-- (the 700 allowance goes first, then 300 from the lot); owed stays 0 (never negative)
select tests.as_service_role();
select is((private.reserve_credits(:'b', 'b-r2', 1000) ->> 'created')::boolean, true, 'B: reserve b-r2 1000 created');
select is((private.settle_usage(:'b', 'b-r2', 1000, 'm', 'p') ->> 'code'), 'settled', 'B: settle b-r2 1000 settled');
select tests.clear_authentication();
select is(pg_temp.state(:'b'), '2200+0|2200',
  'B: state 2200+0|2200 (700 allowance goes first, then 300 from lot)');
select is(pg_temp.owed(:'b'), 0::bigint, 'B: owed stays 0 (never negative)');
select is((select count(*)::int from public.credit_wallets where balance < 0 or shortfall_owed < 0), 0,
  'end: no wallet has balance < 0 or shortfall_owed < 0');

select * from finish();
rollback;
