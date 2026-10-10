-- Free plan monthly renewal (private.renew_free_credits / _for_user, the shared
-- predicate private.free_renewal_check, the signup plan_allowance and the
-- backfill). Top up to 1000 once per period on the wallet's anniversary
-- (never reduce; a 0 top-up writes no ledger row but still advances
-- period_end), idempotent, in the ledger; skips paid / paused / blocked users
-- and (Debbie) users still in the L1g grace without touching their
-- plan_allowance; renews once the grace ended; ineligible users never take a
-- place in the batch limit.
-- now() is fixed inside this transaction, so time moves by back-dating rows.
begin;
set local search_path = public, extensions;
set local time zone 'UTC';
select no_plan();

\set expect '{"live_mode": false, "collector_id": "777"}'

-- balance:plan_allowance
create function pg_temp.wallet(p_user uuid) returns text language sql as $$
  select balance || ':' || plan_allowance from public.credit_wallets where user_id = p_user
$$;
grant execute on function pg_temp.wallet(uuid) to service_role;
create function pg_temp.period_end(p_user uuid) returns timestamptz language sql as $$
  select period_end from public.credit_wallets where user_id = p_user
$$;
grant execute on function pg_temp.period_end(uuid) to service_role;
-- renewal ledger amounts, oldest first ('' when none)
create function pg_temp.renewals(p_user uuid) returns text language sql as $$
  select coalesce(string_agg(amount::text, ',' order by id), '') from public.credit_transactions
   where user_id = p_user and idempotency_key like 'free-renewal:%'
$$;
grant execute on function pg_temp.renewals(uuid) to service_role;
create function pg_temp.renew(p_user uuid) returns text language sql as $$
  select private.renew_free_credits_for_user(p_user) ->> 'code'
$$;
grant execute on function pg_temp.renew(uuid) to service_role;
-- Back-date the Free initial grant (signup) by p_ago.
create function pg_temp.signed_up(p_user uuid, p_ago interval) returns void language plpgsql as $$
declare
  v_signed_up_at timestamptz := now() - p_ago;
begin
  update public.credit_transactions set created_at = v_signed_up_at
   where user_id = p_user and idempotency_key = 'free-initial:' || p_user::text;
  update public.credit_wallets set free_renewal_anchor = v_signed_up_at
   where user_id = p_user;
end;
$$;
create function pg_temp.set_wallet(p_user uuid, p_balance bigint, p_period_end timestamptz)
returns void language sql as $$
  update public.credit_wallets set balance = p_balance, period_end = p_period_end
   where user_id = p_user
$$;
create function pg_temp.pre(p_id text, p_ref uuid, p_status text default 'authorized')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'external_reference', p_ref::text,
    'collector_id', '777', 'amount_minor', 4990, 'currency', 'BRL',
    'next_payment_date', (now() + interval '20 days')::text)
$$;
grant execute on function pg_temp.pre(text, uuid, text) to service_role;
create function pg_temp.pay(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', 'approved', 'status_detail', null,
    'amount_minor', 4990, 'refunded_minor', 0, 'live_mode', false,
    'collector_id', '777', 'currency', 'BRL', 'external_reference', null)
$$;
grant execute on function pg_temp.pay(text) to service_role;
create function pg_temp.user_at(p_id uuid, p_email text, p_confirmed boolean default true)
returns uuid language sql as $$
  insert into auth.users (id, email, email_confirmed_at)
  values (p_id, p_email, case when p_confirmed then now() end) returning id
$$;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
            where oid in ('private.renew_free_credits(integer)'::regprocedure,
                          'private.renew_free_credits_for_user(uuid)'::regprocedure,
                          'private.free_renewal_check(uuid, timestamptz)'::regprocedure,
                          'private.backfill_free_plan_allowance()'::regprocedure,
                          'private.grant_free_initial_credits()'::regprocedure)),
  'renewal functions: SECURITY DEFINER, search_path=""');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) r (role),
          (values ('private.renew_free_credits(integer)'), ('private.renew_free_credits_for_user(uuid)'),
                  ('private.free_renewal_check(uuid, timestamptz)'),
                  ('private.backfill_free_plan_allowance()')) f (fn)
    where has_function_privilege(r.role, f.fn, 'execute')),
  0, 'renewal functions: no anon / authenticated EXECUTE');
