-- L1g: a cancelled paid Mercado Pago subscription keeps its plan until
-- current_period_end (status 'canceled' + cancel_at_period_end); refund and
-- chargeback (process_mp_payment) clear cancel_requested_at and any grace; a
-- reactivation is never "ending" or "cancel requested"; paused / incomplete
-- cancels get no grace.
begin;
set local search_path = public, extensions;
select no_plan();

\set expect '{"live_mode": false, "collector_id": "777"}'

create function pg_temp.pre(p_id text, p_ref uuid, p_status text default 'authorized',
                            p_next text default '2026-11-03T10:00:00.000-03:00')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'external_reference', p_ref::text,
    'collector_id', '777', 'amount_minor', 4990, 'currency', 'BRL', 'next_payment_date', p_next)
$$;
grant execute on function pg_temp.pre(text, uuid, text, text) to service_role;
create function pg_temp.pay(p_id text, p_status text default 'approved', p_refunded bigint default 0)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'status_detail', null,
    'amount_minor', 4990, 'refunded_minor', p_refunded, 'live_mode', false,
    'collector_id', '777', 'currency', 'BRL', 'external_reference', null)
$$;
grant execute on function pg_temp.pay(text, text, bigint) to service_role;
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
-- An active (paid) subscription: checkout -> authorized -> approved payment.
create function pg_temp.active(p_user uuid, p_pre_id text, p_pay_id text) returns uuid
language plpgsql as $$
declare v_co uuid;
begin
  v_co := pg_temp.checkout(p_user, p_pre_id);
  perform private.process_mp_preapproval(pg_temp.pre(p_pre_id, v_co), '{"live_mode": false, "collector_id": "777"}');
  perform private.process_mp_payment(pg_temp.pay(p_pay_id), pg_temp.pre(p_pre_id, v_co),
    '{"live_mode": false, "collector_id": "777"}');
  return v_co;
end $$;
grant execute on function pg_temp.active(uuid, text, text) to service_role;
-- status:cancel_at_period_end:cancel_requested
create function pg_temp.sub(p_pre text) returns text language sql as $$
  select status || ':' || cancel_at_period_end || ':' || (cancel_requested_at is not null)
    from public.subscriptions where provider = 'mercadopago' and provider_subscription_id = p_pre
$$;
grant execute on function pg_temp.sub(text) to service_role;
create function pg_temp.period_end(p_pre text) returns timestamptz language sql as $$
  select current_period_end from public.subscriptions
   where provider = 'mercadopago' and provider_subscription_id = p_pre
$$;
grant execute on function pg_temp.period_end(text) to service_role;

-- Security of the replaced functions is unchanged.
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
            where oid in ('private.process_mp_preapproval(jsonb, jsonb, text)'::regprocedure,
                          'private.process_mp_payment(jsonb, jsonb, jsonb, text)'::regprocedure)),
  'replaced functions: SECURITY DEFINER, search_path=""');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated'), ('public')) r (role),
          (values ('private.process_mp_preapproval(jsonb, jsonb, text)'),
                  ('private.process_mp_payment(jsonb, jsonb, jsonb, text)')) f (fn)
    where r.role <> 'public' and has_function_privilege(r.role, f.fn, 'execute')),
  0, 'replaced functions: no anon / authenticated EXECUTE');
select is(
  (select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid in ('private.process_mp_preapproval(jsonb, jsonb, text)'::regprocedure,
                    'private.process_mp_payment(jsonb, jsonb, jsonb, text)'::regprocedure)
      and a.grantee = 0),
  0, 'replaced functions: no EXECUTE for PUBLIC');
select ok(has_function_privilege('service_role', 'private.process_mp_payment(jsonb, jsonb, jsonb, text)', 'execute')
      and has_function_privilege('service_role', 'private.process_mp_preapproval(jsonb, jsonb, text)', 'execute'),
  'replaced functions: service_role');

select tests.create_user('l1g-a@example.com', true) as a \gset
select tests.create_user('l1g-b@example.com', true) as b \gset
select tests.create_user('l1g-c@example.com', true) as c \gset
select tests.create_user('l1g-d@example.com', true) as d \gset
select tests.create_user('l1g-e@example.com', true) as e \gset
select tests.create_user('l1g-f@example.com', true) as f \gset
select tests.create_user('l1g-g@example.com', true) as g \gset

