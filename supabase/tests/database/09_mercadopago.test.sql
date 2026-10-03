-- B6a: Mercado Pago. Tables closed to clients, private RPCs service_role only,
-- checkout record (reuse / supersede / frozen price), preapproval states
-- (authorized -> incomplete; active only on the first approved payment),
-- credit once per payment id, live_mode / collector / currency / amount /
-- reference checks, cumulative proportional reversal (never above the
-- credit, never a negative balance), block policy, one live subscription per
-- user across Stripe + Mercado Pago, and delivery dedupe that reprocesses
-- after a failure.
begin;
set local search_path = public, extensions;
select no_plan();

select tests.create_user('mp-a@example.com', true) as a \gset
select tests.create_user('mp-b@example.com', true) as b \gset
select tests.create_user('mp-c@example.com', true) as c \gset
select tests.create_user('mp-d@example.com', true) as d \gset
select tests.create_user('mp-e@example.com', true) as e \gset

\set expect '{"live_mode": false, "collector_id": "777"}'

create function pg_temp.balance(p_user uuid) returns bigint
language sql as $$ select balance from public.credit_wallets where user_id = p_user $$;
grant execute on function pg_temp.balance(uuid) to service_role;
create function pg_temp.pre(p_id text, p_ref text, p_status text default 'authorized',
                            p_amount bigint default 10990, p_collector text default '777',
                            p_currency text default 'BRL')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'external_reference', p_ref,
    'collector_id', p_collector, 'amount_minor', p_amount, 'currency', p_currency,
    'next_payment_date', '2026-11-03T10:00:00.000-03:00')
$$;
grant execute on function pg_temp.pre(text, text, text, bigint, text, text) to service_role;
create function pg_temp.pay(p_id text, p_status text, p_amount bigint default 10990,
                            p_refunded bigint default 0, p_live boolean default false,
                            p_collector text default '777', p_currency text default 'BRL',
                            p_ref text default null)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'status_detail', null,
    'amount_minor', p_amount, 'refunded_minor', p_refunded, 'live_mode', p_live,
    'collector_id', p_collector, 'currency', p_currency, 'external_reference', p_ref)
$$;
grant execute on function pg_temp.pay(text, text, bigint, bigint, boolean, text, text, text) to service_role;
-- New linked checkout for (user, plan) with preapproval p_pre_id; returns the checkout id.
create function pg_temp.checkout(p_user uuid, p_plan text, p_pre_id text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  v_id := (private.mp_create_checkout(p_user, p_plan) ->> 'checkout_id')::uuid;
  perform private.mp_link_checkout(v_id, p_pre_id, 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=' || p_pre_id);
  return v_id;
end $$;
grant execute on function pg_temp.checkout(uuid, text, text) to service_role;
create function pg_temp.sub_status(p_pre text) returns text
language sql as $$
  select status from public.subscriptions where provider = 'mercadopago' and provider_subscription_id = p_pre
$$;
grant execute on function pg_temp.sub_status(text) to service_role;

-- ---------------------------------------------------------------------------
-- Schema, RLS and privileges
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('plan_prices', 'billing_checkouts', 'mp_notifications', 'mp_payments')
      and c.relrowsecurity),
  4, 'RLS on plan_prices, billing_checkouts, mp_notifications, mp_payments');
select is((select count(*)::int from pg_policies
            where tablename in ('plan_prices', 'billing_checkouts', 'mp_notifications', 'mp_payments')),
  0, 'no policy on the B6a tables (no client access)');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) r (role),
          (values ('select'), ('insert'), ('update'), ('delete')) p (priv),
          (values ('public.plan_prices'), ('public.billing_checkouts'), ('public.mp_notifications'),
                  ('public.mp_payments')) t (tbl)
    where has_table_privilege(r.role, t.tbl, p.priv)),
  0, 'anon / authenticated: no privilege on the B6a tables');
select ok(has_table_privilege('service_role', 'public.mp_payments', 'insert'), 'service_role writes mp_payments');