select is(
  (select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid in ('private.renew_free_credits(integer)'::regprocedure,
                    'private.renew_free_credits_for_user(uuid)'::regprocedure,
                    'private.free_renewal_check(uuid, timestamptz)'::regprocedure,
                    'private.backfill_free_plan_allowance()'::regprocedure)
      and a.grantee = 0),
  0, 'renewal functions: no EXECUTE for PUBLIC');

-- The calendar schedule stays anchored to the original grant timestamp. In
-- particular, a clipped February boundary must not move later anniversaries
-- from the 31st to the 30th. These fixed dates cover leap and non-leap years.
select is(
  (select period_end from private.free_renewal_period(
    '2024-01-31 15:45:00+00'::timestamptz,
    '2024-02-29 15:45:00+00'::timestamptz)),
  '2024-03-31 15:45:00+00'::timestamptz,
  'Jan 31 anniversary advances from leap-day boundary to Mar 31');
select is(
  (select period_start from private.free_renewal_period(
    '2024-01-31 15:45:00+00'::timestamptz,
    '2024-03-30 15:45:00+00'::timestamptz)),
  '2024-02-29 15:45:00+00'::timestamptz,
  'the period before Mar 31 starts on leap day, not a drifted Mar 29');
select is(
  (select period_start from private.free_renewal_period(
    '2023-12-31 15:45:00+00'::timestamptz,
    '2024-02-28 15:45:00+00'::timestamptz)),
  '2024-01-31 15:45:00+00'::timestamptz,
  'Dec 31 anniversary stays Jan 31 before the leap-day renewal');
select is(
  (select period_end from private.free_renewal_period(
    '2025-01-31 15:45:00+00'::timestamptz,
    '2025-02-28 15:45:00+00'::timestamptz)),
  '2025-03-31 15:45:00+00'::timestamptz,
  'Jan 31 anniversary returns to Mar 31 after a non-leap February');
select is(
  private.free_renewal_canonical_end(
    '2024-01-31 15:45:00+00'::timestamptz,
    '2024-03-29 15:45:00+00'::timestamptz),
  '2024-03-31 15:45:00+00'::timestamptz,
  'rollout moves a drifted March 29 deadline to the next original boundary');
select is(
  private.free_renewal_canonical_end(
    '2024-01-31 15:45:00+00'::timestamptz,
    '2024-03-31 15:45:00+00'::timestamptz),
  '2024-03-31 15:45:00+00'::timestamptz,
  'rollout leaves an already canonical deadline unchanged');
select throws_ok(
  $$select * from private.free_renewal_period(null, now())$$,
  '22023', null, 'renewal period rejects a missing anchor');