select tests.as_service_role();

-- ---------------------------------------------------------------------------
-- A: paid, cancel requested, Mercado Pago confirms -> canceled, paid until period end
-- ---------------------------------------------------------------------------
select pg_temp.active(:'a', 'PREGA1', '95001') as coa \gset
select is(pg_temp.sub('PREGA1'), 'active:false:false', 'A: active');
select pg_temp.period_end('PREGA1') as a_end \gset
select ok(:'a_end'::timestamptz > now(), 'A: the paid period is in the future');
select is(private.mp_mark_cancel_requested(:'a', 'PREGA1') ->> 'code', 'marked', 'A: cancel requested');
select is(private.process_mp_preapproval(
  pg_temp.pre('PREGA1', :'coa', 'canceled', '2026-12-03T10:00:00.000-03:00'), :'expect') ->> 'code',
  'subscription_canceled', 'A: MP canceled');
select is(pg_temp.sub('PREGA1'), 'canceled:true:false',
  'A: canceled + cancel_at_period_end (paid until the period end), request cleared');
select is(pg_temp.period_end('PREGA1'), :'a_end'::timestamptz,
  'A: the cancel does not move current_period_end (MP next_payment_date ignored)');
select is(private.mp_cancel_targets(:'a'), '[]'::jsonb, 'A: nothing left for mp-cancel');
-- Repeats and late webhooks keep the grace.
select is(private.process_mp_preapproval(pg_temp.pre('PREGA1', :'coa', 'canceled'), :'expect') ->> 'code',
  'subscription_canceled', 'A: repeated canceled webhook');
select is(pg_temp.sub('PREGA1'), 'canceled:true:false', 'A: grace kept by the repeat');
select is(private.process_mp_preapproval(pg_temp.pre('PREGA1', :'coa', 'authorized'), :'expect') ->> 'code',
  'subscription_canceled', 'A: late authorized webhook does not revive it');
select is(private.process_mp_preapproval(pg_temp.pre('PREGA1', :'coa', 'paused'), :'expect') ->> 'code',
  'subscription_canceled', 'A: late paused webhook does not change it');
select is(pg_temp.sub('PREGA1'), 'canceled:true:false', 'A: grace kept by late webhooks');
select is(private.process_mp_payment(pg_temp.pay('95001'), pg_temp.pre('PREGA1', :'coa', 'canceled'), :'expect') ->> 'code',
  'already_credited', 'A: repeated payment webhook');
select is(pg_temp.sub('PREGA1'), 'canceled:true:false', 'A: grace kept by a repeated payment');
-- Then a full refund of that payment ends it: no grace.
select is(private.process_mp_payment(pg_temp.pay('95001', 'refunded', 4990), null, :'expect') ->> 'code',
  'reversed', 'A: full refund after the cancel');
select is(pg_temp.sub('PREGA1'), 'canceled:false:false', 'A: refund clears the grace');

-- ---------------------------------------------------------------------------
-- B: paid but the period already ended -> canceled without grace
-- ---------------------------------------------------------------------------
select pg_temp.active(:'b', 'PREGB1', '95101') as cob \gset
select tests.clear_authentication();
update public.subscriptions set current_period_end = now() - interval '1 day'
 where provider_subscription_id = 'PREGB1';
select tests.as_service_role();
select private.process_mp_preapproval(pg_temp.pre('PREGB1', :'cob', 'canceled'), :'expect') \gset ignore_
select is(pg_temp.sub('PREGB1'), 'canceled:false:false', 'B: period already over -> no grace');

-- ---------------------------------------------------------------------------
-- C: incomplete (never paid) and D: paused -> canceled, no grace
-- ---------------------------------------------------------------------------
select pg_temp.checkout(:'c', 'PREGC1') as coc \gset
select private.process_mp_preapproval(pg_temp.pre('PREGC1', :'coc'), :'expect') \gset ignore_
select is(private.mp_mark_cancel_requested(:'c', 'PREGC1') ->> 'code', 'marked', 'C: incomplete, requested');
select private.process_mp_preapproval(pg_temp.pre('PREGC1', :'coc', 'canceled'), :'expect') \gset ignore_
select is(pg_temp.sub('PREGC1'), 'canceled:false:false', 'C: incomplete -> canceled, no grace');

