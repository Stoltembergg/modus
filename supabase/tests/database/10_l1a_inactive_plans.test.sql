-- L1a: only Starter is for sale. pro / max / ultra are inactive (no row
-- deleted); both checkout paths refuse them; a Stripe event whose price maps
-- to an inactive plan credits nothing, upserts nothing and is recorded as
-- processed with result 'rejected_inactive_plan'. A subscription already
-- stored on that plan still syncs its status (no credits).
begin;
set local search_path = public, extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.plans), 5, 'no plan row deleted (five plans)');
select is(
  (select string_agg(plan || '=' || active, ',' order by sort_order) from public.plans),
  'free=true,starter=true,pro=false,max=false,ultra=false',
  'free and starter active; pro, max, ultra inactive');
select is(
  (select string_agg(plan || ':' || price_usd_cents || ':' || monthly_credits || ':' || coalesce(stripe_price_id, '-'),
                     ',' order by sort_order) from public.plans),
  'free:0:1000:-,starter:900:10000:price_1UMIyDKAHtqpope6RahtIgRw,'
    || 'pro:2000:25000:price_1UMIyIKAHtqpope6sw0xLZDQ,max:5000:70000:price_1UMIyKKAHtqpope6GL0mTcaB,'
    || 'ultra:10000:150000:price_1UMIyMKAHtqpope6LhMhWnNh',
  'prices, credits and Stripe price ids unchanged');
select is(
  (select string_agg(plan || '=' || amount_minor || ':' || active, ',' order by amount_minor)
     from public.plan_prices where provider = 'mercadopago'),
  'starter=4990:true,pro=10990:true,max=26990:true,ultra=53990:true',
  'plan_prices untouched (no row deleted; Starter R$ 49,90)');

-- Stripe checkout path: the create-checkout-session query (_shared/db.ts
-- getPurchasablePlan; also asserted against the real db.ts in db.integration.ts).
select is(
  (select string_agg(plan, ',' order by sort_order) from public.plans
    where active and stripe_price_id is not null),
  'starter', 'Stripe checkout: only starter is purchasable');

-- ---------------------------------------------------------------------------
-- Mercado Pago checkout path
-- ---------------------------------------------------------------------------
select tests.create_user('l1a-mp@example.com', true) as m \gset
select tests.as_service_role();
select is(private.mp_create_checkout(:'m', 'pro') ->> 'code', 'unknown_plan', 'MP checkout: pro refused');
select is(private.mp_create_checkout(:'m', 'max') ->> 'code', 'unknown_plan', 'MP checkout: max refused');
select is(private.mp_create_checkout(:'m', 'ultra') ->> 'code', 'unknown_plan', 'MP checkout: ultra refused');
select is(private.mp_create_checkout(:'m', 'free') ->> 'code', 'unknown_plan', 'MP checkout: free refused');
select is((select count(*)::int from public.billing_checkouts where user_id = :'m'), 0,
  'refused checkouts leave no billing_checkouts row');
select is(
  (select r ->> 'code' || ':' || (r ->> 'plan') || ':' || (r ->> 'amount_minor') || ':' || (r ->> 'currency')
     from (select private.mp_create_checkout(:'m', 'starter') as r) x),
  'created:starter:4990:BRL', 'MP checkout: starter created at R$ 49,90');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Stripe events
-- ---------------------------------------------------------------------------
select tests.create_user('l1a-a@example.com', true) as a \gset
select tests.create_user('l1a-b@example.com', true) as b \gset
select tests.create_user('l1a-c@example.com', true) as c \gset
update public.profiles set stripe_customer_id = 'cus_L1A' where id = :'a';
update public.profiles set stripe_customer_id = 'cus_L1B' where id = :'b';
update public.profiles set stripe_customer_id = 'cus_L1C' where id = :'c';
-- C subscribed to pro before it was deactivated.
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values (:'c', 'sub_L1C', 'pro', 'active');

create function pg_temp.ledger() returns text
language sql as $$
  select concat_ws('|',
    (select string_agg(user_id || ':' || balance || ':' || plan_allowance, ',' order by user_id) from public.credit_wallets),
    (select count(*) from public.credit_transactions))
$$;
grant execute on function pg_temp.ledger() to service_role;
create function pg_temp.subs() returns text
language sql as $$
  select coalesce(string_agg(stripe_subscription_id || ':' || plan || ':' || status, ',' order by stripe_subscription_id), '')
    from public.subscriptions where stripe_subscription_id like 'sub_L1%'