select ok(not has_function_privilege('anon', 'private.free_renewal_period(timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'private.free_renewal_period(timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('service_role', 'private.free_renewal_period(timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'private.free_renewal_canonical_end(timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'private.free_renewal_canonical_end(timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('service_role', 'private.free_renewal_canonical_end(timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'private.infer_free_renewal_anchor(uuid, bigint, timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'private.infer_free_renewal_anchor(uuid, bigint, timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('service_role', 'private.infer_free_renewal_anchor(uuid, bigint, timestamptz, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'private.sync_free_renewal_anchor()', 'execute')
      and not has_function_privilege('authenticated', 'private.sync_free_renewal_anchor()', 'execute')
      and not has_function_privilege('service_role', 'private.sync_free_renewal_anchor()', 'execute'),
  'renewal period helper is internal only');

select ok(has_function_privilege('service_role', 'private.renew_free_credits(integer)', 'execute')
      and has_function_privilege('service_role', 'private.renew_free_credits_for_user(uuid)', 'execute'),
  'renewal RPCs: service_role');
select ok(not has_function_privilege('service_role', 'private.free_renewal_check(uuid, timestamptz)', 'execute')
      and not has_function_privilege('service_role', 'private.backfill_free_plan_allowance()', 'execute'),
  'predicate / backfill: not even service_role (internal / migration only)');

-- ---------------------------------------------------------------------------
-- Signup: plan_allowance = 1000 with the initial grant
-- ---------------------------------------------------------------------------
select tests.create_user('fr-new@example.com', true) as n \gset
select tests.create_user('fr-unconfirmed@example.com', false) as u \gset
select is(pg_temp.wallet(:'n'), '1000:1000', 'signup (confirmed): balance 1000, plan_allowance 1000');
select is(pg_temp.wallet(:'u'), '0:0', 'signup (unconfirmed): nothing yet');
select tests.create_user('fr-later@example.com', false) as l \gset
update auth.users set email_confirmed_at = now() where id = :'l';
select is(pg_temp.wallet(:'l'), '1000:1000', 'email confirmed later: balance 1000, plan_allowance 1000');

select tests.create_user('fr-a@example.com', true) as a \gset
select tests.create_user('fr-paid@example.com', true) as p \gset
select tests.create_user('fr-grace@example.com', true) as g \gset
select tests.create_user('fr-free-rows@example.com', true) as f \gset
select tests.create_user('fr-blocked@example.com', true) as b \gset

-- Everyone but N / L signed up 40 days ago (first renewal 10 days overdue).
select pg_temp.signed_up(:'a', '40 days');
select pg_temp.signed_up(:'p', '40 days');
select pg_temp.signed_up(:'g', '40 days');
select pg_temp.signed_up(:'f', '40 days');
select pg_temp.signed_up(:'b', '40 days');
select pg_temp.set_wallet(:'a', 0, null);
select pg_temp.set_wallet(:'f', 0, null);
select pg_temp.set_wallet(:'b', 0, null);

-- P: a paid subscription (any provider) in each live paid status, wallet period over.
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status, current_period_end)
values (:'p', 'sub_fr_paid', 'starter', 'active', now() + interval '20 days');
update public.credit_wallets set balance = 20000, plan_allowance = 20000,
       period_end = now() - interval '1 day' where user_id = :'p';
-- Synthetic paid invoice evidence for the historical-anchor inference test.
insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref, created_at)
values (:'p', 20000, 'renewal', 'invoice:test-paid-cycle', 'test-paid-cycle', now());

-- F: only Free-equivalent rows (incomplete MP, canceled MP without the flag, a canceled
-- Stripe row with Stripe's cancel_at_period_end): Free, renewed.
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'f', 'mercadopago', 'PREFRINC', 'starter', 'incomplete', false, null),
       (:'f', 'mercadopago', 'PREFRREF', 'starter', 'canceled', false, now() + interval '20 days');
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'f', 'sub_fr_free', 'starter', 'canceled', true, now() + interval '20 days');

-- B: a Mercado Pago chargeback (blocked): Free models, never new credits.
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'b', 'mercadopago', 'PREFRBLK', 'starter', 'blocked', false, now() + interval '20 days');

select tests.as_service_role();

-- Invalid arguments.
select throws_ok($$select private.renew_free_credits_for_user(null)$$, '22023', null,
  'null user -> 22023');
select throws_ok($$select private.renew_free_credits(0)$$, '22023', null, 'limit 0 -> 22023');

-- N: just signed up, the initial grant covers the first month.
select is(pg_temp.renew(:'n'), 'not_due', 'N: first month covered by the initial grant');
select is(pg_temp.wallet(:'n'), '1000:1000', 'N: unchanged');
-- U: unconfirmed email, no initial grant: never renewed.
select is(pg_temp.renew(:'u'), 'not_eligible', 'U: unconfirmed -> not_eligible');
select is(pg_temp.renew(gen_random_uuid()), 'no_wallet', 'unknown user -> no_wallet');
select is(pg_temp.renew(:'b'), 'blocked', 'B: blocked (chargeback) -> skipped');
select is(pg_temp.wallet(:'b'), '0:1000', 'B: no new credits');

-- G: a real Mercado Pago Starter subscription (paid), before the cancel.
select private.mp_create_checkout(:'g', 'starter') ->> 'checkout_id' as cog \gset
select private.mp_link_checkout(:'cog', 'PREFRG1',
  'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=PREFRG1') \gset ignore_
select private.process_mp_preapproval(pg_temp.pre('PREFRG1', :'cog'), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('97001'), pg_temp.pre('PREFRG1', :'cog'), :'expect') ->> 'code',
  'credited', 'G: paid Starter');
select is(pg_temp.wallet(:'g'), '21000:20000', 'G: 1000 Free + 20000 Starter, allowance 20000');

-- ---------------------------------------------------------------------------
-- The batch: only A and F are due and Free.
-- ---------------------------------------------------------------------------
select is(private.renew_free_credits(), 2, 'batch: A and F renewed (N/L not due; U/P/G/B skipped)');
select is(pg_temp.wallet(:'a'), '1000:1000', 'A: balance 0 -> topped up to 1000');
select is(pg_temp.renewals(:'a'), '1000', 'A: one ledger row of 1000');
select is(pg_temp.period_end(:'a'),
  (select created_at + interval '2 months' from public.credit_transactions
    where user_id = :'a' and idempotency_key = 'free-initial:' || :'a'),
  'A: period [signup + 1 month, signup + 2 months): period_end = signup + 2 months');
select is(
  (select kind || ':' || ref from public.credit_transactions
    where user_id = :'a' and idempotency_key like 'free-renewal:%'),
  'renewal:free-renewal', 'A: ledger kind renewal, ref free-renewal');
select is(pg_temp.wallet(:'f'), '1000:1000', 'F: incomplete / canceled without flag / canceled Stripe -> Free renewed');
select is(pg_temp.renewals(:'n') || pg_temp.renewals(:'u') || pg_temp.renewals(:'p')
          || pg_temp.renewals(:'g') || pg_temp.renewals(:'b'),
  '', 'batch: no renewal row for N / U / P / G / B');

-- Idempotent: the same period grants nothing again.
select is(private.renew_free_credits(), 0, 'batch re-run in the same period: nothing');
select is(pg_temp.renew(:'a'), 'not_due', 'A: re-run -> not_due');
select is(pg_temp.renewals(:'a'), '1000', 'A: still one ledger row');

-- The ledger key is a backstop: same period start again (period_end rewound) -> no 2nd grant.
select tests.clear_authentication();
update public.credit_wallets
   set balance = 0,
       period_end = (select created_at + interval '1 month' from public.credit_transactions
                      where user_id = :'a' and idempotency_key = 'free-initial:' || :'a')
 where user_id = :'a';
select tests.as_service_role();
select is(pg_temp.renew(:'a'), 'already_renewed', 'A: same period start -> already_renewed');
select is(pg_temp.wallet(:'a'), '0:1000', 'A: nothing granted twice for one period');
select is(pg_temp.renew(:'a'), 'not_due', 'A: period_end synced -> not_due');

-- Top-up amounts: 400 -> +600.
select tests.clear_authentication();
select pg_temp.set_wallet(:'a', 400, now() - interval '1 second');
select pg_temp.signed_up(:'a', '2 months');
select tests.as_service_role();
select is(private.renew_free_credits_for_user(:'a') - 'period_end' - 'balance',
  '{"code": "renewed", "amount": 600}'::jsonb, 'A: balance 400 -> renewed, +600');
select is(pg_temp.wallet(:'a'), '1000:1000', 'A: 400 + 600 = 1000');
select is(pg_temp.renewals(:'a'), '1000,600', 'A: ledger row of 600');
select ok(pg_temp.period_end(:'a') between now() + interval '27 days' and now() + interval '1 month',
  'A: next period_end one month after the previous one');
select is(pg_temp.renew(:'a'), 'not_due', 'A: then not_due in the same period');

-- Debbie: 1500 -> 0 granted, no ledger row, period_end still advances, then not_due.
select tests.clear_authentication();
select pg_temp.set_wallet(:'a', 1500, now() - interval '1 second');
select pg_temp.signed_up(:'a', '2 months 1 day');
select tests.as_service_role();
select is(private.renew_free_credits_for_user(:'a') - 'period_end' - 'balance',
  '{"code": "renewed_zero", "amount": 0}'::jsonb, 'A: balance 1500 -> renewed_zero, 0 granted');
select is(pg_temp.wallet(:'a'), '1500:1000', 'A: balance kept (never reduced)');
select is(pg_temp.renewals(:'a'), '1000,600', 'A: no ledger row for a 0 top-up');
select ok(pg_temp.period_end(:'a') between now() + interval '27 days' and now() + interval '1 month',
  'A: period_end advanced anyway');
select is(pg_temp.renew(:'a'), 'not_due', 'A: next run -> not_due');
select is(private.renew_free_credits(), 0, 'A: and the batch does not pick it again');

-- A long gap (100 days) from 0: one top-up, no back-fill; period_end the next anniversary.
select tests.clear_authentication();
select pg_temp.set_wallet(:'a', 0, now() - interval '100 days');
select pg_temp.signed_up(:'a', '100 days');
select tests.as_service_role();
select is(pg_temp.renew(:'a'), 'renewed', 'A: after a gap -> renewed once');
select is(pg_temp.wallet(:'a'), '1000:1000', 'A: topped up to 1000 only (no back-fill)');
select ok(pg_temp.period_end(:'a') > now() and pg_temp.period_end(:'a') <= now() + interval '1 month',
  'A: period_end is the next anniversary in the future');
select is(pg_temp.renew(:'a'), 'not_due', 'A: and then not due');

-- ---------------------------------------------------------------------------
-- P: every live paid status is skipped (also paused), allowance untouched.
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
do $$
declare v_status text; v_code text; v_user uuid;
begin
  select id into v_user from auth.users where email = 'fr-paid@example.com';
  foreach v_status in array array['active', 'trialing', 'past_due', 'unpaid', 'paused'] loop
    update public.subscriptions set status = v_status where stripe_subscription_id = 'sub_fr_paid';
    v_code := private.renew_free_credits_for_user(v_user) ->> 'code';
    if v_code <> 'paid' then
      raise exception 'status % -> %', v_status, v_code;
    end if;
  end loop;
end $$;
select pass('P: active / trialing / past_due / unpaid / paused -> paid (each checked)');
select is(pg_temp.wallet(:'p'), '20000:20000', 'P: paid wallet and plan_allowance untouched');
select is(pg_temp.renewals(:'p'), '', 'P: no renewal row');
-- The paid subscription ends (Stripe canceled): Free from the next run.
update public.subscriptions set status = 'canceled' where stripe_subscription_id = 'sub_fr_paid';
select is(
  private.infer_free_renewal_anchor(
    :'p', 1000, now() + interval '30 days', now() - interval '200 days'),
  now() + interval '30 days',
  'unlinked Stripe payment preserves the existing wallet deadline');
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  current_period_end)
values (:'a', 'mercadopago', 'PREFRUNPAID', 'starter', 'canceled',
        '2024-02-28 15:45:00+00'::timestamptz);
select is(
  private.infer_free_renewal_anchor(
    :'a', 1000, '2024-02-29 15:45:00+00'::timestamptz,
    '2024-01-31 15:45:00+00'::timestamptz),
  '2024-01-31 15:45:00+00'::timestamptz,
  'canceled but uncredited preapproval does not shift a Free-only user');
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status,
                                  current_period_start, current_period_end)