select pg_temp.active(:'d', 'PREGD1', '95301') as cod \gset
select is(private.process_mp_preapproval(pg_temp.pre('PREGD1', :'cod', 'paused'), :'expect') ->> 'code',
  'subscription_paused', 'D: paused');
select is(private.mp_mark_cancel_requested(:'d', 'PREGD1') ->> 'code', 'marked', 'D: paused, requested');
select is(pg_temp.sub('PREGD1'), 'paused:false:true', 'D: paused keeps the request (L1e)');
select private.process_mp_preapproval(pg_temp.pre('PREGD1', :'cod', 'canceled'), :'expect') \gset ignore_
select is(pg_temp.sub('PREGD1'), 'canceled:false:false',
  'D: paused -> canceled: no grace (paused was already on Free models), request cleared');

-- ---------------------------------------------------------------------------
-- E: refund of a live, cancel-requested subscription clears cancel_requested_at
-- ---------------------------------------------------------------------------
select pg_temp.active(:'e', 'PREGE1', '95401') as coe \gset
select is(private.mp_mark_cancel_requested(:'e', 'PREGE1') ->> 'code', 'marked', 'E: requested');
select is(pg_temp.sub('PREGE1'), 'active:false:true', 'E: live and requested');
select is(private.process_mp_payment(pg_temp.pay('95401', 'refunded', 4990), null, :'expect') ->> 'code',
  'reversed', 'E: full refund');
select is(pg_temp.sub('PREGE1'), 'canceled:false:false',
  'E: refund left the live set -> cancel_requested_at cleared, no grace');
-- A later reactivation (new approved payment on that preapproval) is clean.
select is(private.process_mp_payment(pg_temp.pay('95402'), pg_temp.pre('PREGE1', :'coe'), :'expect') ->> 'code',
  'credited', 'E: a later approved payment reactivates it');
select is(pg_temp.sub('PREGE1'), 'active:false:false',
  'E: reactivated: not "cancel requested", not ending');

-- ---------------------------------------------------------------------------
-- F: chargeback of a live, cancel-requested subscription
-- ---------------------------------------------------------------------------
select pg_temp.active(:'f', 'PREGF1', '95501') as cof \gset
select is(private.mp_mark_cancel_requested(:'f', 'PREGF1') ->> 'code', 'marked', 'F: requested');
select is(private.process_mp_payment(pg_temp.pay('95501', 'charged_back', 4990), null, :'expect') ->> 'code',
  'reversed', 'F: chargeback');
select is(pg_temp.sub('PREGF1'), 'blocked:false:false', 'F: blocked, cancel_requested_at cleared');
select is(private.process_mp_payment(pg_temp.pay('95502'), pg_temp.pre('PREGF1', :'cof'), :'expect') ->> 'code',
  'rejected_blocked', 'F: blocked never reactivates');
select is(pg_temp.sub('PREGF1'), 'blocked:false:false', 'F: still blocked, nothing requested');

-- ---------------------------------------------------------------------------
-- G: reactivation from the paid-until grace
-- ---------------------------------------------------------------------------
select pg_temp.active(:'g', 'PREGG1', '95601') as cog \gset
select private.process_mp_preapproval(pg_temp.pre('PREGG1', :'cog', 'canceled'), :'expect') \gset ignore_
select is(pg_temp.sub('PREGG1'), 'canceled:true:false', 'G: canceled, paid until period end');
select is(private.process_mp_payment(pg_temp.pay('95602'), pg_temp.pre('PREGG1', :'cog'), :'expect') ->> 'code',
  'credited', 'G: an approved payment on it reactivates the row');
select is(pg_temp.sub('PREGG1'), 'active:false:false', 'G: reactivated: no grace flag, no request');
select tests.clear_authentication();

-- Stripe rows: cancel_at_period_end keeps Stripe's meaning (untouched by L1g).
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status, cancel_at_period_end)
values (:'b', 'sub_l1g_b', 'starter', 'active', true);
select is((select cancel_at_period_end from public.subscriptions where stripe_subscription_id = 'sub_l1g_b'),
  true, 'Stripe cancel_at_period_end untouched');

select * from finish();
rollback;
