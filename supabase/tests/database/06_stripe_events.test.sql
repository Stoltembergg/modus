-- Debbie review point 8: private.process_stripe_event. User only from
-- profiles.stripe_customer_id, plan only from plans.stripe_price_id, never
-- metadata; livemode must be false; one transaction (errors leave nothing
-- behind); repeated event_id is a no-op; credits once per invoice.
begin;
set local search_path = public, extensions;
select no_plan();
-- L1a deactivated pro / max / ultra; these B1/B3/B6a rules are exercised between
-- paid plans, so reactivate them inside this transaction (rolled back at the end).
-- The inactive-plan behaviour is covered by 10_l1a_inactive_plans.test.sql.
update public.plans set active = true where plan in ('pro', 'max', 'ultra');

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

create function pg_temp.line(p_price text, p_proration boolean, p_sub text, p_amount int)
returns jsonb language sql as $$
  select jsonb_build_object(
    'price', jsonb_build_object('id', p_price), 'proration', p_proration,
    'subscription', p_sub, 'amount', p_amount,
    'period', jsonb_build_object('start', 1790000000, 'end', 1792592000))
$$;
grant execute on function pg_temp.line(text, boolean, text, int) to service_role;
-- Any invoice: reason, amount_paid, subscription, lines.
create function pg_temp.invoice_x(p_id text, p_customer text, p_reason text, p_paid int, p_sub text,
                                  p_lines jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'invoice', 'customer', p_customer, 'status', 'paid',
    'billing_reason', p_reason, 'amount_paid', p_paid, 'subscription', p_sub,
    'livemode', false, 'lines', jsonb_build_object('data', p_lines))
$$;
grant execute on function pg_temp.invoice_x(text, text, text, int, text, jsonb) to service_role;

-- A paid renewal invoice (subscription_cycle, amount_paid > 0) with one
-- non-proration line for p_price on subscription 'sub_<customer>'.
create function pg_temp.invoice(p_id text, p_customer text, p_price text, p_livemode boolean default false,
                                p_metadata jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'invoice', 'customer', p_customer, 'status', 'paid',
    'billing_reason', 'subscription_cycle', 'amount_paid', 900,
    'subscription', 'sub_' || coalesce(p_customer, 'none'),
    'livemode', p_livemode, 'metadata', p_metadata,
    'lines', jsonb_build_object('data', jsonb_build_array(pg_temp.line(
      p_price, false, 'sub_' || coalesce(p_customer, 'none'), 900))))
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

\set starter 'price_1UMIyDKAHtqpope6RahtIgRw'
\set pro 'price_1UMIyIKAHtqpope6sw0xLZDQ'

select tests.as_service_role();
select is(pg_temp.balance(:'a'), 1000::bigint, 'A starts with the free 1000');

-- invoice.paid: credits from the plan, keyed 'invoice:<id>'.
select (private.process_stripe_event('evt_inv1', 'invoice.paid',
  pg_temp.invoice('in_1', 'cus_A', :'starter')))::text as r1 \gset
select is((:'r1'::jsonb ->> 'processed')::boolean, true, 'invoice.paid processed');
select is(:'r1'::jsonb ->> 'code', 'credits_granted', 'invoice.paid: credits_granted');
select is(pg_temp.balance(:'a'), 21000::bigint, 'A +20000 (starter monthly_credits)');
select is((select kind from public.credit_transactions where user_id = :'a' and idempotency_key = 'invoice:in_1'),
  'renewal', 'ledger row invoice:in_1 (renewal)');
select is((select plan_allowance from public.credit_wallets where user_id = :'a'), 20000::bigint,
  'wallet plan_allowance = 20000');
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
select is(pg_temp.balance(:'a'), 21000::bigint, 'repeated event: balance unchanged');
-- Another event for the same invoice: processed, but no second grant.
select is(private.process_stripe_event('evt_inv1_retry', 'invoice.paid',
  pg_temp.invoice('in_1', 'cus_A', :'starter')) ->> 'code', 'already_granted',
  'new event_id for the same invoice: already_granted');
select is(pg_temp.balance(:'a'), 21000::bigint, 'same invoice: still granted once');

