-- B1 / A14: a partially-refunded approved payment can be the first webhook
-- delivery. The full grant and proportional reversal must commit atomically.
begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.pay(p_ref uuid, p_id text, p_status text default 'approved',
                            p_amount bigint default 7290, p_refunded bigint default 0,
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

create function pg_temp.state(p_user uuid) returns text language sql as $$
  select (select balance || '+' || reserved from public.credit_wallets where user_id = p_user) || '|'
      || coalesce((select string_agg(remaining::text, ',' order by created_at, id)
                     from public.credit_lots where user_id = p_user), '')
$$;
grant execute on function pg_temp.state(uuid) to service_role;

select tests.create_user('first-refund@example.com', true) as u \gset
select tests.as_service_role();
select pg_temp.buy(:'u', 'credits_10k') as purchase \gset

select is(pg_temp.process(pg_temp.pay(:'purchase', '810001', p_refunded => 3645)), 'reversed',
  'first approved delivery with a 50% refund grants and reverses in one transaction');
select tests.clear_authentication();
select is(pg_temp.state(:'u'), '6000+0|5000', 'only the net 5,000 purchased credits remain');
select is((select credits_granted || ':' || reversed_credits || ':' || remaining || ':' || status
             from public.credit_lots where payment_id = 810001),
  '10000:5000:5000:credited', 'lot records the original grant and proportional reversal');
select is((select coalesce(sum(amount), 0)::bigint from public.credit_transactions
            where user_id = :'u' and idempotency_key in
              ('mp:purchase-payment:810001', 'mp:purchase-reversal:810001:5000')),
  5000::bigint, 'ledger net equals the surviving lot');

select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'purchase', '810001', p_refunded => 3645)), 'already_credited',
  'redelivery does not grant or reverse a second time');
select tests.clear_authentication();
select is(pg_temp.state(:'u'), '6000+0|5000', 'redelivery leaves wallet and lot unchanged');

select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'purchase', '810001', p_refunded => 5468)), 'reversed',
  'a later cumulative refund applies only the incremental reversal');
select tests.clear_authentication();
select is(pg_temp.state(:'u'), '3500+0|2500', '75% cumulative refund leaves 2,500 credits');
select is((select reversed_credits || ':' || remaining from public.credit_lots where payment_id = 810001),
  '7500:2500', 'cumulative integer target is tracked once');

select tests.create_user('first-refund-rounding@example.com', true) as rounded \gset
select tests.as_service_role();
select pg_temp.buy(:'rounded', 'credits_5k') as rounded_purchase \gset
select is(pg_temp.process(pg_temp.pay(:'rounded_purchase', '810002', p_amount => 3690,
                                            p_refunded => 1)), 'reversed',
  'proportional refunds use integer floor rounding');
select tests.clear_authentication();
select is(pg_temp.state(:'rounded'), '5999+0|4999', 'one minor unit reverses exactly one credit');

select tests.create_user('first-refund-never-credited@example.com', true) as unpaid \gset
select tests.as_service_role();
select pg_temp.buy(:'unpaid', 'credits_5k') as full_refund_purchase \gset
select pg_temp.buy(:'unpaid', 'credits_5k') as chargeback_purchase \gset
select is(pg_temp.process(pg_temp.pay(:'full_refund_purchase', '810003', 'refunded', 3690, 3690)),
  'pending', 'a first full-refund event never releases credits');
select is(pg_temp.process(pg_temp.pay(:'chargeback_purchase', '810004', 'charged_back', 3690, 3690)),
  'pending', 'a first chargeback event never releases credits');
select tests.clear_authentication();
select is(pg_temp.state(:'unpaid'), '1000+0|', 'full refund and chargeback leave no lots or added balance');
select is((select count(*)::int from public.credit_lots
            where purchase_id in (:'full_refund_purchase', :'chargeback_purchase')), 0,
  'non-approved first deliveries create no lots');

select * from finish();
rollback;