select is(
  (select string_agg(plan || '=' || amount_minor, ',' order by amount_minor) from public.plan_prices
    where provider = 'mercadopago' and currency = 'BRL'),
  'starter=4990,pro=10990,max=26990,ultra=53990', 'BRL prices seeded (amount_minor)');
select is(
  (select string_agg(plan || '=' || monthly_credits, ',' order by sort_order) from public.plans),
  'free=1000,starter=10000,pro=25000,max=70000,ultra=150000', 'monthly credits unchanged');
select ok(
  (select indisunique and pg_get_expr(indpred, indrelid) like '%active%'
          and pg_get_expr(indpred, indrelid) not like '%incomplete%'
     from pg_index where indexrelid = 'public.subscriptions_one_live_per_user'::regclass),
  'partial UNIQUE index: one live subscription per user, incomplete excluded');

select tests.as_anon();
select throws_ok(format($q$select private.mp_create_checkout(%L, 'pro')$q$, :'a'), '42501', null,
  'anon: mp_create_checkout denied');
select throws_ok($q$select private.mp_link_checkout(gen_random_uuid(), 'x', 'https://x')$q$, '42501', null,
  'anon: mp_link_checkout denied');
select throws_ok($q$select private.mp_claim_notification('r', 't', '1')$q$, '42501', null,
  'anon: mp_claim_notification denied');
select throws_ok($q$select private.mp_finish_notification('r', 'x')$q$, '42501', null,
  'anon: mp_finish_notification denied');
select throws_ok($q$select private.process_mp_preapproval('{}', '{}')$q$, '42501', null,
  'anon: process_mp_preapproval denied');
select throws_ok($q$select private.process_mp_payment('{}', null, '{}')$q$, '42501', null,
  'anon: process_mp_payment denied');
select throws_ok(format($q$select private.debit_credits(%L, 1, 'k')$q$, :'a'), '42501', null,
  'anon: debit_credits denied');
select tests.clear_authentication();
select tests.authenticate_as(:'a');
select throws_ok(format($q$select private.mp_create_checkout(%L, 'pro')$q$, :'a'), '42501', null,
  'authenticated: mp_create_checkout denied');
select throws_ok($q$select private.mp_link_checkout(gen_random_uuid(), 'x', 'https://x')$q$, '42501', null,
  'authenticated: mp_link_checkout denied');
select throws_ok($q$select private.mp_claim_notification('r', 't', '1')$q$, '42501', null,
  'authenticated: mp_claim_notification denied');
select throws_ok($q$select private.mp_finish_notification('r', 'x')$q$, '42501', null,
  'authenticated: mp_finish_notification denied');
select throws_ok($q$select private.process_mp_preapproval('{}', '{}')$q$, '42501', null,
  'authenticated: process_mp_preapproval denied');
select throws_ok($q$select private.process_mp_payment('{}', null, '{}')$q$, '42501', null,
  'authenticated: process_mp_payment denied');
select throws_ok(format($q$select private.debit_credits(%L, 1, 'k')$q$, :'a'), '42501', null,
  'authenticated: debit_credits denied');
select throws_ok('select * from public.billing_checkouts', '42501', null, 'authenticated: billing_checkouts denied');
select throws_ok('select * from public.mp_payments', '42501', null, 'authenticated: mp_payments denied');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Checkout record: create, reuse the open one, supersede on another plan
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select private.mp_create_checkout(:'a', 'starter') as co1 \gset
select is((:'co1'::jsonb) ->> 'code', 'created', 'checkout created');
select is((:'co1'::jsonb) ->> 'amount_minor', '4990', 'amount from plan_prices (server), BRL');
select is(private.mp_create_checkout(:'a', 'starter') ->> 'checkout_id', (:'co1'::jsonb) ->> 'checkout_id',
  'second call for the same plan reuses the open checkout');
