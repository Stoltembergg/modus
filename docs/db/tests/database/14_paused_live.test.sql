-- Paused subscriptions are live: the one-live-per-user index includes 'paused'
-- (incomplete still excluded), so nothing opens a second subscription on top of
-- a paused one; the paused row itself still resumes.
begin;
set local search_path = public, extensions;
select no_plan();

\set expect '{"live_mode": false, "collector_id": "777"}'

create function pg_temp.pre(p_id text, p_ref uuid, p_status text default 'authorized')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'external_reference', p_ref::text,
    'collector_id', '777', 'amount_minor', 4990, 'currency', 'BRL',
    'next_payment_date', '2026-11-03T10:00:00.000-03:00')
$$;
grant execute on function pg_temp.pre(text, uuid, text) to service_role;
create function pg_temp.pay(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', 'approved', 'status_detail', null,
    'amount_minor', 4990, 'refunded_minor', 0, 'live_mode', false,
    'collector_id', '777', 'currency', 'BRL', 'external_reference', null)
$$;
grant execute on function pg_temp.pay(text) to service_role;
create function pg_temp.checkout(p_user uuid, p_pre_id text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  v_id := (private.mp_create_checkout(p_user, 'starter') ->> 'checkout_id')::uuid;
  perform private.mp_link_checkout(v_id, p_pre_id,
    'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=' || p_pre_id);
  return v_id;
end $$;
grant execute on function pg_temp.checkout(uuid, text) to service_role;
create function pg_temp.status(p_pre text) returns text language sql as $$
  select status from public.subscriptions where provider = 'mercadopago' and provider_subscription_id = p_pre
$$;
grant execute on function pg_temp.status(text) to service_role;
create function pg_temp.balance(p_user uuid) returns bigint language sql as $$
  select balance from public.credit_wallets where user_id = p_user
$$;
grant execute on function pg_temp.balance(uuid) to service_role;

-- Index shape.
select is(
  (select pg_get_expr(indpred, indrelid) from pg_index
    where indexrelid = 'public.subscriptions_one_live_per_user'::regclass),
  $$(status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'unpaid'::text, 'paused'::text]))$$,
  'live index: active, trialing, past_due, unpaid, paused');
select ok((select indisunique from pg_index
            where indexrelid = 'public.subscriptions_one_live_per_user'::regclass),
  'live index is UNIQUE');

select tests.create_user('paused-a@example.com', true) as a \gset
select tests.create_user('paused-b@example.com', true) as b \gset
select tests.create_user('paused-c@example.com', true) as c \gset

-- A: active -> paused (MP pause).
select tests.as_service_role();
select pg_temp.checkout(:'a', 'PREPA1') as coa \gset
select private.process_mp_preapproval(pg_temp.pre('PREPA1', :'coa'), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('93001'), pg_temp.pre('PREPA1', :'coa'), :'expect') ->> 'code',
  'credited', 'A: first payment -> active');
select is(private.process_mp_preapproval(pg_temp.pre('PREPA1', :'coa', 'paused'), :'expect') ->> 'code',
  'subscription_paused', 'A: MP pause -> paused');
select is(pg_temp.balance(:'a'), 21000::bigint, 'A: credits unchanged by the pause');

-- No new checkout on top of a paused subscription (mp_create_checkout).
select is(private.mp_create_checkout(:'a', 'starter') ->> 'code', 'already_subscribed',
  'A: paused blocks a new Mercado Pago checkout');
-- mp-cancel can still target it (L1e live set).
select is((select count(*)::int from jsonb_array_elements(private.mp_cancel_targets(:'a')) t
            where t ->> 'status' = 'paused'), 1, 'A: paused is an mp-cancel target');
select tests.clear_authentication();

-- The index itself rejects a second live row next to a paused one (any provider).
select throws_ok(
  format($q$insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
            values (%L, 'sub_paused_a', 'starter', 'active')$q$, :'a'),
  '23505', null, 'A: a second live row next to the paused one violates the index');
select throws_ok(
  format($q$insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status)
            values (%L, 'mercadopago', 'PREPA9', 'starter', 'paused')$q$, :'a'),
  '23505', null, 'A: two paused rows violate the index');
select lives_ok(
  format($q$insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status)
            values (%L, 'mercadopago', 'PREPA8', 'starter', 'incomplete')$q$, :'a'),
  'A: an incomplete row is still allowed next to it (outside the index)');

-- The paused row itself resumes (same row: no conflict).
select tests.as_service_role();
select is(private.process_mp_preapproval(pg_temp.pre('PREPA1', :'coa', 'authorized'), :'expect') ->> 'code',
  'subscription_active', 'A: resume -> active');
select tests.clear_authentication();

-- B: a second preapproval paid while a paused one exists -> rejected_duplicate (no credit).
select tests.as_service_role();
select pg_temp.checkout(:'b', 'PREPB2') as cob \gset
select is(private.process_mp_preapproval(pg_temp.pre('PREPB2', :'cob'), :'expect') ->> 'code',
  'subscription_incomplete', 'B: second preapproval authorized -> incomplete');
select tests.clear_authentication();
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status)
values (:'b', 'mercadopago', 'PREPB1', 'starter', 'paused');
select tests.as_service_role();
select is(private.process_mp_payment(pg_temp.pay('94001'), pg_temp.pre('PREPB2', :'cob'), :'expect') ->> 'code',
  'rejected_duplicate', 'B: payment of a second subscription on top of a paused one is rejected');
select is(pg_temp.status('PREPB2'), 'incomplete', 'B: the second subscription is not activated');
select is(pg_temp.status('PREPB1'), 'paused', 'B: the paused one is untouched');
select is(pg_temp.balance(:'b'), 1000::bigint, 'B: no credit for the duplicate');
select is((select result from public.mp_payments where payment_id = 94001), 'rejected_duplicate',
  'B: recorded for a manual refund');
-- Once the paused one has left the live set, the second can activate.
select tests.clear_authentication();
update public.subscriptions set status = 'canceled' where provider_subscription_id = 'PREPB1';
select tests.as_service_role();
select is(private.process_mp_payment(pg_temp.pay('94002'), pg_temp.pre('PREPB2', :'cob'), :'expect') ->> 'code',
  'credited', 'B: once the paused one is gone the next payment activates the second');
select tests.clear_authentication();

-- C: Stripe paused counts too: blocks MP activation (cross-provider, like B6a).
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values (:'c', 'sub_paused_c', 'starter', 'paused');
select tests.as_service_role();
select is(private.mp_create_checkout(:'c', 'starter') ->> 'code', 'already_subscribed',
  'C: a paused Stripe subscription blocks a Mercado Pago checkout');
select tests.clear_authentication();

select * from finish();
rollback;
