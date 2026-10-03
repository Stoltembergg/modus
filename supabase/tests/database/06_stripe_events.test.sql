-- Debbie review point 8: private.process_stripe_event. User only from
-- profiles.stripe_customer_id, plan only from plans.stripe_price_id, never
-- metadata; livemode must be false; one transaction (errors leave nothing
-- behind); repeated event_id is a no-op; credits once per invoice.
begin;
set local search_path = public, extensions;
select no_plan();

select tests.create_user('a@example.com', true) as a \gset
select tests.create_user('b@example.com', true) as b \gset
update public.profiles set stripe_customer_id = 'cus_A' where id = :'a';
update public.profiles set stripe_customer_id = 'cus_B' where id = :'b';

create function pg_temp.balance(p_user uuid) returns bigint
language sql as $$ select balance from public.credit_wallets where user_id = p_user $$;
grant execute on function pg_temp.balance(uuid) to service_role;
create function pg_temp.snapshot() returns text
language sql as $$
  select concat_ws('|',
    (select string_agg(user_id || ':' || balance || ':' || plan_allowance, ',' order by user_id) from public.credit_wallets),
    (select count(*) from public.credit_transactions),
    (select string_agg(stripe_subscription_id || ':' || user_id || ':' || plan || ':' || status, ',' order by stripe_subscription_id) from public.subscriptions),
    (select string_agg(event_id || ':' || status, ',' order by event_id) from public.stripe_events))
$$;
grant execute on function pg_temp.snapshot() to service_role;

create function pg_temp.invoice(p_id text, p_customer text, p_price text, p_livemode boolean default false,
                                p_metadata jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'invoice', 'customer', p_customer, 'status', 'paid',
    'livemode', p_livemode, 'metadata', p_metadata,
    'lines', jsonb_build_object('data', jsonb_build_array(jsonb_build_object(
      'price', jsonb_build_object('id', p_price),
      'period', jsonb_build_object('start', 1790000000, 'end', 1792592000)))))
$$;
grant execute on function pg_temp.invoice(text, text, text, boolean, jsonb) to service_role;
create function pg_temp.sub(p_id text, p_customer text, p_price text, p_status text default 'active',
                            p_metadata jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'subscription', 'customer', p_customer, 'status', p_status,
    'livemode', false, 'cancel_at_period_end', false, 'metadata', p_metadata,
    'items', jsonb_build_object('data', jsonb_build_array(jsonb_build_object(
      'price', jsonb_build_object('id', p_price),
      'current_period_start', 1790000000, 'current_period_end', 1792592000))))
$$;
grant execute on function pg_temp.sub(text, text, text, text, jsonb) to service_role;

\set starter 'price_1UMISRDuKWPSLmWmyVh3aXHh'
\set pro 'price_1UMISdDuKWPSLmWmJZqqbZiV'

select tests.as_service_role();
select is(pg_temp.balance(:'a'), 1000::bigint, 'A starts with the free 1000');

-- invoice.paid: credits from the plan, keyed 'invoice:<id>'.
select (private.process_stripe_event('evt_inv1', 'invoice.paid',
  pg_temp.invoice('in_1', 'cus_A', :'starter')))::text as r1 \gset
select is((:'r1'::jsonb ->> 'processed')::boolean, true, 'invoice.paid processed');
select is(:'r1'::jsonb ->> 'code', 'credits_granted', 'invoice.paid: credits_granted');
select is(pg_temp.balance(:'a'), 11000::bigint, 'A +10000 (starter monthly_credits)');
select is((select kind from public.credit_transactions where user_id = :'a' and idempotency_key = 'invoice:in_1'),
  'renewal', 'ledger row invoice:in_1 (renewal)');
select is((select plan_allowance from public.credit_wallets where user_id = :'a'), 10000::bigint,
  'wallet plan_allowance = 10000');
select is((select period_end from public.credit_wallets where user_id = :'a'), to_timestamp(1792592000),
  'wallet period_end from the invoice line');
select is((select status || ':' || type || ':' || result from public.stripe_events where event_id = 'evt_inv1'),
  'processed:invoice.paid:credits_granted', 'stripe_events row processed');