-- Newer API shape: price under pricing.price_details.price.
select is(private.process_stripe_event('evt_inv_new', 'invoice.paid', jsonb_build_object(
  'id', 'in_new', 'object', 'invoice', 'customer', 'cus_B', 'status', 'paid', 'livemode', false,
  'billing_reason', 'subscription_create', 'amount_paid', 2000,
  'parent', jsonb_build_object('subscription_details', jsonb_build_object('subscription', 'sub_new_B')),
  'lines', jsonb_build_object('data', jsonb_build_array(jsonb_build_object(
    'parent', jsonb_build_object('subscription_item_details',
      jsonb_build_object('subscription', 'sub_new_B', 'proration', false)),
    'pricing', jsonb_build_object('price_details', jsonb_build_object('price', :'pro'))))))) ->> 'code',
  'credits_granted', 'invoice in the newer API shape (parent.*, pricing.price_details.price) is understood');
select is(pg_temp.balance(:'b'), 51000::bigint, 'B +50000 (pro)');

-- Metadata is never read: metadata naming B does not move A's invoice to B.
select private.process_stripe_event('evt_inv_meta', 'invoice.paid',
  pg_temp.invoice('in_meta', 'cus_A', :'starter', false,
    jsonb_build_object('supabase_user_id', :'b', 'plan', 'ultra'))) \gset ignore_
select is(pg_temp.balance(:'a'), 41000::bigint, 'metadata ignored: A (customer owner) credited');
select is(pg_temp.balance(:'b'), 51000::bigint, 'metadata ignored: B untouched');

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
  pg_temp.invoice('in_nocus', 'cus_nobody', 'price_1UMIyDKAHtqpope6RahtIgRw'))$q$, 'P0404',
  'unknown stripe customer', 'customer with no owner -> error');
select throws_ok($q$select private.process_stripe_event('evt_nocus2', 'customer.subscription.updated',
  pg_temp.sub('sub_x', 'cus_nobody', 'price_1UMIyDKAHtqpope6RahtIgRw'))$q$, 'P0404',
  'unknown stripe customer', 'subscription for a customer with no owner -> error');
select throws_ok($q$select private.process_stripe_event('evt_nocus3', 'invoice.paid',
  pg_temp.invoice('in_nocus3', null, 'price_1UMIyDKAHtqpope6RahtIgRw'))$q$, '22023', null,
  'object without customer -> error');
select is(pg_temp.snapshot(), :'before', 'unknown customer: nothing changed');

