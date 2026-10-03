-- B3 (20261003041000_b3_billing_upgrades): mid-period upgrades grant the
-- difference once; downgrades never remove credits; subscription_cycle
-- resets plan_allowance; private.claim_stripe_customer.
begin;
set local search_path = public, extensions;
select no_plan();
-- L1a deactivated pro / max / ultra; these B1/B3/B6a rules are exercised between
-- paid plans, so reactivate them inside this transaction (rolled back at the end).
-- The inactive-plan behaviour is covered by 10_l1a_inactive_plans.test.sql.
update public.plans set active = true where plan in ('pro', 'max', 'ultra');

select tests.create_user('d@example.com', true) as d \gset
select tests.create_user('e@example.com', true) as e \gset
update public.profiles set stripe_customer_id = 'cus_D' where id = :'d';

create function pg_temp.balance(p_user uuid) returns bigint
language sql as $$ select balance from public.credit_wallets where user_id = p_user $$;
create function pg_temp.allowance(p_user uuid) returns bigint
language sql as $$ select plan_allowance from public.credit_wallets where user_id = p_user $$;
create function pg_temp.line(p_price text, p_proration boolean, p_sub text, p_amount int)
returns jsonb language sql as $$
  select jsonb_build_object(
    'price', jsonb_build_object('id', p_price), 'proration', p_proration,
    'subscription', p_sub, 'amount', p_amount,
    'period', jsonb_build_object('start', 1790000000, 'end', 1792592000))
$$;
create function pg_temp.inv(p_id text, p_reason text, p_paid int, p_lines jsonb,
                            p_customer text default 'cus_D', p_livemode boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'invoice', 'customer', p_customer, 'status', 'paid',
    'billing_reason', p_reason, 'amount_paid', p_paid, 'subscription', 'sub_D',
    'livemode', p_livemode, 'lines', jsonb_build_object('data', p_lines))
$$;
create function pg_temp.sub(p_price text) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', 'sub_D', 'object', 'subscription', 'customer', 'cus_D', 'status', 'active',
    'livemode', false, 'cancel_at_period_end', false,
    'items', jsonb_build_object('data', jsonb_build_array(jsonb_build_object(
      'price', jsonb_build_object('id', p_price),
      'current_period_start', 1790000000, 'current_period_end', 1792592000))))
$$;
grant execute on all functions in schema pg_temp to service_role;

\set starter 'price_1UMIyDKAHtqpope6RahtIgRw'
\set pro 'price_1UMIyIKAHtqpope6sw0xLZDQ'
\set max 'price_1UMIyKKAHtqpope6GL0mTcaB'

select tests.as_service_role();
select is(pg_temp.balance(:'d'), 1000::bigint, 'D starts with the free 1000');

-- Starter subscription: +10000, allowance 10000.
select private.process_stripe_event('evt_d_sub', 'customer.subscription.created', pg_temp.sub(:'starter')) \gset ignore_
select is(private.process_stripe_event('evt_d_create', 'invoice.paid',
  pg_temp.inv('in_d_create', 'subscription_create', 900,
    jsonb_build_array(pg_temp.line(:'starter', false, 'sub_D', 900)))) ->> 'code',
  'credits_granted', 'subscription_create grants the starter credits');
select is(pg_temp.balance(:'d'), 11000::bigint, 'D: 1000 + 10000');
select is(pg_temp.allowance(:'d'), 10000::bigint, 'D: allowance 10000');