select ok((select processed_at is not null from public.stripe_events where event_id = 'evt_inv1'),
  'processed_at set');

-- Repeated event_id: no-op.
select (private.process_stripe_event('evt_inv1', 'invoice.paid',
  pg_temp.invoice('in_1', 'cus_A', :'starter')))::text as r2 \gset
select is(:'r2'::jsonb, '{"processed": false, "code": "duplicate", "event_id": "evt_inv1"}'::jsonb,
  'repeated event_id -> {processed:false, code:duplicate}');
select is(pg_temp.balance(:'a'), 11000::bigint, 'repeated event: balance unchanged');
-- Another event for the same invoice: processed, but no second grant.
select is(private.process_stripe_event('evt_inv1_retry', 'invoice.paid',
  pg_temp.invoice('in_1', 'cus_A', :'starter')) ->> 'code', 'already_granted',
  'new event_id for the same invoice: already_granted');
select is(pg_temp.balance(:'a'), 11000::bigint, 'same invoice: still granted once');

-- Newer API shape: price under pricing.price_details.price.
select is(private.process_stripe_event('evt_inv_new', 'invoice.paid', jsonb_build_object(
  'id', 'in_new', 'object', 'invoice', 'customer', 'cus_B', 'status', 'paid', 'livemode', false,
  'lines', jsonb_build_object('data', jsonb_build_array(jsonb_build_object(
    'pricing', jsonb_build_object('price_details', jsonb_build_object('price', :'pro'))))))) ->> 'code',
  'credits_granted', 'invoice with pricing.price_details.price is understood');
select is(pg_temp.balance(:'b'), 26000::bigint, 'B +25000 (pro)');

-- Metadata is never read: metadata naming B does not move A's invoice to B.
select private.process_stripe_event('evt_inv_meta', 'invoice.paid',
  pg_temp.invoice('in_meta', 'cus_A', :'starter', false,
    jsonb_build_object('supabase_user_id', :'b', 'plan', 'ultra'))) \gset ignore_
select is(pg_temp.balance(:'a'), 21000::bigint, 'metadata ignored: A (customer owner) credited');
select is(pg_temp.balance(:'b'), 26000::bigint, 'metadata ignored: B untouched');

-- Unknown price: raises, nothing written (not even stripe_events).
select pg_temp.snapshot() as before \gset
select throws_ok($q$select private.process_stripe_event('evt_badprice', 'invoice.paid',
  pg_temp.invoice('in_bad', 'cus_A', 'price_unknown'))$q$, 'P0404', 'unknown stripe price',
  'unknown price -> error');
select throws_ok($q$select private.process_stripe_event('evt_badprice_sub', 'customer.subscription.created',
  pg_temp.sub('sub_bad', 'cus_A', 'price_unknown'))$q$, 'P0404', 'unknown stripe price',
  'unknown price on a subscription -> error');
select is(pg_temp.snapshot(), :'before', 'unknown price: nothing changed');
select is((select count(*)::int from public.stripe_events where event_id like 'evt_badprice%'), 0,
  'unknown price: event not recorded as processed (rolled back)');

-- Customer without an owner: raises, nothing written.
select throws_ok($q$select private.process_stripe_event('evt_nocus', 'invoice.paid',
  pg_temp.invoice('in_nocus', 'cus_nobody', 'price_1UMISRDuKWPSLmWmyVh3aXHh'))$q$, 'P0404',
  'unknown stripe customer', 'customer with no owner -> error');
select throws_ok($q$select private.process_stripe_event('evt_nocus2', 'customer.subscription.updated',
  pg_temp.sub('sub_x', 'cus_nobody', 'price_1UMISRDuKWPSLmWmyVh3aXHh'))$q$, 'P0404',
  'unknown stripe customer', 'subscription for a customer with no owner -> error');
select throws_ok($q$select private.process_stripe_event('evt_nocus3', 'invoice.paid',
  pg_temp.invoice('in_nocus3', null, 'price_1UMISRDuKWPSLmWmyVh3aXHh'))$q$, '22023', null,
  'object without customer -> error');