select private.mp_create_checkout(:'a', 'pro') as co2 \gset
select isnt((:'co2'::jsonb) ->> 'checkout_id', (:'co1'::jsonb) ->> 'checkout_id', 'another plan: new checkout');
select is((select status from public.billing_checkouts where id = ((:'co1'::jsonb) ->> 'checkout_id')::uuid),
  'superseded', 'the previous open checkout is superseded');
select is((select count(*)::int from public.billing_checkouts where user_id = :'a' and status = 'created'), 1,
  'one open checkout per user');
select is(private.mp_create_checkout(:'a', 'free') ->> 'code', 'unknown_plan', 'free is not purchasable');
select is(private.mp_create_checkout(:'a', 'nope') ->> 'code', 'unknown_plan', 'unknown plan');
select (:'co2'::jsonb) ->> 'checkout_id' as co2id \gset
select is(private.mp_link_checkout(:'co2id', 'PREA1', 'https://www.mercadopago.com.br/x') ->> 'code', 'linked', 'linked');
select is(private.mp_link_checkout(:'co2id', 'PREA1', 'https://www.mercadopago.com.br/x') ->> 'code', 'already_linked',
  'same preapproval again: already_linked');
select is(private.mp_link_checkout(:'co2id', 'PREOTHER', 'https://www.mercadopago.com.br/y') ->> 'code', 'conflict',
  'another preapproval on a linked checkout: conflict');
select is(private.mp_create_checkout(:'a', 'pro') ->> 'checkout_url', 'https://www.mercadopago.com.br/x',
  'reused checkout returns the stored init_point (no second preapproval)');

-- Frozen price: changing plan_prices after the checkout does not reject this subscriber.
update public.plan_prices set amount_minor = 99999 where plan = 'pro' and provider = 'mercadopago';

-- ---------------------------------------------------------------------------
-- Preapproval: checks, authorized -> incomplete
-- ---------------------------------------------------------------------------
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', 'not-our-id'), :'expect') ->> 'code',
  'rejected_reference', 'external_reference must be the checkout id');
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', :'co2id', 'authorized', 1), :'expect') ->> 'code',
  'rejected_amount', 'preapproval amount must equal the frozen checkout amount');
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', :'co2id', 'authorized', 10990, '999'), :'expect') ->> 'code',
  'rejected_collector', 'preapproval collector must be MP_COLLECTOR_ID');
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', :'co2id', 'authorized', 10990, '777', 'USD'), :'expect') ->> 'code',
  'rejected_currency', 'preapproval currency must be the checkout currency');
select is(private.process_mp_preapproval(pg_temp.pre('PRENONE', 'x'), :'expect') ->> 'code',
  'unknown_checkout', 'preapproval without our checkout: ignored');
select is((select count(*)::int from public.subscriptions where provider = 'mercadopago'), 0,
  'rejected / unknown preapprovals write no subscription');
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', :'co2id', 'pending'), :'expect') ->> 'code',
  'pending', 'pending preapproval: nothing yet');
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'subscription_incomplete', 'authorized preapproval -> incomplete');
select is(pg_temp.sub_status('PREA1'), 'incomplete', 'subscription stays incomplete until a payment is approved');
select is((select plan || ':' || user_id from public.subscriptions where provider_subscription_id = 'PREA1'),
  'pro:' || :'a', 'user and plan come from the checkout');

-- ---------------------------------------------------------------------------
-- Payment: credit once on approved, checks on every field
-- ---------------------------------------------------------------------------
select is(private.process_mp_payment(pg_temp.pay('1001', 'approved'), null, :'expect') ->> 'code', 'unlinked',
  'payment topic without an invoice link: no credit');
