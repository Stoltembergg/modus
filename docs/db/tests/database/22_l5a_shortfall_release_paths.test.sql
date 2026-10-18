-- L5a: shortfall collection on reservation release paths.
-- Verifies that shortfall_owed is collected when an expired reservation carrying
-- a stored router cost is settled during the sweep (User R), and when an expired
-- reservation is released directly by settle_usage without a stored cost (User E).

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

create function pg_temp.user_at(p_id uuid, p_email text) returns uuid language sql as $$
  insert into auth.users (id, email, email_confirmed_at) values (p_id, p_email, now()) returning id
$$;

create function pg_temp.owed(p_user uuid) returns bigint language sql as $$
  select shortfall_owed from public.credit_wallets where user_id = p_user
$$;
grant execute on function pg_temp.owed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- User R (saved router cost, collected in release_expired_reservations' stored-cost branch)
-- ---------------------------------------------------------------------------
select pg_temp.user_at('00000000-0000-4000-8000-0000000000c1', 'r22@test.dev') as r \gset

select tests.as_service_role();
select pg_temp.buy(:'r', 'credits_5k') as pr \gset
select is(pg_temp.process(pg_temp.pay(:'pr', '7301')), 'credited', 'R: buy credits_5k payment 7301 credited');
select tests.clear_authentication();
select is(pg_temp.state(:'r'), '6000+0|5000', 'R: state 6000+0|5000');

select tests.as_service_role();
select is((private.router_claim_request(:'r', 'rk-1', repeat('a', 64)) ->> 'code'), 'claimed',
  'R: router_claim_request rk-1 claimed');
select is((private.reserve_credits(:'r', 'rk-1', 5800) ->> 'created')::boolean, true,
  'R: reserve_credits rk-1 created');
select tests.clear_authentication();
select is(pg_temp.state(:'r'), '200+5800|5000', 'R: state 200+5800|5000');

select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'pr', '7301', 'refunded', 3690, 3690)), 'reversed', 'R: refund reversed');
select tests.clear_authentication();
select is(pg_temp.state(:'r'), '0+5800|0', 'R: state 0+5800|0');
select is(pg_temp.owed(:'r'), 4800::bigint, 'R: owed is 4800');

select tests.as_service_role();
select is(private.router_store_cost(:'r', 'rk-1', 500, 'm', 'p'), true, 'R: router_store_cost is true');
select tests.clear_authentication();

update public.credit_reservations set expires_at = now() - interval '1 minute'
 where user_id = :'r' and request_id = 'rk-1';

select tests.as_service_role();
select is(private.release_expired_reservations(:'r'), 1, 'R: release_expired_reservations returns 1');
select tests.clear_authentication();

select is((select status || ':' || settled_amount from public.credit_reservations
            where user_id = :'r' and request_id = 'rk-1'),
  'settled:500', 'R: reservation status:settled_amount is settled:500');
select is((select status || ':' || credits from public.usage_events
            where user_id = :'r' and request_id = 'rk-1'),
  'billed:500', 'R: usage_events status:credits is billed:500');
select is(pg_temp.state(:'r'), '500+0|0',
  'R: state 500+0|0 (5300 returned, 4800 collected; 1000 allowance - 500 spent)');
select is(pg_temp.owed(:'r'), 0::bigint, 'R: owed is 0');
select is((select amount from public.credit_transactions
            where user_id = :'r' and idempotency_key = 'shortfall:rk-1'),
  (-4800)::bigint, 'R: ledger shortfall:rk-1 is -4800');
select is((select amount from public.credit_transactions
            where user_id = :'r' and idempotency_key = 'settle:rk-1'),
  5300::bigint, 'R: ledger settle:rk-1 is 5300');

select tests.as_service_role();
select is(private.release_expired_reservations(:'r'), 0, 'R: repeat release_expired_reservations returns 0');
select tests.clear_authentication();
select is(pg_temp.owed(:'r'), 0::bigint, 'R: owed still 0 after repeat release');

-- ---------------------------------------------------------------------------
-- User E (reservation expired before the sweep; settle_usage releases it itself)
-- ---------------------------------------------------------------------------
select pg_temp.user_at('00000000-0000-4000-8000-0000000000c2', 'e22@test.dev') as e \gset

select tests.as_service_role();
select pg_temp.buy(:'e', 'credits_5k') as pe \gset
select is(pg_temp.process(pg_temp.pay(:'pe', '7302')), 'credited', 'E: buy credits_5k payment 7302 credited');
select is((private.reserve_credits(:'e', 'ex-1', 5800) ->> 'created')::boolean, true,
  'E: reserve ex-1 5800 created');
select is(pg_temp.process(pg_temp.pay(:'pe', '7302', 'refunded', 3690, 3690)), 'reversed', 'E: refund reversed');
select tests.clear_authentication();

select is(pg_temp.owed(:'e'), 4800::bigint, 'E: owed is 4800');
select is(pg_temp.state(:'e'), '0+5800|0', 'E: state 0+5800|0');

update public.credit_reservations set expires_at = now() - interval '1 minute'
 where user_id = :'e' and request_id = 'ex-1';

select tests.as_service_role();
select private.settle_usage(:'e', 'ex-1', 300, 'm', 'p') as se \gset
select is((:'se'::jsonb ->> 'code'), 'reservation_expired', 'E: code is reservation_expired');
select is((:'se'::jsonb ->> 'charged')::bigint, 0::bigint, 'E: charged 0');
select is((:'se'::jsonb ->> 'balance')::bigint, 1000::bigint, 'E: balance 1000');
select tests.clear_authentication();

select is(pg_temp.state(:'e'), '1000+0|0', 'E: state 1000+0|0');
select is(pg_temp.owed(:'e'), 0::bigint, 'E: owed is 0');
select is((select amount from public.credit_transactions
            where user_id = :'e' and idempotency_key = 'expire:ex-1'),
  5800::bigint, 'E: ledger expire:ex-1 is 5800');
select is((select amount from public.credit_transactions
            where user_id = :'e' and idempotency_key = 'shortfall:ex-1'),
  (-4800)::bigint, 'E: ledger shortfall:ex-1 is -4800');
select is((select status from public.usage_events
            where user_id = :'e' and request_id = 'ex-1'),
  'unbilled', 'E: usage_events status for ex-1 is unbilled');

select tests.as_service_role();
select is(private.settle_usage(:'e', 'ex-1', 300, 'm', 'p') ->> 'code', 'reservation_expired',
  'E: repeat settle returns reservation_expired');
select tests.clear_authentication();
select is(pg_temp.owed(:'e'), 0::bigint, 'E: owed still 0 after repeat settle');
select is(pg_temp.state(:'e'), '1000+0|0', 'E: state unchanged 1000+0|0');

-- ---------------------------------------------------------------------------
-- Invariant check
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.credit_wallets where balance < 0 or shortfall_owed < 0), 0,
  'end: no wallet has balance < 0 or shortfall_owed < 0');

select * from finish();
rollback;
