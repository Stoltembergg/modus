-- L1e: Mercado Pago cancellation helpers for the mp-cancel Function.
-- mp_cancel_targets(user) lists only the user's own live Mercado Pago rows
-- (the preapproval id never comes from the client); mp_mark_cancel_requested
-- sets subscriptions.cancel_requested_at without touching the status or
-- cancel_at_period_end; later webhooks that keep the row live keep the flag;
-- the final 'canceled' comes from process_mp_preapproval (webhook / re-fetch),
-- which clears it, after which a new checkout is possible again.
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
  select status || ':' || cancel_at_period_end || ':' || (cancel_requested_at is not null)
    from public.subscriptions
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
-- process_mp_preapproval was replaced by L1e: same security and grants as B6a.
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
            where oid = 'private.process_mp_preapproval(jsonb, jsonb, text)'::regprocedure),
  'process_mp_preapproval (replaced): SECURITY DEFINER, search_path=""');
select is(
  (select count(*)::int from (values ('anon'), ('authenticated')) r (role)
    where has_function_privilege(r.role, 'private.process_mp_preapproval(jsonb, jsonb, text)', 'execute')),
  0, 'process_mp_preapproval (replaced): no anon / authenticated EXECUTE');
select is(
  (select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid = 'private.process_mp_preapproval(jsonb, jsonb, text)'::regprocedure and a.grantee = 0),
  0, 'process_mp_preapproval (replaced): no EXECUTE for PUBLIC');
select ok(has_function_privilege('service_role', 'private.process_mp_preapproval(jsonb, jsonb, text)', 'execute'),
  'process_mp_preapproval (replaced): service_role');

-- subscriptions.cancel_requested_at: readable by the owner (select-own policy), never writable.
select col_type_is('public', 'subscriptions', 'cancel_requested_at', 'timestamp with time zone',
  'cancel_requested_at is timestamptz');
select col_is_null('public', 'subscriptions', 'cancel_requested_at', 'cancel_requested_at is nullable');
select col_hasnt_default('public', 'subscriptions', 'cancel_requested_at', 'cancel_requested_at has no default');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) r (role),
          (values ('INSERT'), ('UPDATE'), ('REFERENCES')) p (priv)
    where has_column_privilege(r.role, 'public.subscriptions', 'cancel_requested_at', p.priv)),
  0, 'anon / authenticated cannot write cancel_requested_at');
select ok(has_column_privilege('authenticated', 'public.subscriptions', 'cancel_requested_at', 'SELECT'),
  'authenticated can read cancel_requested_at (own rows via RLS)');
select ok(not has_column_privilege('anon', 'public.subscriptions', 'cancel_requested_at', 'SELECT'),
  'anon cannot read cancel_requested_at');

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
select is(pg_temp.sub('PRELB1'), 'active:false:false', 'B untouched by A''s call');
select is(private.mp_mark_cancel_requested(:'b', 'PRELB1') ->> 'code', 'marked', 'B: cancel requested');
select is(pg_temp.sub('PRELB1'), 'active:false:true',
  'B: cancel_requested_at set; status stays active, cancel_at_period_end untouched');
-- coalesce: a repeat keeps the first request time.
update public.subscriptions set cancel_requested_at = '2026-10-01T12:00:00Z'
 where provider_subscription_id = 'PRELB1';
select is(private.mp_mark_cancel_requested(:'b', 'PRELB1') ->> 'code', 'marked', 'B: repeat is harmless');
select is((select cancel_requested_at from public.subscriptions where provider_subscription_id = 'PRELB1'),
  '2026-10-01T12:00:00Z'::timestamptz, 'B: repeat keeps the first cancel_requested_at');
select is(pg_temp.targets(:'b'), 'PRELB1:active:true', 'B: target reports cancel_requested');

-- Later webhooks that keep the row live never clear the request.
select is(private.process_mp_preapproval(pg_temp.pre('PRELB1', :'cob', 'authorized'), :'expect') ->> 'code',
  'subscription_active', 'B: late authorized webhook after the cancel request');
select is(pg_temp.sub('PRELB1'), 'active:false:true', 'B: authorized webhook keeps cancel_requested_at');
select is((select cancel_requested_at from public.subscriptions where provider_subscription_id = 'PRELB1'),
  '2026-10-01T12:00:00Z'::timestamptz, 'B: ... with the same timestamp');
select is(private.process_mp_payment(pg_temp.pay('91001', :'cob'), pg_temp.pre('PRELB1', :'cob'), :'expect') ->> 'code',
  'already_credited', 'B: a repeated payment webhook');
select is(pg_temp.sub('PRELB1'), 'active:false:true', 'B: payment webhook keeps cancel_requested_at');
select is(private.process_mp_preapproval(pg_temp.pre('PRELB1', :'cob', 'paused'), :'expect') ->> 'code',
  'subscription_paused', 'B: paused (still live)');
select is(pg_temp.sub('PRELB1'), 'paused:false:true', 'B: paused keeps cancel_requested_at');
select is(private.process_mp_preapproval(pg_temp.pre('PRELB1', :'cob', 'authorized'), :'expect') ->> 'code',
  'subscription_active', 'B: authorized again -> active');
select is(pg_temp.sub('PRELB1'), 'active:false:true', 'B: still requested');
select is(private.mp_mark_cancel_requested(:'s', 'subL1ES') ->> 'code', 'not_found',
  'Stripe row: not flagged by the Mercado Pago path');
select is((select cancel_at_period_end::text || ':' || (cancel_requested_at is null)::text
             from public.subscriptions where stripe_subscription_id = 'sub_L1E_S'),
  'false:true', 'Stripe row untouched');
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
select is(pg_temp.sub('PRELB1'), 'canceled:true:false',
  'B: status left the live set -> cancel_requested_at cleared (L1g: paid until period end)');
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
select is(pg_temp.sub('PRELA1'), 'incomplete:false:true', 'A: still incomplete until MP confirms');
select is(private.process_mp_preapproval(pg_temp.pre('PRELA1', :'coa', 'authorized'), :'expect') ->> 'code',
  'subscription_incomplete', 'A: late authorized webhook');
select is(pg_temp.sub('PRELA1'), 'incomplete:false:true', 'A: still requested after it');
select is(private.process_mp_preapproval(pg_temp.pre('PRELA1', :'coa', 'canceled'), :'expect') ->> 'code',
  'subscription_canceled', 'A: MP canceled -> canceled');
select is(pg_temp.sub('PRELA1'), 'canceled:false:false', 'A: canceled, request cleared');
select is((select status from public.billing_checkouts where id = :'coa'), 'canceled',
  'A: its checkout record is closed');
select is(private.mp_create_checkout(:'a', 'starter') ->> 'code', 'created',
  'A: try again -> a fresh checkout');
select tests.clear_authentication();

-- The owner reads the flag, but can never write it (RLS + no UPDATE grant).
select tests.authenticate_as(:'a');
select is((select count(*)::int from public.subscriptions where cancel_requested_at is null), 1,
  'A reads own cancel_requested_at');
select throws_ok(
  $q$update public.subscriptions set cancel_requested_at = now()$q$, '42501', null,
  'authenticated: cannot set cancel_requested_at');
select tests.clear_authentication();

select * from finish();
rollback;