$$;
grant execute on function pg_temp.subs() to service_role;
create function pg_temp.event(p_id text) returns text
language sql as $$
  select status || ':' || result || ':' || (processed_at is not null) from public.stripe_events where event_id = p_id
$$;
grant execute on function pg_temp.event(text) to service_role;
create function pg_temp.line(p_price text, p_proration boolean, p_sub text, p_amount int)
returns jsonb language sql as $$
  select jsonb_build_object(
    'price', jsonb_build_object('id', p_price), 'proration', p_proration,
    'subscription', p_sub, 'amount', p_amount,
    'period', jsonb_build_object('start', 1790000000, 'end', 1792592000))
$$;
grant execute on function pg_temp.line(text, boolean, text, int) to service_role;
create function pg_temp.invoice(p_id text, p_customer text, p_reason text, p_paid int, p_sub text,
                                p_lines jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'invoice', 'customer', p_customer, 'status', 'paid',
    'billing_reason', p_reason, 'amount_paid', p_paid, 'subscription', p_sub,
    'livemode', false, 'lines', jsonb_build_object('data', p_lines))
$$;
grant execute on function pg_temp.invoice(text, text, text, int, text, jsonb) to service_role;
create function pg_temp.sub(p_id text, p_customer text, p_price text, p_status text default 'active')
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'object', 'subscription', 'customer', p_customer, 'status', p_status,
    'livemode', false, 'cancel_at_period_end', false,
    'items', jsonb_build_object('data', jsonb_build_array(jsonb_build_object(
      'price', jsonb_build_object('id', p_price),
      'current_period_start', 1790000000, 'current_period_end', 1792592000))))
$$;
grant execute on function pg_temp.sub(text, text, text, text) to service_role;

\set starter 'price_1UMIyDKAHtqpope6RahtIgRw'
\set pro 'price_1UMIyIKAHtqpope6sw0xLZDQ'
\set max 'price_1UMIyKKAHtqpope6GL0mTcaB'
\set ultra 'price_1UMIyMKAHtqpope6LhMhWnNh'

select tests.as_service_role();

-- New subscription on an inactive plan: rejected, nothing stored.
select pg_temp.ledger() as l0 \gset
select pg_temp.subs() as s0 \gset
select (private.process_stripe_event('evt_l1a_sub_pro', 'customer.subscription.created',
  pg_temp.sub('sub_L1A', 'cus_L1A', :'pro')))::text as r \gset
select is(:'r'::jsonb ->> 'code', 'rejected_inactive_plan', 'subscription.created on pro: rejected_inactive_plan');
select is(:'r'::jsonb ->> 'plan', 'pro', 'rejected result names the plan');
select is((:'r'::jsonb ->> 'processed')::boolean, true, 'rejected event is processed (the Function answers 200)');
select is(pg_temp.event('evt_l1a_sub_pro'), 'processed:rejected_inactive_plan:true',
  'stripe_events: processed, result rejected_inactive_plan');
select is(pg_temp.subs(), :'s0', 'no subscription row for an inactive plan');

-- First invoice of that subscription (pro / max / ultra): no credits at all.
select (private.process_stripe_event('evt_l1a_inv_pro', 'invoice.paid',
  pg_temp.invoice('in_l1a_pro', 'cus_L1A', 'subscription_create', 2000, 'sub_L1A',
    jsonb_build_array(pg_temp.line(:'pro', false, 'sub_L1A', 2000)))))::text as r \gset
select is(:'r'::jsonb ->> 'code', 'rejected_inactive_plan', 'invoice.paid (pro, subscription_create): rejected');
select is((:'r'::jsonb ->> 'granted')::boolean, false, 'rejected invoice: granted false');
select is(pg_temp.event('evt_l1a_inv_pro'), 'processed:rejected_inactive_plan:true',
  'stripe_events: invoice recorded as rejected_inactive_plan');
select is(private.process_stripe_event('evt_l1a_inv_max', 'invoice.paid',
  pg_temp.invoice('in_l1a_max', 'cus_L1A', 'subscription_cycle', 5000, 'sub_L1A',
    jsonb_build_array(pg_temp.line(:'max', false, 'sub_L1A', 5000)))) ->> 'code',
  'rejected_inactive_plan', 'invoice.paid (max, subscription_cycle): rejected');
select is(private.process_stripe_event('evt_l1a_inv_ultra', 'invoice.paid',
  pg_temp.invoice('in_l1a_ultra', 'cus_L1A', 'subscription_create', 10000, 'sub_L1A',
    jsonb_build_array(pg_temp.line(:'ultra', false, 'sub_L1A', 10000)))) ->> 'code',
  'rejected_inactive_plan', 'invoice.paid (ultra): rejected');