values (:'a', 'sub_fr_unpaid_stripe', 'starter', 'canceled',
        '2024-03-01 15:45:00+00'::timestamptz, '2024-03-31 15:45:00+00'::timestamptz);
insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref, created_at)
values (:'a', 20000, 'renewal', 'invoice:other-cycle', 'other-cycle',
        '2024-03-02 15:45:00+00'::timestamptz);
select is(
  private.infer_free_renewal_anchor(
    :'a', 1000, '2024-05-31 15:45:00+00'::timestamptz,
    '2024-01-31 15:45:00+00'::timestamptz),
  '2024-05-31 15:45:00+00'::timestamptz,
  'unattributed Stripe invoice preserves the wallet deadline, not a subscription end');
insert into public.billing_checkouts (user_id, provider, plan, currency, amount_minor, status, provider_ref)
values (:'a', 'mercadopago', 'starter', 'BRL', 4990, 'active', 'PREPAID')
returning id as paid_checkout \gset
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  current_period_start, current_period_end)
values (:'a', 'mercadopago', 'PREPAID', 'starter', 'canceled',
        '2024-03-31 15:45:00+00'::timestamptz, '2024-04-30 15:45:00+00'::timestamptz);
insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref, created_at)
values (:'a', 20000, 'renewal', 'mp:payment:98001', '98001',
        '2024-03-31 15:45:00+00'::timestamptz)
