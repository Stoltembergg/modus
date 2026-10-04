-- Free plan monthly renewal (private.renew_free_credits / _for_user): once per
-- period on the wallet's anniversary, idempotent, top-up (credits kept), in
-- the ledger; skips paid / paused users and (Debbie) users still in the L1g
-- grace without touching their plan_allowance; renews once the grace ended.
-- now() is fixed inside this transaction, so time moves by back-dating rows.
begin;
set local search_path = public, extensions;
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
create function pg_temp.renewals(p_user uuid) returns int language sql as $$
  select count(*)::int from public.credit_transactions
   where user_id = p_user and idempotency_key like 'free-renewal:%'
$$;
grant execute on function pg_temp.renewals(uuid) to service_role;
create function pg_temp.renew(p_user uuid) returns text language sql as $$
  select private.renew_free_credits_for_user(p_user) ->> 'code'
$$;
grant execute on function pg_temp.renew(uuid) to service_role;
-- Back-date the Free initial grant (signup) by p_ago.
create function pg_temp.signed_up(p_user uuid, p_ago interval) returns void language sql as $$
  update public.credit_transactions set created_at = now() - p_ago
   where user_id = p_user and idempotency_key = 'free-initial:' || p_user::text
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

-- Security.
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
            where oid in ('private.renew_free_credits(integer)'::regprocedure,
                          'private.renew_free_credits_for_user(uuid)'::regprocedure)),
  'renewal functions: SECURITY DEFINER, search_path=""');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) r (role),
          (values ('private.renew_free_credits(integer)'), ('private.renew_free_credits_for_user(uuid)')) f (fn)
    where has_function_privilege(r.role, f.fn, 'execute')),
  0, 'renewal functions: no anon / authenticated EXECUTE');
select is(
  (select count(*)::int from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid in ('private.renew_free_credits(integer)'::regprocedure,
                    'private.renew_free_credits_for_user(uuid)'::regprocedure)
      and a.grantee = 0),
  0, 'renewal functions: no EXECUTE for PUBLIC');
select ok(has_function_privilege('service_role', 'private.renew_free_credits(integer)', 'execute')
      and has_function_privilege('service_role', 'private.renew_free_credits_for_user(uuid)', 'execute'),
  'renewal functions: service_role');

select tests.create_user('fr-new@example.com', true) as n \gset
select tests.create_user('fr-a@example.com', true) as a \gset
select tests.create_user('fr-unconfirmed@example.com', false) as u \gset
select tests.create_user('fr-paid@example.com', true) as p \gset
select tests.create_user('fr-grace@example.com', true) as g \gset
select tests.create_user('fr-free-rows@example.com', true) as f \gset

-- Everyone but N signed up 40 days ago (A's first renewal is 10 days overdue).
select pg_temp.signed_up(:'a', '40 days');
select pg_temp.signed_up(:'p', '40 days');
select pg_temp.signed_up(:'g', '40 days');
select pg_temp.signed_up(:'f', '40 days');
update public.credit_wallets set period_end = null where user_id in (:'a', :'p', :'f');

-- P: a paid subscription (any provider) in each live paid status, wallet period over.
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status, current_period_end)
values (:'p', 'sub_fr_paid', 'starter', 'active', now() + interval '20 days');
update public.credit_wallets set balance = 20000, plan_allowance = 20000,
       period_end = now() - interval '1 day' where user_id = :'p';

-- F: only Free-equivalent rows (incomplete MP, canceled MP without the flag, a canceled
-- Stripe row with Stripe's cancel_at_period_end): Free, renewed.
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'f', 'mercadopago', 'PREFRINC', 'starter', 'incomplete', false, null),
       (:'f', 'mercadopago', 'PREFRREF', 'starter', 'canceled', false, now() + interval '20 days');
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status,
                                  cancel_at_period_end, current_period_end)