select is(pg_temp.ledger(), :'l0', 'inactive-plan events: zero credit ledger change (balances, allowance, rows)');
select is((select count(*)::int from public.credit_transactions where idempotency_key like 'invoice:in_l1a_%'), 0,
  'no invoice:<id> ledger row for a rejected invoice');

-- Replay of a rejected event: duplicate, still nothing.
select is(private.process_stripe_event('evt_l1a_inv_pro', 'invoice.paid',
  pg_temp.invoice('in_l1a_pro', 'cus_L1A', 'subscription_create', 2000, 'sub_L1A',
    jsonb_build_array(pg_temp.line(:'pro', false, 'sub_L1A', 2000)))) ->> 'code',
  'duplicate', 'replayed rejected event: duplicate');
select is(pg_temp.ledger(), :'l0', 'replay: ledger unchanged');

-- Starter is still sold through the same function.
select is(private.process_stripe_event('evt_l1b_sub', 'customer.subscription.created',
  pg_temp.sub('sub_L1B', 'cus_L1B', :'starter')) ->> 'code', 'subscription_upserted',
  'starter subscription: upserted');
select is(private.process_stripe_event('evt_l1b_inv', 'invoice.paid',
  pg_temp.invoice('in_l1b_1', 'cus_L1B', 'subscription_create', 900, 'sub_L1B',
    jsonb_build_array(pg_temp.line(:'starter', false, 'sub_L1B', 900)))) ->> 'code',
  'credits_granted', 'starter invoice: credits_granted');
select is((select balance from public.credit_wallets where user_id = :'b'), 11000::bigint,
  'B: free 1000 + starter 10000');

-- Starter -> pro: neither the switch nor its upgrade invoice applies.
select pg_temp.ledger() as l1 \gset
select is(private.process_stripe_event('evt_l1b_to_pro', 'customer.subscription.updated',
  pg_temp.sub('sub_L1B', 'cus_L1B', :'pro')) ->> 'code', 'rejected_inactive_plan',
  'subscription.updated starter -> pro: rejected');
select is((select plan from public.subscriptions where stripe_subscription_id = 'sub_L1B'), 'starter',
  'subscription stays on starter');
select is(private.process_stripe_event('evt_l1b_up', 'invoice.paid',
  pg_temp.invoice('in_l1b_up', 'cus_L1B', 'subscription_update', 1100, 'sub_L1B', jsonb_build_array(
    pg_temp.line(:'starter', true, 'sub_L1B', -900), pg_temp.line(:'pro', true, 'sub_L1B', 2000)))) ->> 'code',
  'rejected_inactive_plan', 'upgrade invoice to pro: rejected');
select is(pg_temp.event('evt_l1b_up'), 'processed:rejected_inactive_plan:true',
  'stripe_events: upgrade invoice recorded as rejected_inactive_plan');
select is(pg_temp.ledger(), :'l1', 'upgrade to an inactive plan: zero credit ledger change');

-- Existing pro subscriber: status still syncs (no credits), renewal credits nothing.
select pg_temp.ledger() as l2 \gset
select is(private.process_stripe_event('evt_l1c_upd', 'customer.subscription.updated',
  pg_temp.sub('sub_L1C', 'cus_L1C', :'pro', 'past_due')) ->> 'code', 'subscription_upserted',
  'existing pro subscription: status update applied');
select is((select plan || ':' || status from public.subscriptions where stripe_subscription_id = 'sub_L1C'),
  'pro:past_due', 'existing pro subscription synced');
select is(private.process_stripe_event('evt_l1c_inv', 'invoice.paid',
  pg_temp.invoice('in_l1c_1', 'cus_L1C', 'subscription_cycle', 2000, 'sub_L1C',
    jsonb_build_array(pg_temp.line(:'pro', false, 'sub_L1C', 2000)))) ->> 'code',
  'rejected_inactive_plan', 'existing pro subscription: renewal invoice rejected');
select is(private.process_stripe_event('evt_l1c_del', 'customer.subscription.deleted',
  pg_temp.sub('sub_L1C', 'cus_L1C', :'pro', 'canceled')) ->> 'code', 'subscription_upserted',
  'existing pro subscription: deletion applied');
select is((select status from public.subscriptions where stripe_subscription_id = 'sub_L1C'), 'canceled',
  'existing pro subscription canceled');
select is(pg_temp.ledger(), :'l2', 'existing pro subscriber: zero credit ledger change');
select tests.clear_authentication();

select * from finish();
rollback;
