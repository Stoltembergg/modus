-- L1g (decision 2026-10-03): no resubscribe while a cancelled Mercado Pago plan
-- is still paid. private.mp_create_checkout refuses with 'cancel_grace_active'
-- while the user has a mercadopago row 'canceled' + cancel_at_period_end +
-- current_period_end > now(); allowed after the period end, for a canceled row
-- without the flag, and never blocked by a Stripe row or another user's grace.
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
create function pg_temp.code(p_user uuid) returns text language sql as $$
  select private.mp_create_checkout(p_user, 'starter') ->> 'code'
$$;
grant execute on function pg_temp.code(uuid) to service_role;
create function pg_temp.checkouts(p_user uuid) returns int language sql as $$
  select count(*)::int from public.billing_checkouts where user_id = p_user
$$;
grant execute on function pg_temp.checkouts(uuid) to service_role;

-- Security of the replaced function is unchanged.
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
            where oid = 'private.mp_create_checkout(uuid, text)'::regprocedure),
  'mp_create_checkout: SECURITY DEFINER, search_path=""');
select ok(not has_function_privilege('anon', 'private.mp_create_checkout(uuid, text)', 'execute')
      and not has_function_privilege('authenticated', 'private.mp_create_checkout(uuid, text)', 'execute')
      and has_function_privilege('service_role', 'private.mp_create_checkout(uuid, text)', 'execute'),
  'mp_create_checkout: service_role only');
select is(
  (select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid = 'private.mp_create_checkout(uuid, text)'::regprocedure and a.grantee = 0),
  0, 'mp_create_checkout: no EXECUTE for PUBLIC');

select tests.create_user('l1g-co-a@example.com', true) as a \gset
select tests.create_user('l1g-co-b@example.com', true) as b \gset
select tests.create_user('l1g-co-c@example.com', true) as c \gset
select tests.create_user('l1g-co-d@example.com', true) as d \gset

-- A: the real flow. Paid -> cancel requested -> MP confirms canceled (grace).
select tests.as_service_role();
select private.mp_create_checkout(:'a', 'starter') ->> 'checkout_id' as coa \gset
select is(private.mp_link_checkout(:'coa', 'PRECOA1',
  'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=PRECOA1') ->> 'code',
  'linked', 'A: checkout linked');
select private.process_mp_preapproval(pg_temp.pre('PRECOA1', :'coa'), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('96001'), pg_temp.pre('PRECOA1', :'coa'), :'expect') ->> 'code',
  'credited', 'A: paid');
select is(pg_temp.code(:'a'), 'already_subscribed', 'A: live -> already_subscribed (unchanged)');
select is(private.mp_mark_cancel_requested(:'a', 'PRECOA1') ->> 'code', 'marked', 'A: cancel requested');
select is(pg_temp.code(:'a'), 'already_subscribed', 'A: requested, still live -> already_subscribed');
select private.process_mp_preapproval(pg_temp.pre('PRECOA1', :'coa', 'canceled'), :'expect') \gset ignore_
select is((select status || ':' || cancel_at_period_end from public.subscriptions
            where provider_subscription_id = 'PRECOA1'), 'canceled:true', 'A: canceled, in grace');
select pg_temp.checkouts(:'a') as a_before \gset
select is(pg_temp.code(:'a'), 'cancel_grace_active', 'A: grace -> cancel_grace_active');
select is(private.mp_create_checkout(:'a', 'starter') - 'code', '{}'::jsonb,
  'A: the refusal carries only the code');
select is(pg_temp.checkouts(:'a'), :'a_before'::int, 'A: refused: no checkout row created');
select tests.clear_authentication();

-- The period ends: checkout allowed again.
update public.subscriptions set current_period_end = now() - interval '1 second'
 where provider_subscription_id = 'PRECOA1';
select tests.as_service_role();
select is(pg_temp.code(:'a'), 'created', 'A: after current_period_end -> created');
select is(pg_temp.checkouts(:'a'), :'a_before'::int + 1, 'A: one new checkout');
select tests.clear_authentication();

-- B: canceled without the grace flag (refund / never paid) -> allowed.
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'b', 'mercadopago', 'PRECOB1', 'starter', 'canceled', false, now() + interval '20 days');
-- D: a grace row (inserted directly).
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'d', 'mercadopago', 'PRECOD1', 'starter', 'canceled', true, now() + interval '20 days');
-- C: only a canceled Stripe row with cancel_at_period_end (Stripe's meaning), while
-- another user (D) is in grace: not blocked.
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'c', 'sub_l1g_co_c', 'starter', 'canceled', true, now() + interval '20 days');
select tests.as_service_role();
select is(pg_temp.code(:'b'), 'created', 'B: canceled without the flag -> created');
select is(pg_temp.code(:'c'), 'created', 'C: canceled Stripe row with cancel_at_period_end -> created');
select is(pg_temp.code(:'d'), 'cancel_grace_active', 'D: inserted grace row -> cancel_grace_active');
select is(pg_temp.checkouts(:'d'), 0, 'D: no checkout row');
select tests.clear_authentication();
update public.subscriptions set current_period_end = now() - interval '1 second'
 where provider_subscription_id = 'PRECOD1';
select tests.as_service_role();
select is(pg_temp.code(:'d'), 'created', 'D: after the period end -> created');
select tests.clear_authentication();

select * from finish();
rollback;