values (:'f', 'sub_fr_free', 'starter', 'canceled', true, now() + interval '20 days');

select tests.as_service_role();

-- Invalid arguments.
select throws_ok($$select private.renew_free_credits_for_user(null)$$, '22023', null,
  'null user -> 22023');
select throws_ok($$select private.renew_free_credits(0)$$, '22023', null, 'limit 0 -> 22023');

-- N: just signed up, the initial grant covers the first month.
select is(pg_temp.renew(:'n'), 'not_due', 'N: first month covered by the initial grant');
select is(pg_temp.wallet(:'n'), '1000:0', 'N: unchanged');
-- U: unconfirmed email, no initial grant: never renewed.
select is(pg_temp.renew(:'u'), 'not_eligible', 'U: unconfirmed -> not_eligible');
select is(pg_temp.renew(gen_random_uuid()), 'no_wallet', 'unknown user -> no_wallet');

-- G: a real Mercado Pago Starter subscription (paid), before the cancel.
select private.mp_create_checkout(:'g', 'starter') ->> 'checkout_id' as cog \gset
select private.mp_link_checkout(:'cog', 'PREFRG1',
  'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=PREFRG1') \gset ignore_
select private.process_mp_preapproval(pg_temp.pre('PREFRG1', :'cog'), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('97001'), pg_temp.pre('PREFRG1', :'cog'), :'expect') ->> 'code',
  'credited', 'G: paid Starter');
select is(pg_temp.wallet(:'g'), '21000:20000', 'G: 1000 Free + 20000 Starter, allowance 20000');

-- The batch: only A and F are due and Free.
select is(private.renew_free_credits(), 2, 'batch: A and F renewed (N not due, U/P/G skipped)');
select is(pg_temp.wallet(:'a'), '2000:1000', 'A: +1000 on top of the balance, allowance 1000');
select is(pg_temp.period_end(:'a'),
  (select created_at + interval '2 months' from public.credit_transactions
    where user_id = :'a' and idempotency_key = 'free-initial:' || :'a'),
  'A: period [signup + 1 month, signup + 2 months): period_end advanced to signup + 2 months');
select is(
  (select kind || ':' || amount || ':' || ref from public.credit_transactions
    where user_id = :'a' and idempotency_key like 'free-renewal:%'),
  'renewal:1000:free-renewal', 'A: ledger row kind renewal, +1000, ref free-renewal');
select is(pg_temp.wallet(:'f'), '2000:1000', 'F: incomplete / canceled without flag / canceled Stripe -> Free renewed');
select is(pg_temp.renewals(:'n') + pg_temp.renewals(:'u') + pg_temp.renewals(:'p') + pg_temp.renewals(:'g'),
  0, 'batch: no renewal row for N / U / P / G');

-- Idempotent: the same period grants nothing again.
select is(private.renew_free_credits(), 0, 'batch re-run in the same period: nothing');
select is(pg_temp.renew(:'a'), 'not_due', 'A: re-run -> not_due');
select is(pg_temp.wallet(:'a'), '2000:1000', 'A: balance unchanged');
select is(pg_temp.renewals(:'a'), 1, 'A: one ledger row');

-- The ledger key is a backstop: same period start again (period_end rewound) -> no 2nd grant.
select tests.clear_authentication();
update public.credit_wallets
   set period_end = (select created_at + interval '1 month' from public.credit_transactions
                      where user_id = :'a' and idempotency_key = 'free-initial:' || :'a')
 where user_id = :'a';
select tests.as_service_role();
select is(pg_temp.renew(:'a'), 'already_renewed', 'A: same period start -> already_renewed');
select is(pg_temp.wallet(:'a'), '2000:1000', 'A: still 2000');

-- Next month: spent some, leftover kept (top-up, no reset).
select tests.clear_authentication();
update public.credit_wallets set balance = 300, period_end = now() - interval '1 second'
 where user_id = :'a';