returning id as paid_tx \gset
insert into public.mp_payments (payment_id, user_id, checkout_id, preapproval_id, status,
                                amount_minor, currency, credited_tx, credited_amount)
values (98001, :'a', :'paid_checkout', 'PREPAID', 'approved', 4990, 'BRL', :'paid_tx', 20000);
select is(
  private.infer_free_renewal_anchor(
    :'a', 1000, '2024-05-31 15:45:00+00'::timestamptz,
    '2024-01-31 15:45:00+00'::timestamptz),
  '2024-04-30 15:45:00+00'::timestamptz,
  'credited Mercado Pago payment keeps the historical paid-period anchor');
select tests.as_service_role();
select is(pg_temp.renew(:'p'), 'renewed_zero', 'P: after the paid subscription ended -> renewed (0: 20000 >= 1000)');
select is(pg_temp.wallet(:'p'), '20000:1000', 'P: paid credits kept, allowance back to Free');
select is(pg_temp.period_end(:'p'), now() - interval '1 day' + interval '1 month',
  'P: first Free boundary follows the paid period end');
select is((select free_renewal_anchor from public.credit_wallets where user_id = :'p'),
  now() - interval '1 day', 'P: paid period end is persisted as the Free schedule anchor');
select is(pg_temp.renewals(:'p'), '', 'P: no ledger row for the 0 top-up');
select tests.clear_authentication();
select pg_temp.set_wallet(:'p', 20000, now() - interval '1 second');
select tests.as_service_role();
select is(pg_temp.renew(:'p'), 'renewed_zero', 'P: the persisted schedule anchor survives later Free periods');
select is(pg_temp.period_end(:'p'), now() - interval '1 day' + interval '1 month',
  'P: later Free boundary does not jump back to the signup anniversary');