select is(pg_temp.snapshot(), :'before', 'unknown customer: nothing changed');

-- livemode must be false.
select throws_ok($q$select private.process_stripe_event('evt_live', 'invoice.paid',
  pg_temp.invoice('in_live', 'cus_A', 'price_1UMISRDuKWPSLmWmyVh3aXHh', true))$q$, '22023', null,
  'livemode true rejected');
select throws_ok($q$select private.process_stripe_event('evt_live2', 'charge.succeeded', '{"object": "charge"}')$q$,
  '22023', null, 'missing livemode rejected (must be exactly false)');
select is(pg_temp.snapshot(), :'before', 'livemode: nothing changed');

-- Subscriptions: upsert from the subscription object.
select is(private.process_stripe_event('evt_sub1', 'customer.subscription.created',
  pg_temp.sub('sub_A', 'cus_A', :'starter')) ->> 'code', 'subscription_upserted',
  'subscription.created upserts');
select is((select user_id || ':' || plan || ':' || status from public.subscriptions where stripe_subscription_id = 'sub_A'),
  :'a' || ':starter:active', 'subscriptions row: A, starter, active');
select is((select current_period_end from public.subscriptions where stripe_subscription_id = 'sub_A'),
  to_timestamp(1792592000), 'period end from items.data[0]');
select private.process_stripe_event('evt_sub2', 'customer.subscription.updated',
  pg_temp.sub('sub_A', 'cus_A', :'pro', 'active', jsonb_build_object('plan', 'ultra'))) \gset ignore_
select is((select plan from public.subscriptions where stripe_subscription_id = 'sub_A'), 'pro',
  'subscription.updated: plan from the price (pro), metadata plan ignored');
select private.process_stripe_event('evt_sub3', 'customer.subscription.deleted',
  pg_temp.sub('sub_A', 'cus_A', :'pro', 'canceled')) \gset ignore_
select is((select status from public.subscriptions where stripe_subscription_id = 'sub_A'), 'canceled',
  'subscription.deleted: status canceled');
select is((select count(*)::int from public.subscriptions where stripe_subscription_id = 'sub_A'), 1,
  'still one row for sub_A');
select is(pg_temp.balance(:'a'), 21000::bigint, 'subscription events grant no credits');

-- A subscription owned by A cannot be moved to B by an event for cus_B.
select pg_temp.snapshot() as before2 \gset
select throws_ok($q$select private.process_stripe_event('evt_steal', 'customer.subscription.updated',
  pg_temp.sub('sub_A', 'cus_B', 'price_1UMISdDuKWPSLmWmJZqqbZiV'))$q$, 'P0403', null,
  'subscription of A with customer of B -> error');
select is(pg_temp.snapshot(), :'before2', 'steal attempt: nothing changed');

-- Wrong object type for the event.
select throws_ok($q$select private.process_stripe_event('evt_wrongobj', 'invoice.paid',
  pg_temp.sub('sub_A', 'cus_A', 'price_1UMISdDuKWPSLmWmJZqqbZiV'))$q$, '22023', null,
  'invoice.paid with a subscription object -> error');

-- Unsupported types are recorded and ignored.
select is(private.process_stripe_event('evt_other', 'checkout.session.completed',
  '{"object": "checkout.session", "livemode": false}') ->> 'code', 'ignored',
  'unsupported type -> ignored');
select is((select status || ':' || result from public.stripe_events where event_id = 'evt_other'),
  'processed:ignored', 'ignored event recorded as processed');
select is(pg_temp.snapshot() = :'before2', false, 'only stripe_events changed');
select tests.clear_authentication();

-- Clients cannot execute it (also covered in 01).
select tests.authenticate_as(:'a');
select throws_ok($q$select private.process_stripe_event('evt_c', 'invoice.paid', '{"livemode": false}')$q$,
  '42501', null, 'authenticated: process_stripe_event denied');
select tests.clear_authentication();
select tests.as_anon();
select throws_ok($q$select private.process_stripe_event('evt_c', 'invoice.paid', '{"livemode": false}')$q$,
  '42501', null, 'anon: process_stripe_event denied');
select tests.clear_authentication();

select * from finish();
rollback;