select tests.as_service_role();
select is(pg_temp.renew(:'a'), 'renewed', 'A: next month -> renewed');
select is(pg_temp.wallet(:'a'), '1300:1000', 'A: 300 left + 1000');
select ok(pg_temp.period_end(:'a') between now() + interval '27 days' and now() + interval '1 month',
  'A: next period_end one month after the previous one');
select is(pg_temp.renewals(:'a'), 2, 'A: two renewal rows');

-- A long gap (100 days): one grant, no back-fill; period_end the first future anniversary.
select tests.clear_authentication();
update public.credit_wallets set period_end = now() - interval '100 days' where user_id = :'a';
select tests.as_service_role();
select is(pg_temp.renew(:'a'), 'renewed', 'A: after a gap -> renewed once');
select is(pg_temp.wallet(:'a'), '2300:1000', 'A: +1000 only (no back-fill)');
select ok(pg_temp.period_end(:'a') > now() and pg_temp.period_end(:'a') <= now() + interval '1 month',
  'A: period_end is the next anniversary in the future');
select is(pg_temp.renew(:'a'), 'not_due', 'A: and then not due');

-- P: every live paid status is skipped (also paused), allowance untouched.
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
select is(pg_temp.renewals(:'p'), 0, 'P: no renewal row');
-- The paid subscription ends (Stripe canceled): Free from the next run.
update public.subscriptions set status = 'canceled' where stripe_subscription_id = 'sub_fr_paid';
select tests.as_service_role();
select is(pg_temp.renew(:'p'), 'renewed', 'P: after the paid subscription ended -> renewed');
select is(pg_temp.wallet(:'p'), '21000:1000', 'P: paid credits kept + 1000, allowance back to Free');

-- G (Debbie): cancelled in Mercado Pago but paid until current_period_end (L1g grace).
select is(private.mp_mark_cancel_requested(:'g', 'PREFRG1') ->> 'code', 'marked', 'G: cancel requested');
select private.process_mp_preapproval(pg_temp.pre('PREFRG1', :'cog', 'canceled'), :'expect') \gset ignore_
select is((select status || ':' || cancel_at_period_end from public.subscriptions
            where provider_subscription_id = 'PREFRG1'), 'canceled:true', 'G: canceled, in grace');
-- Even with the wallet's own period over, the grace wins.
select tests.clear_authentication();
update public.credit_wallets set period_end = now() - interval '1 second' where user_id = :'g';
select tests.as_service_role();
select is(pg_temp.renew(:'g'), 'grace', 'G: in grace -> skipped');
select is(private.renew_free_credits(), 0, 'G: the batch skips it too');
select is(pg_temp.wallet(:'g'), '21000:20000', 'G: plan_allowance NOT downgraded during the grace, balance kept');
select is(pg_temp.renewals(:'g'), 0, 'G: no renewal row during the grace');
-- The grace ends: Free renewal from the next run.
select tests.clear_authentication();
update public.subscriptions set current_period_end = now() - interval '1 second'
 where provider_subscription_id = 'PREFRG1';
select tests.as_service_role();
select is(private.renew_free_credits(), 1, 'G: after the grace -> the batch renews it');
select is(pg_temp.wallet(:'g'), '22000:1000', 'G: leftover kept + 1000, allowance Free');
select is(pg_temp.renew(:'g'), 'not_due', 'G: then not due');

-- The Free plan credits come from plans.monthly_credits at renewal time.
select tests.clear_authentication();
update public.credit_wallets set period_end = now() - interval '1 second' where user_id = :'f';
update public.plans set monthly_credits = 0 where plan = 'free';
select tests.as_service_role();
select is(pg_temp.renew(:'f'), 'no_free_credits', 'free plan with 0 credits -> nothing');
select is(pg_temp.wallet(:'f'), '2000:1000', 'F: unchanged');
select tests.clear_authentication();

select * from finish();
rollback;