select is((select count(*)::int from public.mp_payments where payment_id = 1001), 0, 'unlinked: no row');
select is(private.process_mp_payment(pg_temp.pay('1002', 'approved', 10990, 0, true), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'rejected_live_mode', 'live_mode mismatch rejected');
select is(private.process_mp_payment(pg_temp.pay('1003', 'approved', 10990, 0, false, '999'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'rejected_collector', 'collector mismatch rejected');
select is(private.process_mp_payment(pg_temp.pay('1004', 'approved', 10990, 0, false, '777', 'USD'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'rejected_currency', 'currency mismatch rejected');
select is(private.process_mp_payment(pg_temp.pay('1005', 'approved', 100), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'rejected_amount', 'amount mismatch rejected');
select is(private.process_mp_payment(pg_temp.pay('1006', 'approved', 10990, 0, false, '777', 'BRL', 'someone-else'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'rejected_reference', 'a foreign payment external_reference is rejected');
select is(private.process_mp_payment(pg_temp.pay('1007', 'approved'), pg_temp.pre('PREA1', :'co2id', 'authorized', 99999), :'expect') ->> 'code',
  'rejected_amount', 'the preapproval amount is checked against the frozen checkout too');
select is(pg_temp.balance(:'a'), 1000::bigint, 'no rejected payment credited anything');
select is(pg_temp.sub_status('PREA1'), 'incomplete', 'rejected payments do not activate the subscription');
select is(private.process_mp_payment(pg_temp.pay('1005', 'approved'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'recorded', 'a payment once rejected is never credited later');

select is(private.process_mp_payment(pg_temp.pay('2001', 'pending'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'recorded', 'pending payment: recorded, no credit');
select private.process_mp_payment(pg_temp.pay('2001', 'approved', 10990, 0, false, '777', 'BRL', :'co2id'),
  pg_temp.pre('PREA1', :'co2id'), :'expect') as p1 \gset
select is((:'p1'::jsonb) ->> 'code', 'credited', 'approved: credited (frozen price 10990 after the price change)');
select is(pg_temp.balance(:'a'), 26000::bigint, 'pro monthly credits granted once (1000 + 25000)');
select is(pg_temp.sub_status('PREA1'), 'active', 'first approved payment makes the subscription active');
select is((select plan_allowance from public.credit_wallets where user_id = :'a'), 25000::bigint, 'plan_allowance = pro');
select is((select status from public.billing_checkouts where id = :'co2id'), 'active', 'checkout active');
select is(private.process_mp_payment(pg_temp.pay('2001', 'approved'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'already_credited', 'same payment again (invoice topic): no second credit');
select is(private.process_mp_payment(pg_temp.pay('2001', 'approved'), null, :'expect') ->> 'code',
  'already_credited', 'same payment via the payment topic: no second credit');
select is((select count(*)::int from public.credit_transactions where idempotency_key = 'mp:payment:2001'), 1,
  'one ledger row per payment id');
select is(pg_temp.balance(:'a'), 26000::bigint, 'balance unchanged by repeats');
select is(private.process_mp_payment(pg_temp.pay('2001', 'approved'), pg_temp.pre('PREB9', :'co2id'), :'expect') ->> 'code',
  'rejected_preapproval', 'a known payment cannot be re-linked to another preapproval');
select is(private.mp_create_checkout(:'a', 'max') ->> 'code', 'already_subscribed', 'live subscription: no new checkout');

-- ---------------------------------------------------------------------------
-- Cumulative proportional reversal: 2 partials, then chargeback
-- ---------------------------------------------------------------------------
select is(private.process_mp_payment(pg_temp.pay('2002', 'approved'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'credited', 'renewal payment credited');
select is(pg_temp.balance(:'a'), 51000::bigint, '26000 + 25000');
select private.process_mp_payment(pg_temp.pay('2002', 'approved', 10990, 2000), null, :'expect') as r1 \gset
select is((:'r1'::jsonb) ->> 'reversed_amount', '4549', 'partial 1: target floor(25000 * 2000 / 10990) = 4549');
select is(pg_temp.balance(:'a'), 46451::bigint, 'debited 4549');
select is(pg_temp.sub_status('PREA1'), 'active', 'partial refund only debits');
select private.process_mp_payment(pg_temp.pay('2002', 'approved', 10990, 5000), null, :'expect') as r2 \gset
select is((:'r2'::jsonb) ->> 'reversed_amount', '11373', 'partial 2: cumulative target 11373');
select is(pg_temp.balance(:'a'), 39627::bigint, 'debited only the difference (6824)');
select private.process_mp_payment(pg_temp.pay('2002', 'approved', 10990, 5000), null, :'expect') as r2b \gset
select is(pg_temp.balance(:'a'), 39627::bigint, 'same partial again: nothing more');
select private.process_mp_payment(pg_temp.pay('2002', 'charged_back', 10990, 5000), null, :'expect') as r3 \gset
select is((:'r3'::jsonb) ->> 'reversed_amount', '25000', 'chargeback: target = full credited_amount');
select is(pg_temp.balance(:'a'), 26000::bigint, 'total debited = 25000 = credited, never more');
select is((select -sum(amount) from public.credit_transactions where idempotency_key like 'mp:reversal:2002:%'),
  25000::numeric, 'ledger: reversals of payment 2002 sum to exactly the credit');
select is(pg_temp.sub_status('PREA1'), 'blocked', 'chargeback blocks the subscription');
select private.process_mp_payment(pg_temp.pay('2002', 'refunded', 10990, 10990), null, :'expect') as r4 \gset
select is(pg_temp.balance(:'a'), 26000::bigint, 'refund after chargeback: no double debit');
select is(pg_temp.sub_status('PREA1'), 'blocked', 'a refund never unblocks');
select is(private.process_mp_payment(pg_temp.pay('2003', 'approved'), pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code',
  'rejected_blocked', 'blocked subscription: a new approved payment is not credited');
select is(private.process_mp_preapproval(pg_temp.pre('PREA1', :'co2id'), :'expect') ->> 'code', 'blocked',
  'preapproval updates never change a blocked subscription');
select is(pg_temp.balance(:'a'), 26000::bigint, 'balance unchanged');

-- Shortfall + full refund cancels: B spends most credits, then a full refund.
select pg_temp.checkout(:'b', 'starter', 'PREB1') as cob \gset
select private.process_mp_preapproval(pg_temp.pre('PREB1', :'cob', 'authorized', 4990), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('3001', 'approved', 4990), pg_temp.pre('PREB1', :'cob', 'authorized', 4990), :'expect') ->> 'code',
  'credited', 'B: starter credited');
select is(pg_temp.balance(:'b'), 11000::bigint, 'B: 1000 + 10000');
select tests.clear_authentication();
update public.credit_wallets set balance = 300 where user_id = :'b';
select tests.as_service_role();
select private.process_mp_payment(pg_temp.pay('3001', 'refunded', 4990, 4990), null, :'expect') as rb \gset
select is(pg_temp.balance(:'b'), 0::bigint, 'B: balance never negative');
select is((:'rb'::jsonb) ->> 'shortfall', '9700', 'B: shortfall recorded (10000 - 300)');
select is((select reversed_amount || '/' || reversal_shortfall from public.mp_payments where payment_id = 3001),
  '10000/9700', 'B: reversal fully accounted, shortfall kept');
select is(pg_temp.sub_status('PREB1'), 'canceled', 'full refund cancels the subscription');

-- Refund seen before the credit: never credited afterwards.
select pg_temp.checkout(:'c', 'starter', 'PREC1') as coc \gset
select private.process_mp_payment(pg_temp.pay('4001', 'refunded', 4990, 4990), pg_temp.pre('PREC1', :'coc', 'authorized', 4990), :'expect') \gset ignore_
select is(private.process_mp_payment(pg_temp.pay('4001', 'approved', 4990), pg_temp.pre('PREC1', :'coc', 'authorized', 4990), :'expect') ->> 'code',
  'recorded', 'approved after a refund: no credit');
select is(pg_temp.balance(:'c'), 1000::bigint, 'C: nothing credited');
select is(private.process_mp_payment(pg_temp.pay('4002', 'in_mediation', 4990), pg_temp.pre('PREC1', :'coc', 'authorized', 4990), :'expect') ->> 'code',
  'recorded', 'in_mediation: no credit while the dispute is open');

-- ---------------------------------------------------------------------------
-- One live subscription per user across Stripe + Mercado Pago
-- ---------------------------------------------------------------------------
select pg_temp.checkout(:'d', 'starter', 'PRED1') as cod \gset
select tests.clear_authentication();
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values (:'d', 'sub_stripe_d', 'pro', 'active');
select throws_ok(format($q$insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
  values (%L, 'sub_stripe_d2', 'max', 'active')$q$, :'d'), '23505', null,
  'DB: a second live subscription for one user is a unique violation');
select lives_ok(format($q$insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
  values (%L, 'sub_stripe_d3', 'max', 'incomplete')$q$, :'d'),
  'incomplete rows never conflict');
select tests.as_service_role();
select is(private.process_mp_preapproval(pg_temp.pre('PRED1', :'cod', 'authorized', 4990), :'expect') ->> 'code',
  'subscription_incomplete', 'D: MP incomplete next to a live Stripe subscription is allowed');
select private.process_mp_payment(pg_temp.pay('5001', 'approved', 4990), pg_temp.pre('PRED1', :'cod', 'authorized', 4990), :'expect') as dup \gset
select is((:'dup'::jsonb) ->> 'code', 'rejected_duplicate', 'D: approved payment while another live sub exists: rejected_duplicate');
select is(pg_temp.balance(:'d'), 1000::bigint, 'D: no credit');
select is(pg_temp.sub_status('PRED1'), 'incomplete', 'D: MP subscription not activated');
select is((select result from public.mp_payments where payment_id = 5001), 'rejected_duplicate',
  'D: recorded for a manual refund');
select is(private.process_mp_payment(pg_temp.pay('5001', 'approved', 4990), pg_temp.pre('PRED1', :'cod', 'authorized', 4990), :'expect') ->> 'code',
  'recorded', 'D: retries of a rejected_duplicate payment never credit');

-- unique_violation path (race past the pre-check): the index rejects it, no credit, no error.
select pg_temp.checkout(:'e', 'starter', 'PREE1') as coe \gset
select private.process_mp_preapproval(pg_temp.pre('PREE1', :'coe', 'authorized', 4990), :'expect') \gset ignore_
select tests.clear_authentication();
create function pg_temp.sneak_live_sub() returns trigger language plpgsql as $$
begin
  if new.idempotency_key = 'mp:payment:6001' then
    insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
    values (new.user_id, 'sub_race_e', 'pro', 'active');
  end if;
  return new;
end $$;
-- A concurrent Stripe activation that lands between the pre-check and the grant.
create trigger sneak before insert on public.credit_transactions
  for each row execute function pg_temp.sneak_live_sub();
select tests.as_service_role();
select lives_ok(format($q$select private.process_mp_payment(pg_temp.pay('6001', 'approved', 4990),
  pg_temp.pre('PREE1', %L, 'authorized', 4990), %L)$q$, :'coe', :'expect'),
  'E: unique_violation is caught (the Function answers 200, no 500 loop)');
select tests.clear_authentication();
drop trigger sneak on public.credit_transactions;
select tests.as_service_role();
select is((select result from public.mp_payments where payment_id = 6001), 'rejected_duplicate',
  'E: rejected_duplicate recorded');
select is(pg_temp.balance(:'e'), 1000::bigint, 'E: no credit');
select is(pg_temp.sub_status('PREE1'), 'incomplete', 'E: MP subscription not activated');

-- Preapproval transitions: paused / authorized / canceled.
select tests.clear_authentication();
select tests.create_user('mp-f@example.com', true) as f \gset
select tests.as_service_role();
select pg_temp.checkout(:'f', 'starter', 'PREF1') as cof \gset
select private.process_mp_preapproval(pg_temp.pre('PREF1', :'cof', 'authorized', 4990), :'expect') \gset ignore_
select private.process_mp_payment(pg_temp.pay('7001', 'approved', 4990), pg_temp.pre('PREF1', :'cof', 'authorized', 4990), :'expect') \gset ignore_
select is(private.process_mp_preapproval(pg_temp.pre('PREF1', :'cof', 'paused', 4990), :'expect') ->> 'code',
  'subscription_paused', 'paused');
select is(private.process_mp_preapproval(pg_temp.pre('PREF1', :'cof', 'authorized', 4990), :'expect') ->> 'code',
  'subscription_active', 'resumed -> active');
select is(private.process_mp_preapproval(pg_temp.pre('PREF1', :'cof', 'canceled', 4990), :'expect') ->> 'code',
  'subscription_canceled', 'canceled');
select is(pg_temp.balance(:'f'), 11000::bigint, 'F: cancel keeps the credits already granted');

-- ---------------------------------------------------------------------------
-- Delivery dedupe: processed only with the RPC; a failure is reprocessed once
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
select tests.create_user('mp-g@example.com', true) as g \gset
select tests.as_service_role();
select pg_temp.checkout(:'g', 'starter', 'PREG1') as cog \gset
select private.process_mp_preapproval(pg_temp.pre('PREG1', :'cog', 'authorized', 4990), :'expect') \gset ignore_
select is(private.mp_claim_notification('req-g-1', 'subscription_authorized_payment', '8001'), 'new', 'claim: new');
select tests.clear_authentication();
create function pg_temp.fail_once() returns trigger language plpgsql as $$
begin
  raise exception 'simulated database failure' using errcode = 'XX000';
end $$;
create trigger boom before insert on public.credit_transactions
  for each row execute function pg_temp.fail_once();
select tests.as_service_role();
select throws_ok(format($q$select private.process_mp_payment(pg_temp.pay('8001', 'approved', 4990),
  pg_temp.pre('PREG1', %L, 'authorized', 4990), %L, 'req-g-1')$q$, :'cog', :'expect'),
  'XX000', null, 'DB failure mid-RPC: the whole RPC fails (the Function answers 500)');
select is((select status from public.mp_notifications where request_id = 'req-g-1'), 'received',
  'the notification is NOT processed after a failure');
select is((select count(*)::int from public.mp_payments where payment_id = 8001), 0, 'nothing written');
select tests.clear_authentication();
drop trigger boom on public.credit_transactions;
select tests.as_service_role();
select is(private.mp_claim_notification('req-g-1', 'subscription_authorized_payment', '8001'), 'retry',
  'MP retry with the same x-request-id: reprocessed');
select is(private.process_mp_payment(pg_temp.pay('8001', 'approved', 4990), pg_temp.pre('PREG1', :'cog', 'authorized', 4990),
  :'expect', 'req-g-1') ->> 'code', 'credited', 'retry credits');
select is((select status from public.mp_notifications where request_id = 'req-g-1'), 'processed', 'processed with the RPC');
select is(private.mp_claim_notification('req-g-1', 'subscription_authorized_payment', '8001'), 'duplicate',
  'after processing: duplicate');
select is(pg_temp.balance(:'g'), 11000::bigint, 'credited exactly once');

-- debit_credits directly: idempotent, never negative.
select is((private.debit_credits(:'g', 500, 'test-debit') ->> 'debited')::bigint, 500::bigint, 'debit 500');
select is((private.debit_credits(:'g', 500, 'test-debit') ->> 'duplicate')::boolean, true, 'same key: no second debit');
select is((private.debit_credits(:'g', 999999, 'test-debit-2') ->> 'shortfall')::bigint, 999999 - 10500::bigint,
  'debit beyond the balance: shortfall');
select is(pg_temp.balance(:'g'), 0::bigint, 'balance 0, never negative');
select tests.clear_authentication();

select * from finish();
rollback;