-- ---------------------------------------------------------------------------
-- G (Debbie): cancelled in Mercado Pago but paid until current_period_end (L1g grace).
-- ---------------------------------------------------------------------------
select is(private.mp_mark_cancel_requested(:'g', 'PREFRG1') ->> 'code', 'marked', 'G: cancel requested');
select private.process_mp_preapproval(pg_temp.pre('PREFRG1', :'cog', 'canceled'), :'expect') \gset ignore_
select is((select status || ':' || cancel_at_period_end from public.subscriptions
            where provider_subscription_id = 'PREFRG1'), 'canceled:true', 'G: canceled, in grace');
-- Even with the wallet's own period over and a low balance, the grace wins.
select tests.clear_authentication();
select pg_temp.set_wallet(:'g', 300, now() - interval '1 second');
select tests.as_service_role();
select is(pg_temp.renew(:'g'), 'grace', 'G: in grace -> skipped');
select is(private.renew_free_credits(), 0, 'G: the batch skips it too');
select is(pg_temp.wallet(:'g'), '300:20000', 'G: plan_allowance NOT downgraded during the grace, nothing granted');
select is(pg_temp.renewals(:'g'), '', 'G: no renewal row during the grace');
-- The grace ends: Free renewal from the next run.
select tests.clear_authentication();
update public.subscriptions set current_period_end = now() - interval '1 second'
 where provider_subscription_id = 'PREFRG1';
select tests.as_service_role();
select is(private.renew_free_credits(), 1, 'G: after the grace -> the batch renews it');
select is(pg_temp.wallet(:'g'), '1000:1000', 'G: 300 + 700, allowance Free');
select is(pg_temp.renew(:'g'), 'not_due', 'G: then not due');

