-- L1f: paid plans grant twice the monthly credits (prices unchanged, Free
-- stays 1000). Existing subscribers get the new amount at their next renewal;
-- the migration itself grants nothing and touches no wallet.
begin;
set local search_path = public, extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Catalog after all migrations
-- ---------------------------------------------------------------------------
select is((select monthly_credits from public.plans where plan = 'free'), 1000::bigint, 'free stays 1000');
select is((select monthly_credits from public.plans where plan = 'starter'), 20000::bigint, 'starter 10000 -> 20000');
select is((select monthly_credits from public.plans where plan = 'pro'), 50000::bigint, 'pro 25000 -> 50000');
select is((select monthly_credits from public.plans where plan = 'max'), 140000::bigint, 'max 70000 -> 140000');
select is((select monthly_credits from public.plans where plan = 'ultra'), 300000::bigint, 'ultra 150000 -> 300000');
select is(
  (select string_agg(plan || ':' || price_usd_cents || ':' || active, ',' order by sort_order) from public.plans),
  'free:0:true,starter:900:true,pro:2000:false,max:5000:false,ultra:10000:false',
  'USD prices and active flags unchanged');
select is(
  (select string_agg(plan || '=' || amount_minor || ':' || currency || ':' || active, ',' order by amount_minor)
     from public.plan_prices),
  'starter=4990:BRL:true,pro=10990:BRL:true,max=26990:BRL:true,ultra=53990:BRL:true',
  'BRL prices unchanged (Starter R$ 49,90)');
select is(
  (select string_agg(plan || ':' || monthly_credits || ':' || provider || ':' || amount_minor, ',')
     from public.get_billing_catalog()),
  'starter:20000:mercadopago:4990', 'catalog: Starter 20000 credits for R$ 49,90');

-- ---------------------------------------------------------------------------
-- Simulate the pre-L1f state, then apply the L1f migration again
-- ---------------------------------------------------------------------------
update public.plans p set monthly_credits = v.c
  from (values ('starter', 10000::bigint), ('pro', 25000::bigint), ('max', 70000::bigint),
               ('ultra', 150000::bigint)) as v (plan, c)
 where p.plan = v.plan;

create function pg_temp.ledger() returns text
language sql as $$
  select concat_ws('|',
    (select string_agg(user_id || ':' || balance || ':' || reserved || ':' || plan_allowance || ':'
                       || coalesce(period_end::text, '-'), ',' order by user_id) from public.credit_wallets),
    (select count(*) from public.credit_transactions),
    (select coalesce(sum(amount), 0) from public.credit_transactions))
$$;
grant execute on function pg_temp.ledger() to service_role;
create function pg_temp.line(p_price text, p_sub text, p_amount int)
returns jsonb language sql as $$
  select jsonb_build_object(
    'price', jsonb_build_object('id', p_price), 'proration', false,
    'subscription', p_sub, 'amount', p_amount,
    'period', jsonb_build_object('start', 1790000000, 'end', 1792592000))
$$;
grant execute on function pg_temp.line(text, text, int) to service_role;
create function pg_temp.invoice(p_id text, p_customer text, p_reason text, p_paid int, p_sub text,
                                p_lines jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'invoice', 'customer', p_customer, 'status', 'paid',
    'billing_reason', p_reason, 'amount_paid', p_paid, 'subscription', p_sub,
    'livemode', false, 'lines', jsonb_build_object('data', p_lines))
$$;
grant execute on function pg_temp.invoice(text, text, text, int, text, jsonb) to service_role;
create function pg_temp.balance(p_user uuid) returns bigint
language sql as $$ select balance from public.credit_wallets where user_id = p_user $$;
grant execute on function pg_temp.balance(uuid) to service_role;
create function pg_temp.allowance(p_user uuid) returns bigint
language sql as $$ select plan_allowance from public.credit_wallets where user_id = p_user $$;
grant execute on function pg_temp.allowance(uuid) to service_role;

\set starter 'price_1UMIyDKAHtqpope6RahtIgRw'
\set pro 'price_1UMIyIKAHtqpope6sw0xLZDQ'

