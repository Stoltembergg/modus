-- L1e: Mercado Pago cancellation helpers for the mp-cancel Function.
-- mp_cancel_targets(user) lists only the user's own live Mercado Pago rows
-- (the preapproval id never comes from the client); mp_mark_cancel_requested
-- flags a pending cancellation without touching the status; the final
-- 'canceled' comes from process_mp_preapproval (webhook / re-fetch), after
-- which a new checkout is possible again ("Cancel and try again").
begin;
set local search_path = public, extensions;
select no_plan();

\set expect '{"live_mode": false, "collector_id": "777"}'

create function pg_temp.pre(p_id text, p_ref uuid, p_status text default 'authorized',
                            p_amount bigint default 4990)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'external_reference', p_ref::text,
    'collector_id', '777', 'amount_minor', p_amount, 'currency', 'BRL',
    'next_payment_date', '2026-11-03T10:00:00.000-03:00')
$$;
grant execute on function pg_temp.pre(text, uuid, text, bigint) to service_role;
create function pg_temp.pay(p_id text, p_ref uuid)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', 'approved', 'status_detail', null,
    'amount_minor', 4990, 'refunded_minor', 0, 'live_mode', false,
    'collector_id', '777', 'currency', 'BRL', 'external_reference', p_ref::text)
$$;
grant execute on function pg_temp.pay(text, uuid) to service_role;
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
create function pg_temp.sub(p_pre text) returns text
language sql as $$
  select status || ':' || cancel_at_period_end from public.subscriptions
   where provider = 'mercadopago' and provider_subscription_id = p_pre
$$;
grant execute on function pg_temp.sub(text) to service_role;
create function pg_temp.targets(p_user uuid) returns text
language sql as $$
  select coalesce(string_agg((t ->> 'preapproval_id') || ':' || (t ->> 'status') || ':' || (t ->> 'cancel_requested'),
                             ',' order by t ->> 'preapproval_id'), '')
    from jsonb_array_elements(private.mp_cancel_targets(p_user)) t
$$;
grant execute on function pg_temp.targets(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
            where oid = 'private.mp_cancel_targets(uuid)'::regprocedure),
  'mp_cancel_targets: SECURITY DEFINER, search_path=""');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
            where oid = 'private.mp_mark_cancel_requested(uuid, text)'::regprocedure),
  'mp_mark_cancel_requested: SECURITY DEFINER, search_path=""');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated'), ('public')) r (role),
          (values ('private.mp_cancel_targets(uuid)'), ('private.mp_mark_cancel_requested(uuid, text)')) f (fn)
    where r.role <> 'public' and has_function_privilege(r.role, f.fn, 'execute')),
  0, 'anon / authenticated cannot execute the L1e RPCs');
select is(
  (select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid in ('private.mp_cancel_targets(uuid)'::regprocedure,
                    'private.mp_mark_cancel_requested(uuid, text)'::regprocedure)
      and a.grantee = 0),
  0, 'no EXECUTE for PUBLIC');
select ok(has_function_privilege('service_role', 'private.mp_cancel_targets(uuid)', 'execute'),
  'service_role: mp_cancel_targets');
select ok(has_function_privilege('service_role', 'private.mp_mark_cancel_requested(uuid, text)', 'execute'),
  'service_role: mp_mark_cancel_requested');

select tests.create_user('l1e-a@example.com', true) as a \gset
select tests.create_user('l1e-b@example.com', true) as b \gset
select tests.create_user('l1e-s@example.com', true) as s \gset
select tests.create_user('l1e-n@example.com', true) as n \gset

select tests.authenticate_as(:'a');
select throws_ok(format($q$select private.mp_cancel_targets(%L)$q$, :'a'), '42501', null,
  'authenticated: mp_cancel_targets denied');
select throws_ok(format($q$select private.mp_mark_cancel_requested(%L, 'PREX')$q$, :'a'), '42501', null,
  'authenticated: mp_mark_cancel_requested denied');
select tests.clear_authentication();
select tests.as_anon();
select throws_ok(format($q$select private.mp_cancel_targets(%L)$q$, :'a'), '42501', null,
  'anon: mp_cancel_targets denied');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Targets: own live Mercado Pago rows only
-- ---------------------------------------------------------------------------
select tests.as_service_role();
-- A: authorized in MP, no approved payment yet -> incomplete.
select pg_temp.checkout(:'a', 'PRELA1') as coa \gset
select is(private.process_mp_preapproval(pg_temp.pre('PRELA1', :'coa'), :'expect') ->> 'code',
  'subscription_incomplete', 'A: authorized -> incomplete');