-- livemode must be false.
select throws_ok($q$select private.process_stripe_event('evt_live', 'invoice.paid',
  pg_temp.invoice('in_live', 'cus_A', 'price_1UMIyDKAHtqpope6RahtIgRw', true))$q$, '22023', null,
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
select is(pg_temp.balance(:'a'), 41000::bigint, 'subscription events grant no credits');

-- A subscription owned by A cannot be moved to B by an event for cus_B.
select pg_temp.snapshot() as before2 \gset
select throws_ok($q$select private.process_stripe_event('evt_steal', 'customer.subscription.updated',
  pg_temp.sub('sub_A', 'cus_B', 'price_1UMIyIKAHtqpope6sw0xLZDQ'))$q$, 'P0403', null,
  'subscription of A with customer of B -> error');
select is(pg_temp.snapshot(), :'before2', 'steal attempt: nothing changed');

-- Wrong object type for the event.
select throws_ok($q$select private.process_stripe_event('evt_wrongobj', 'invoice.paid',
  pg_temp.sub('sub_A', 'cus_A', 'price_1UMIyIKAHtqpope6sw0xLZDQ'))$q$, '22023', null,
  'invoice.paid with a subscription object -> error');

-- Unsupported types are recorded and ignored.
select is(private.process_stripe_event('evt_other', 'checkout.session.completed',
  '{"object": "checkout.session", "livemode": false}') ->> 'code', 'ignored',
  'unsupported type -> ignored');
select is((select status || ':' || result from public.stripe_events where event_id = 'evt_other'),
  'processed:ignored', 'ignored event recorded as processed');
select is(pg_temp.snapshot() = :'before2', false, 'only stripe_events changed');

-- invoice.paid grant rules (Debbie block on 76911bd).
select tests.clear_authentication();
select tests.create_user('c@example.com', true) as c \gset
update public.profiles set stripe_customer_id = 'cus_C' where id = :'c';
select tests.as_service_role();
select private.process_stripe_event('evt_c_sub', 'customer.subscription.created',
  pg_temp.sub('sub_C', 'cus_C', :'starter')) \gset ignore_
select private.process_stripe_event('evt_c_first', 'invoice.paid',
  pg_temp.invoice_x('in_c1', 'cus_C', 'subscription_create', 900, 'sub_C',
    jsonb_build_array(pg_temp.line(:'starter', false, 'sub_C', 900)))) \gset ignore_
select is(pg_temp.balance(:'c'), 21000::bigint, 'C: subscription_create grants starter 20000 once');
select is((select plan_allowance from public.credit_wallets where user_id = :'c'), 20000::bigint,
  'C: plan_allowance 20000');

-- Upgrade starter -> pro mid-cycle: proration invoice. B1 granted nothing;
-- B3 (20261003041000_b3_billing_upgrades) grants the difference once
-- (details in 07_billing_upgrades.test.sql).
select private.process_stripe_event('evt_c_up_sub', 'customer.subscription.updated',
  pg_temp.sub('sub_C', 'cus_C', :'pro')) \gset ignore_
select pg_temp.snapshot() as before_up \gset
select (private.process_stripe_event('evt_c_prorate', 'invoice.paid',
  pg_temp.invoice_x('in_c_prorate', 'cus_C', 'subscription_update', 1100, 'sub_C', jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_C', -900), pg_temp.line(:'pro', true, 'sub_C', 2000)))))::text as up \gset
select is(:'up'::jsonb ->> 'code', 'upgrade_credits_granted', 'proration invoice (subscription_update): upgrade_credits_granted');
select is((:'up'::jsonb ->> 'granted')::boolean, true, 'proration invoice: granted true');
select is(:'up'::jsonb ->> 'plan', 'pro', 'proration invoice: new plan from the positive line (pro)');
select is(pg_temp.balance(:'c'), 51000::bigint, 'proration invoice: +30000 (pro 50000 - allowance 20000)');
select is((select plan_allowance from public.credit_wallets where user_id = :'c'), 50000::bigint,
  'proration invoice: wallet plan_allowance raised to 50000');
select is((select status || ':' || result from public.stripe_events where event_id = 'evt_c_prorate'),
  'processed:upgrade_credits_granted', 'proration invoice recorded as processed / upgrade_credits_granted');
select is((select count(*)::int from public.credit_transactions where idempotency_key = 'invoice:in_c_prorate'),
  0, 'proration invoice: no renewal ledger row');
select is((select amount from public.credit_transactions where idempotency_key = 'upgrade:in_c_prorate'),
  30000::bigint, 'proration invoice: one upgrade:<invoice> ledger row of 30000');
select is(private.process_stripe_event('evt_c_update_plain', 'invoice.paid',
  pg_temp.invoice_x('in_c_upd2', 'cus_C', 'subscription_update', 2000, 'sub_C',
    jsonb_build_array(pg_temp.line(:'pro', false, 'sub_C', 2000)))) ->> 'code', 'upgrade_no_credits',
  'another subscription_update to the same plan: no further credits');

-- $0 paid invoice (e.g. downgrade, 100% coupon): nothing.
select is(private.process_stripe_event('evt_c_zero', 'invoice.paid',
  pg_temp.invoice_x('in_c_zero', 'cus_C', 'subscription_cycle', 0, 'sub_C',
    jsonb_build_array(pg_temp.line(:'pro', false, 'sub_C', 0)))) ->> 'code', 'not_grantable',
  'amount_paid 0 subscription_cycle: not_grantable');
select is(private.process_stripe_event('evt_c_manual', 'invoice.paid',
  pg_temp.invoice_x('in_c_manual', 'cus_C', 'manual', 5000, 'sub_C',
    jsonb_build_array(pg_temp.line(:'pro', false, 'sub_C', 5000)))) ->> 'code', 'not_grantable',
  'billing_reason manual: not_grantable');
select is(pg_temp.balance(:'c'), 51000::bigint, '$0 / manual invoices: no credits');
select is((select plan_allowance from public.credit_wallets where user_id = :'c'), 50000::bigint,
  '$0 / manual invoices: wallet unchanged');

-- Renewal whose FIRST line is a negative proration of the old price and the
-- second the new price (non-proration): the new plan's credits, once.
select (private.process_stripe_event('evt_c_cycle', 'invoice.paid',
  pg_temp.invoice_x('in_c_cycle', 'cus_C', 'subscription_cycle', 1100, 'sub_C', jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_C', -900), pg_temp.line(:'pro', false, 'sub_C', 2000)))))::text as cy \gset
select is(:'cy'::jsonb ->> 'code', 'credits_granted', 'mixed renewal: credits_granted');
select is(:'cy'::jsonb ->> 'plan', 'pro', 'mixed renewal: plan from the non-proration line (pro), not the first line');
select is(pg_temp.balance(:'c'), 101000::bigint, 'mixed renewal: +50000 (pro)');
select is((select plan_allowance from public.credit_wallets where user_id = :'c'), 50000::bigint,
  'mixed renewal: plan_allowance 50000');
select is(private.process_stripe_event('evt_c_cycle', 'invoice.paid',
  pg_temp.invoice_x('in_c_cycle', 'cus_C', 'subscription_cycle', 1100, 'sub_C', jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_C', -900), pg_temp.line(:'pro', false, 'sub_C', 2000)))) ->> 'code',
  'duplicate', 'mixed renewal: repeated event is a no-op');
select is(private.process_stripe_event('evt_c_cycle_again', 'invoice.paid',
  pg_temp.invoice_x('in_c_cycle', 'cus_C', 'subscription_cycle', 1100, 'sub_C', jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_C', -900), pg_temp.line(:'pro', false, 'sub_C', 2000)))) ->> 'code',
  'already_granted', 'mixed renewal: another event for the same invoice -> already_granted');
select is(pg_temp.balance(:'c'), 101000::bigint, 'mixed renewal: granted exactly once (invoice:<id>)');
select is((select count(*)::int from public.credit_transactions where idempotency_key = 'invoice:in_c_cycle'),
  1, 'one ledger row invoice:in_c_cycle');

-- Server state wins: the subscription is on pro, the invoice only carries a
-- non-proration starter line -> error (the Function retries after the
-- subscription event), nothing written.
select pg_temp.snapshot() as before_stale \gset
select throws_ok($q$select private.process_stripe_event('evt_c_stale', 'invoice.paid',
  pg_temp.invoice_x('in_c_stale', 'cus_C', 'subscription_cycle', 900, 'sub_C',
    jsonb_build_array(pg_temp.line('price_1UMIyDKAHtqpope6RahtIgRw', false, 'sub_C', 900))))$q$,
  'P0404', null, 'no non-proration line with the subscription price -> error');
select throws_ok($q$select private.process_stripe_event('evt_c_othersub', 'invoice.paid',
  pg_temp.invoice_x('in_c_other', 'cus_C', 'subscription_cycle', 2000, 'sub_C',
    jsonb_build_array(pg_temp.line('price_1UMIyIKAHtqpope6sw0xLZDQ', false, 'sub_other', 2000))))$q$,
  'P0404', null, 'a line of another subscription is never used');
select throws_ok($q$select private.process_stripe_event('evt_c_onlyprorate', 'invoice.paid',
  pg_temp.invoice_x('in_c_op', 'cus_C', 'subscription_cycle', 2000, 'sub_C',
    jsonb_build_array(pg_temp.line('price_1UMIyIKAHtqpope6sw0xLZDQ', true, 'sub_C', 2000))))$q$,
  'P0404', null, 'only proration lines -> error');
select throws_ok($q$select private.process_stripe_event('evt_c_nosub', 'invoice.paid',
  pg_temp.invoice_x('in_c_nosub', 'cus_C', 'subscription_cycle', 2000, null,
    jsonb_build_array(pg_temp.line('price_1UMIyIKAHtqpope6sw0xLZDQ', false, null, 2000))))$q$,
  '22023', null, 'renewal invoice without a subscription id -> error');
select throws_ok($q$select private.process_stripe_event('evt_c_foreign_sub', 'invoice.paid',
  pg_temp.invoice_x('in_c_fs', 'cus_C', 'subscription_cycle', 2000, 'sub_A',
    jsonb_build_array(pg_temp.line('price_1UMIyIKAHtqpope6sw0xLZDQ', false, 'sub_A', 2000))))$q$,
  'P0403', null, 'invoice of C pointing at A''s subscription -> error');
select is(pg_temp.snapshot(), :'before_stale', 'stale / foreign / proration-only invoices: nothing changed');
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