-- S: Starter subscriber credited at the old amount. P: an existing Pro
-- subscriber (Pro is off-sale since L1a) credited at the old amount.
-- F: free user.
select tests.create_user('l1f-s@example.com', true) as s \gset
select tests.create_user('l1f-p@example.com', true) as p \gset
select tests.create_user('l1f-f@example.com', true) as f \gset
update public.profiles set stripe_customer_id = 'cus_L1F_S' where id = :'s';
update public.profiles set stripe_customer_id = 'cus_L1F_P' where id = :'p';
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values (:'s', 'sub_L1F_S', 'starter', 'active'), (:'p', 'sub_L1F_P', 'pro', 'active');

select tests.as_service_role();
select is(private.process_stripe_event('evt_l1f_s1', 'invoice.paid',
  pg_temp.invoice('in_l1f_s1', 'cus_L1F_S', 'subscription_create', 900, 'sub_L1F_S',
    jsonb_build_array(pg_temp.line(:'starter', 'sub_L1F_S', 900)))) ->> 'code',
  'credits_granted', 'pre-L1f: starter first invoice credited');
select is(private.process_stripe_event('evt_l1f_p1', 'invoice.paid',
  pg_temp.invoice('in_l1f_p1', 'cus_L1F_P', 'subscription_cycle', 2000, 'sub_L1F_P',
    jsonb_build_array(pg_temp.line(:'pro', 'sub_L1F_P', 2000)))) ->> 'code',
  'credits_granted', 'pre-L1f: existing pro renewal credited');
select tests.clear_authentication();
select is(pg_temp.balance(:'s'), 11000::bigint, 'pre-L1f: S = 1000 + 10000');
select is(pg_temp.allowance(:'s'), 10000::bigint, 'pre-L1f: S allowance 10000');
select is(pg_temp.balance(:'p'), 26000::bigint, 'pre-L1f: P = 1000 + 25000');
select is(pg_temp.allowance(:'p'), 25000::bigint, 'pre-L1f: P allowance 25000');
select is(pg_temp.balance(:'f'), 1000::bigint, 'pre-L1f: F = 1000');

select pg_temp.ledger() as before \gset
\ir ../../migrations/20261003220000_l1f_double_paid_credits.sql
select is(
  (select string_agg(plan || '=' || monthly_credits, ',' order by sort_order) from public.plans),
  'free=1000,starter=20000,pro=50000,max=140000,ultra=300000', 'migration: every paid plan doubled');
select is(pg_temp.ledger(), :'before',
  'migration: no balance, reservation, allowance, period or ledger change for existing users');
\ir ../../migrations/20261003220000_l1f_double_paid_credits.sql
select is(
  (select string_agg(plan || '=' || monthly_credits, ',' order by sort_order) from public.plans),
  'free=1000,starter=20000,pro=50000,max=140000,ultra=300000', 'migration re-run: same values (not x4)');
select is(pg_temp.ledger(), :'before', 'migration re-run: still no wallet / ledger change');

-- ---------------------------------------------------------------------------
-- Next renewal credits the new amount
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select is(private.process_stripe_event('evt_l1f_s2', 'invoice.paid',
  pg_temp.invoice('in_l1f_s2', 'cus_L1F_S', 'subscription_cycle', 900, 'sub_L1F_S',
    jsonb_build_array(pg_temp.line(:'starter', 'sub_L1F_S', 900)))) ->> 'credits',
  '20000', 'starter renewal after L1f: +20000');
select is(private.process_stripe_event('evt_l1f_p2', 'invoice.paid',
  pg_temp.invoice('in_l1f_p2', 'cus_L1F_P', 'subscription_cycle', 2000, 'sub_L1F_P',
    jsonb_build_array(pg_temp.line(:'pro', 'sub_L1F_P', 2000)))) ->> 'credits',
  '50000', 'existing (off-sale) pro renewal after L1f: +50000');
select tests.clear_authentication();
select is(pg_temp.balance(:'s'), 31000::bigint, 'S: 11000 + 20000');
select is(pg_temp.allowance(:'s'), 20000::bigint, 'S: allowance reset to 20000 at renewal');
select is(pg_temp.balance(:'p'), 76000::bigint, 'P: 26000 + 50000');
select is(pg_temp.allowance(:'p'), 50000::bigint, 'P: allowance reset to 50000 at renewal');
select is(pg_temp.balance(:'f'), 1000::bigint, 'F: free user untouched');

-- New signups still get the Free 1000.
select tests.create_user('l1f-new@example.com', true) as n \gset
select is(pg_temp.balance(:'n'), 1000::bigint, 'new signup after L1f: Free 1000');

select * from finish();
rollback;