-- B: first payment approved -> active.
select pg_temp.checkout(:'b', 'PRELB1') as cob \gset
select private.process_mp_preapproval(pg_temp.pre('PRELB1', :'cob'), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('91001', :'cob'), pg_temp.pre('PRELB1', :'cob'), :'expect') ->> 'code',
  'credited', 'B: approved payment -> active');
select tests.clear_authentication();
-- S: a Stripe subscription (never a Mercado Pago target).
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values (:'s', 'sub_L1E_S', 'starter', 'active');

select tests.as_service_role();
select is(pg_temp.targets(:'a'), 'PRELA1:incomplete:false', 'A: the incomplete row is a target');
select is(pg_temp.targets(:'b'), 'PRELB1:active:false', 'B: the active row is a target');
select is(pg_temp.targets(:'s'), '', 'S: Stripe rows are never Mercado Pago targets');
select is(pg_temp.targets(:'n'), '', 'N: no subscription -> no target');
select is(private.mp_cancel_targets(null), '[]'::jsonb, 'null user -> no target');
select is((select count(*)::int from jsonb_array_elements(private.mp_cancel_targets(:'a')) t
            where t ->> 'preapproval_id' = 'PRELB1'), 0, 'A never sees B''s preapproval');

-- ---------------------------------------------------------------------------
-- mark_cancel_requested: own, live, Mercado Pago; status untouched; idempotent
-- ---------------------------------------------------------------------------
select is(private.mp_mark_cancel_requested(:'a', 'PRELB1') ->> 'code', 'not_found',
  'A cannot flag B''s subscription');
select is(pg_temp.sub('PRELB1'), 'active:false', 'B untouched by A''s call');
select is(private.mp_mark_cancel_requested(:'b', 'PRELB1') ->> 'code', 'marked', 'B: cancel requested');
select is(pg_temp.sub('PRELB1'), 'active:true', 'B: status stays active (final status only from MP)');
select is(private.mp_mark_cancel_requested(:'b', 'PRELB1') ->> 'code', 'marked', 'B: repeat is harmless');
select is(pg_temp.targets(:'b'), 'PRELB1:active:true', 'B: target reports cancel_requested');
select is(private.mp_mark_cancel_requested(:'s', 'subL1ES') ->> 'code', 'not_found',
  'Stripe row: not flagged by the Mercado Pago path');
select is((select cancel_at_period_end from public.subscriptions where stripe_subscription_id = 'sub_L1E_S'),
  false, 'Stripe row untouched');
select throws_ok(format($q$select private.mp_mark_cancel_requested(%L, 'bad id!')$q$, :'b'), '22023', null,
  'malformed preapproval id rejected');
select is((select count(*)::int from public.credit_transactions where user_id = :'b'), 2,
  'B: no credit change from the cancel request (signup grant + payment only)');

-- ---------------------------------------------------------------------------
-- Confirmation comes from process_mp_preapproval (canceled)
-- ---------------------------------------------------------------------------
select (select balance from public.credit_wallets where user_id = :'b') as b_bal \gset
select is(private.process_mp_preapproval(pg_temp.pre('PRELB1', :'cob', 'canceled'), :'expect') ->> 'code',
  'subscription_canceled', 'B: MP canceled -> subscription_canceled');
select is(pg_temp.sub('PRELB1'), 'canceled:false', 'B: canceled, flag cleared');
select is(pg_temp.targets(:'b'), '', 'B: no target left (cancel again is a no-op)');
select is((select balance from public.credit_wallets where user_id = :'b'), :'b_bal'::bigint,
  'B: credits kept, no refund / debit');
select is(private.mp_mark_cancel_requested(:'b', 'PRELB1') ->> 'code', 'not_found',
  'B: flagging a canceled row is a no-op');
select is(private.process_mp_preapproval(pg_temp.pre('PRELB1', :'cob', 'canceled'), :'expect') ->> 'code',
  'subscription_canceled', 'B: repeated cancel confirmation is idempotent');
select is(private.mp_create_checkout(:'b', 'starter') ->> 'code', 'created',
  'B: after the confirmed cancel a new checkout is possible');

-- Incomplete: "Cancel and try again".
select is(private.mp_mark_cancel_requested(:'a', 'PRELA1') ->> 'code', 'marked', 'A: incomplete flagged');
select is(pg_temp.sub('PRELA1'), 'incomplete:true', 'A: still incomplete until MP confirms');
select is(private.process_mp_preapproval(pg_temp.pre('PRELA1', :'coa', 'canceled'), :'expect') ->> 'code',
  'subscription_canceled', 'A: MP canceled -> canceled');
select is((select status from public.billing_checkouts where id = :'coa'), 'canceled',
  'A: its checkout record is closed');
select is(private.mp_create_checkout(:'a', 'starter') ->> 'code', 'created',
  'A: try again -> a fresh checkout');
select tests.clear_authentication();

select * from finish();
rollback;