-- B: blocked stays blocked, also later.
select is(pg_temp.renew(:'b'), 'blocked', 'B: still blocked');
select is(pg_temp.wallet(:'b') || '|' || pg_temp.renewals(:'b'), '0:1000|', 'B: never renewed');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Debbie: ineligible-but-due users never take a place in the batch limit.
-- Low user ids (ordered first): 3 blocked, 1 unconfirmed, 1 paid, 1 in grace,
-- all with an overdue period and balance 0; then one normal Free user.
-- ---------------------------------------------------------------------------
select pg_temp.user_at('00000000-0000-4000-8000-000000000001', 'fr-s1@example.com') \gset ignore_
select pg_temp.user_at('00000000-0000-4000-8000-000000000002', 'fr-s2@example.com') \gset ignore_
select pg_temp.user_at('00000000-0000-4000-8000-000000000003', 'fr-s3@example.com') \gset ignore_
select pg_temp.user_at('00000000-0000-4000-8000-000000000004', 'fr-s4@example.com', false) \gset ignore_
select pg_temp.user_at('00000000-0000-4000-8000-000000000005', 'fr-s5@example.com') \gset ignore_
select pg_temp.user_at('00000000-0000-4000-8000-000000000006', 'fr-s6@example.com') \gset ignore_
select pg_temp.user_at('ffffffff-ffff-4fff-bfff-fffffffffff1', 'fr-s-free@example.com') as s_free \gset
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values ('00000000-0000-4000-8000-000000000001', 'mercadopago', 'PRESB1', 'starter', 'blocked', false, null),
       ('00000000-0000-4000-8000-000000000002', 'mercadopago', 'PRESB2', 'starter', 'blocked', false, null),
       ('00000000-0000-4000-8000-000000000003', 'mercadopago', 'PRESB3', 'starter', 'blocked', false, null),
       ('00000000-0000-4000-8000-000000000005', 'mercadopago', 'PRESB5', 'starter', 'active', false,
        now() + interval '20 days'),
       ('00000000-0000-4000-8000-000000000006', 'mercadopago', 'PRESB6', 'starter', 'canceled', true,
        now() + interval '20 days');
update public.credit_wallets set balance = 0, period_end = now() - interval '1 day'
 where user_id::text like '00000000-0000-4000-8000-00000000000%'
    or user_id = :'s_free';
select tests.as_service_role();
select is(private.renew_free_credits(2), 1, 'batch limit 2: the normal Free user renews despite 6 ineligible due users before it');
select is(pg_temp.wallet(:'s_free'), '1000:1000', 'the normal Free user got 1000');
select is(
  (select count(*)::int from public.credit_transactions
    where user_id::text like '00000000-0000-4000-8000-00000000000%' and idempotency_key like 'free-renewal:%'),
  0, 'none of the ineligible users renewed');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Backfill: plan_allowance only, only Free wallets at 0, idempotent.
-- ---------------------------------------------------------------------------
-- Put some wallets back to plan_allowance 0: Free (A, F), paid (P5), grace (P6), blocked (B),
-- unconfirmed (U, already 0).
update public.credit_wallets set plan_allowance = 0
 where user_id in (:'a', :'f', :'b', '00000000-0000-4000-8000-000000000005',
                   '00000000-0000-4000-8000-000000000006');
create temp table fr_before as
  select w.user_id, w.balance, w.plan_allowance, w.period_end from public.credit_wallets w;
create temp table fr_ledger as select count(*) as n from public.credit_transactions;
select is(private.backfill_free_plan_allowance(), 2, 'backfill: the two Free wallets at 0 (A, F)');
select is(pg_temp.wallet(:'a') || ',' || pg_temp.wallet(:'f'), '1000:1000,1000:1000',
  'backfill: A and F plan_allowance 1000, balances unchanged');
select is(
  (select string_agg(w.plan_allowance::text, ',' order by w.user_id) from public.credit_wallets w
    where w.user_id in (:'u', :'b', '00000000-0000-4000-8000-000000000005',
                        '00000000-0000-4000-8000-000000000006')),
  '0,0,0,0', 'backfill: paid / grace / blocked / unconfirmed wallets untouched');
select is(
  (select count(*)::int from public.credit_wallets w join fr_before b using (user_id)
    where w.balance <> b.balance or w.period_end is distinct from b.period_end),
  0, 'backfill: no balance or period_end changed');
select is((select count(*) from public.credit_transactions), (select n from fr_ledger),
  'backfill: no ledger row');
select is(private.backfill_free_plan_allowance(), 0, 'backfill: idempotent (second run touches nothing)');

-- The Free plan credits come from plans.monthly_credits at renewal time.
select pg_temp.set_wallet(:'f', 0, now() - interval '1 second');
update public.plans set monthly_credits = 0 where plan = 'free';
select tests.as_service_role();
select is(pg_temp.renew(:'f'), 'no_free_credits', 'free plan with 0 credits -> nothing');
select is(private.renew_free_credits(), 0, 'and the batch selects nobody');
select is(pg_temp.wallet(:'f'), '0:1000', 'F: unchanged');
select tests.clear_authentication();

select * from finish();
rollback;