-- 1. Upgrade starter -> pro (always_invoice): +15000.
select private.process_stripe_event('evt_d_up1_sub', 'customer.subscription.updated', pg_temp.sub(:'pro')) \gset ignore_
select (private.process_stripe_event('evt_d_up1', 'invoice.paid',
  pg_temp.inv('in_d_up1', 'subscription_update', 1100, jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_D', -900), pg_temp.line(:'pro', true, 'sub_D', 2000)))))::text as up1 \gset
select is(:'up1'::jsonb ->> 'code', 'upgrade_credits_granted', 'upgrade 1: upgrade_credits_granted');
select is((:'up1'::jsonb ->> 'credits')::bigint, 15000::bigint, 'upgrade 1: difference 25000 - 10000');
select is((:'up1'::jsonb ->> 'previous_allowance')::bigint, 10000::bigint, 'upgrade 1: old plan from wallet state');
select is(pg_temp.balance(:'d'), 26000::bigint, 'upgrade 1: balance 26000');
select is(pg_temp.allowance(:'d'), 25000::bigint, 'upgrade 1: allowance 25000');
select is((select kind || ':' || amount || ':' || ref from public.credit_transactions
            where user_id = :'d' and idempotency_key = 'upgrade:in_d_up1'),
  'grant:15000:in_d_up1', 'upgrade 1: ledger upgrade:<invoice id>');

-- Replays: same event no-op; another event for the same invoice grants nothing.
select is(private.process_stripe_event('evt_d_up1', 'invoice.paid',
  pg_temp.inv('in_d_up1', 'subscription_update', 1100, jsonb_build_array(
    pg_temp.line(:'pro', true, 'sub_D', 2000)))) ->> 'code', 'duplicate', 'upgrade 1 replay: duplicate');
select is(private.process_stripe_event('evt_d_up1_again', 'invoice.paid',
  pg_temp.inv('in_d_up1', 'subscription_update', 1100, jsonb_build_array(
    pg_temp.line(:'pro', true, 'sub_D', 2000)))) ->> 'code', 'upgrade_no_credits',
  'upgrade 1, new event id: no second grant');
select is(pg_temp.balance(:'d'), 26000::bigint, 'upgrade 1 replays: balance unchanged');

-- 2. Downgrade pro -> starter: scheduled at period end; even if the
-- subscription switches now and a $0 / credit invoice arrives, nothing is removed.
select private.process_stripe_event('evt_d_down_sub', 'customer.subscription.updated', pg_temp.sub(:'starter')) \gset ignore_
select is(private.process_stripe_event('evt_d_down_zero', 'invoice.paid',
  pg_temp.inv('in_d_down', 'subscription_update', 0, jsonb_build_array(
    pg_temp.line(:'pro', true, 'sub_D', -2000), pg_temp.line(:'starter', true, 'sub_D', 900)))) ->> 'code',
  'not_grantable', 'downgrade invoice ($0): not_grantable');
select is(pg_temp.balance(:'d'), 26000::bigint, 'downgrade: credits never removed');
select is(pg_temp.allowance(:'d'), 25000::bigint, 'downgrade: allowance stays 25000 until the period ends');
select is((select plan from public.subscriptions where stripe_subscription_id = 'sub_D'), 'starter',
  'downgrade: subscription row follows Stripe');

-- 3. Upgrade starter -> pro again in the same period: difference already granted.
select private.process_stripe_event('evt_d_up2_sub', 'customer.subscription.updated', pg_temp.sub(:'pro')) \gset ignore_
select (private.process_stripe_event('evt_d_up2', 'invoice.paid',
  pg_temp.inv('in_d_up2', 'subscription_update', 1100, jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_D', -900), pg_temp.line(:'pro', true, 'sub_D', 2000)))))::text as up2 \gset
select is(:'up2'::jsonb ->> 'code', 'upgrade_no_credits', 'upgrade 2 (same period): upgrade_no_credits');
select is((:'up2'::jsonb ->> 'credits')::bigint, 0::bigint, 'upgrade 2: max(0, 25000 - 25000) = 0');
select is(pg_temp.balance(:'d'), 26000::bigint, 'upgrade -> downgrade -> upgrade: the difference was granted once');
select is((select count(*)::int from public.credit_transactions where user_id = :'d' and idempotency_key like 'upgrade:%'),
  1, 'one upgrade ledger row in the period');

-- 4. Upgrade pro -> max: +45000.
select is(private.process_stripe_event('evt_d_up3', 'invoice.paid',
  pg_temp.inv('in_d_up3', 'subscription_update', 3000, jsonb_build_array(
    pg_temp.line(:'pro', true, 'sub_D', -2000), pg_temp.line(:'max', true, 'sub_D', 5000)))) ->> 'credits',
  '45000', 'upgrade pro -> max: +45000');
select is(pg_temp.balance(:'d'), 71000::bigint, 'balance 71000');
select is(pg_temp.allowance(:'d'), 70000::bigint, 'allowance 70000');

-- 5. Renewal resets the allowance to the renewed plan (here the scheduled
-- downgrade to starter took effect): +10000, allowance 10000. A later
-- upgrade in the new period is granted again.
select private.process_stripe_event('evt_d_cycle_sub', 'customer.subscription.updated', pg_temp.sub(:'starter')) \gset ignore_
select is(private.process_stripe_event('evt_d_cycle', 'invoice.paid',
  pg_temp.inv('in_d_cycle', 'subscription_cycle', 900, jsonb_build_array(
    pg_temp.line(:'starter', false, 'sub_D', 900)))) ->> 'code', 'credits_granted',
  'renewal on starter: credits_granted');
select is(pg_temp.balance(:'d'), 81000::bigint, 'renewal: +10000, earlier credits kept');
select is(pg_temp.allowance(:'d'), 10000::bigint, 'renewal: allowance reset to 10000');
select is(private.process_stripe_event('evt_d_up4', 'invoice.paid',
  pg_temp.inv('in_d_up4', 'subscription_update', 1100, jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_D', -900), pg_temp.line(:'pro', true, 'sub_D', 2000)))) ->> 'credits',
  '15000', 'new period: upgrade to pro grants the difference again');

-- 6. Rejections leave nothing behind.
select (select count(*) from public.credit_transactions)::text || '|' || pg_temp.balance(:'d') as before \gset
select throws_ok($q$select private.process_stripe_event('evt_d_bad1', 'invoice.paid',
  pg_temp.inv('in_d_bad1', 'subscription_update', 2000, jsonb_build_array(
    pg_temp.line('price_unknown', true, 'sub_D', 2000))))$q$, 'P0404', null,
  'upgrade with an unknown price -> error');
select throws_ok($q$select private.process_stripe_event('evt_d_bad2', 'invoice.paid',
  pg_temp.inv('in_d_bad2', 'subscription_update', 2000, jsonb_build_array(
    pg_temp.line('price_1UMIyMKAHtqpope6LhMhWnNh', true, 'sub_other', 2000))))$q$, 'P0404', null,
  'upgrade line of another subscription is never used');
select throws_ok($q$select private.process_stripe_event('evt_d_bad3', 'invoice.paid',
  pg_temp.inv('in_d_bad3', 'subscription_update', 2000, jsonb_build_array(
    pg_temp.line('price_1UMIyMKAHtqpope6LhMhWnNh', true, 'sub_D', 2000)), 'cus_D', true))$q$, '22023', null,
  'livemode true upgrade invoice rejected');
select is((select count(*) from public.credit_transactions)::text || '|' || pg_temp.balance(:'d'), :'before',
  'rejected upgrade invoices: nothing changed');
select is((select count(*)::int from public.stripe_events where event_id like 'evt_d_bad%'), 0,
  'rejected upgrade invoices: not recorded');

-- 7. claim_stripe_customer.
select is(private.claim_stripe_customer(:'e', 'cus_E1'), 'cus_E1', 'claim: stores the first customer');
select is(private.claim_stripe_customer(:'e', 'cus_E2'), 'cus_E1', 'claim: keeps the stored customer');
select is((select stripe_customer_id from public.profiles where id = :'e'), 'cus_E1', 'claim: profile has cus_E1');
select throws_ok($q$select private.claim_stripe_customer('00000000-0000-4000-8000-000000000000', 'cus_X')$q$,
  'P0404', null, 'claim: unknown profile -> error');
select throws_ok(format($q$select private.claim_stripe_customer(%L, 'not-a-customer')$q$, :'e'),
  '22023', null, 'claim: malformed customer id -> error');
select tests.clear_authentication();
select tests.create_user('f@example.com', true) as f \gset
select tests.as_service_role();
select throws_ok(format($q$select private.claim_stripe_customer(%L, 'cus_D')$q$, :'f'),
  '23505', null, 'claim: a customer owned by another profile -> unique violation');
select tests.clear_authentication();

-- 8. Privileges.
select ok((select prosecdef from pg_proc where oid = 'private.claim_stripe_customer(uuid, text)'::regprocedure),
  'claim_stripe_customer is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc
            where oid = 'private.claim_stripe_customer(uuid, text)'::regprocedure),
  'claim_stripe_customer has search_path=""');
select ok((select proconfig @> array['search_path=""'] from pg_proc
            where oid = 'private.process_stripe_event(text, text, jsonb)'::regprocedure),
  'replaced process_stripe_event keeps search_path=""');
select ok(not has_function_privilege('anon', 'private.claim_stripe_customer(uuid, text)', 'execute'),
  'anon cannot execute claim_stripe_customer');
select ok(not has_function_privilege('authenticated', 'private.claim_stripe_customer(uuid, text)', 'execute'),
  'authenticated cannot execute claim_stripe_customer');
select ok(not has_function_privilege('authenticated', 'private.process_stripe_event(text, text, jsonb)', 'execute'),
  'authenticated still cannot execute process_stripe_event');
select ok(has_function_privilege('service_role', 'private.claim_stripe_customer(uuid, text)', 'execute'),
  'service_role can execute claim_stripe_customer');
select tests.authenticate_as(:'e');
select throws_ok(format($q$select private.claim_stripe_customer(%L, 'cus_Z')$q$, :'e'),
  '42501', null, 'authenticated: claim_stripe_customer denied');
select tests.clear_authentication();

-- B3 follow-up (*_b3_subscriptions_plan_fk_index): FK subscriptions_plan_fkey is indexed.
select has_index('public', 'subscriptions', 'subscriptions_plan_idx', array['plan'],
  'subscriptions.plan (FK to plans) has an index');

select * from finish();
rollback;
