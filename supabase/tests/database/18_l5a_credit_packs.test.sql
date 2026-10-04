-- L5a: Mercado Pago one-off credit packs. Subscriptions flag (default off),
-- packs catalog, purchase creation, purchase payment webhook (verification,
-- pending vs approved, idempotency, a purchase paid twice -> two lots), lots consumption order
-- (allowance first, then lots oldest first), refund / chargeback (capped,
-- shortfall, account block), Free top-up of the allowance part only, router
-- access plan and the Free renewal batch isolation (a failing user).
-- now() is fixed inside this transaction, so time moves by back-dating rows.
begin;
set local search_path = public, extensions;
select no_plan();

\set expect '{"live_mode": false, "collector_id": "777"}'

create function pg_temp.pay(p_ref uuid, p_id text, p_status text default 'approved',
                            p_amount bigint default 3690, p_refunded bigint default 0,
                            p_live boolean default false, p_collector text default '777',
                            p_currency text default 'BRL')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'status_detail', null,
    'amount_minor', p_amount, 'refunded_minor', p_refunded, 'live_mode', p_live,
    'collector_id', p_collector, 'currency', p_currency, 'external_reference', p_ref::text)
$$;
grant execute on function pg_temp.pay(uuid, text, text, bigint, bigint, boolean, text, text) to service_role;
create function pg_temp.process(p_pay jsonb) returns text language sql as $$
  select private.process_mp_purchase_payment(p_pay, '{"live_mode": false, "collector_id": "777"}', null) ->> 'code'
$$;
grant execute on function pg_temp.process(jsonb) to service_role;
create function pg_temp.buy(p_user uuid, p_pack text) returns uuid language sql as $$
  select (private.mp_create_purchase(p_user, p_pack) ->> 'purchase_id')::uuid
$$;
grant execute on function pg_temp.buy(uuid, text) to service_role;
-- balance+reserved | lots remaining (oldest first)
create function pg_temp.state(p_user uuid) returns text language sql as $$
  select (select balance || '+' || reserved from public.credit_wallets where user_id = p_user) || '|'
      || coalesce((select string_agg(remaining::text, ',' order by created_at, id)
                     from public.credit_lots where user_id = p_user), '')
$$;
grant execute on function pg_temp.state(uuid) to service_role;
create function pg_temp.signed_up(p_user uuid, p_ago interval) returns void language sql as $$
  update public.credit_transactions set created_at = now() - p_ago
   where user_id = p_user and idempotency_key = 'free-initial:' || p_user::text
$$;
create function pg_temp.user_at(p_id uuid, p_email text) returns uuid language sql as $$
  insert into auth.users (id, email, email_confirmed_at) values (p_id, p_email, now()) returning id
$$;

-- ---------------------------------------------------------------------------
-- Security / schema
-- ---------------------------------------------------------------------------
select is((select column_default from information_schema.columns
            where table_schema = 'private' and table_name = 'billing_settings'
              and column_name = 'mercadopago_subscriptions_enabled'), 'false',
  'mercadopago_subscriptions_enabled defaults to false (subscriptions off in production)');
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
            where oid in ('private.mp_create_purchase(uuid, text)'::regprocedure,
                          'private.mp_link_purchase(uuid, text, text)'::regprocedure,
                          'private.process_mp_purchase_payment(jsonb, jsonb, text)'::regprocedure,
                          'private.purchase_access_plan(uuid)'::regprocedure,
                          'private.account_blocked(uuid)'::regprocedure,
                          'private.non_purchased_credits(uuid)'::regprocedure,
                          'private.consume_credit_lots()'::regprocedure)),
  'L5a functions: SECURITY DEFINER, search_path=""');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) r (role),
          (values ('private.mp_create_purchase(uuid, text)'), ('private.mp_link_purchase(uuid, text, text)'),
                  ('private.process_mp_purchase_payment(jsonb, jsonb, text)'),
                  ('private.purchase_access_plan(uuid)'), ('private.account_blocked(uuid)'),
                  ('private.non_purchased_credits(uuid)')) f (fn)
    where has_function_privilege(r.role, f.fn, 'execute')),
  0, 'L5a functions: no anon / authenticated EXECUTE');
select ok(not has_function_privilege('service_role', 'private.account_blocked(uuid)', 'execute')
      and not has_function_privilege('service_role', 'private.non_purchased_credits(uuid)', 'execute'),
  'helpers: not even service_role');
select ok(not has_table_privilege('authenticated', 'public.credit_packs', 'select')
      and not has_table_privilege('anon', 'public.credit_packs', 'select'),
  'credit_packs: no client access (the catalog RPC is the public view)');
select ok(not has_table_privilege('authenticated', 'public.credit_purchases', 'insert')
      and not has_table_privilege('authenticated', 'public.credit_purchases', 'update')
      and not has_table_privilege('authenticated', 'public.credit_lots', 'update')
      and not has_table_privilege('anon', 'public.credit_lots', 'select'),
  'purchases / lots: clients never write; anon never reads');
select ok(not has_column_privilege('authenticated', 'public.credit_purchases', 'checkout_url', 'select')
      and not has_column_privilege('authenticated', 'public.credit_lots', 'payment_id', 'select'),
  'purchases: authenticated reads no provider ids');
select ok(not has_table_privilege('service_role', 'private.free_renewal_errors', 'insert')
      and not has_table_privilege('authenticated', 'private.free_renewal_errors', 'select'),
  'free_renewal_errors: written only by the batch');

-- ---------------------------------------------------------------------------
-- Packs + catalog + flag
-- ---------------------------------------------------------------------------
select is((select string_agg(pack_id || ':' || credits || ':' || currency || ':' || amount_minor || ':' || access_plan,
                             ',' order by sort_order) from public.credit_packs),
  'credits_5k:5000:BRL:3690:starter,credits_10k:10000:BRL:7290:starter,credits_25k:25000:BRL:18090:pro',
  'exactly three packs, BRL, margin-checked prices (36,90 / 72,90 / 180,90); 25k -> pro');
select ok((select bool_and((amount_minor / 100.0) * (1 - 0.0498) / (credits * 0.001 * 5.50) >= 1.25)
             from public.credit_packs),
  'every pack: margin >= 1.25 after the 4.98% MP card fee at the USD/BRL 5.50 buffer');

update private.billing_settings set mercadopago_subscriptions_enabled = false;
select tests.as_anon();
select is((select string_agg(plan || ':' || kind || ':' || amount_minor, ',') from public.get_billing_catalog()),
  'credits_5k:pack:3690,credits_10k:pack:7290,credits_25k:pack:18090',
  'subscriptions off: catalog lists only the packs');
select tests.clear_authentication();
select tests.create_user('l5-a@example.com', true) as a \gset
select tests.as_service_role();
select is(private.mp_create_checkout(:'a', 'starter') ->> 'code', 'subscriptions_disabled',
  'subscriptions off: mp_create_checkout refuses (no preapproval is ever created)');
select tests.clear_authentication();
select is((select count(*)::int from public.billing_checkouts where user_id = :'a'), 0,
  'subscriptions off: no checkout row');
update private.billing_settings set mercadopago_subscriptions_enabled = true;
select tests.as_anon();
select is((select string_agg(plan || ':' || kind, ',') from public.get_billing_catalog()),
  'starter:subscription,credits_5k:pack,credits_10k:pack,credits_25k:pack',
  'subscriptions on: Starter subscription then the packs');
select tests.clear_authentication();
update private.billing_settings set mercadopago_enabled = false;
select tests.as_anon();
select is((select count(*)::int from public.get_billing_catalog() where kind = 'pack'), 0,
  'Mercado Pago off: no packs');
select tests.clear_authentication();
update private.billing_settings set mercadopago_enabled = true, mercadopago_subscriptions_enabled = false;

-- ---------------------------------------------------------------------------
-- Purchase creation
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select is(private.mp_create_purchase(:'a', 'credits_1m') ->> 'code', 'unknown_pack', 'unknown pack');
select is(private.mp_create_purchase(:'a', 'starter') ->> 'code', 'unknown_pack', 'a plan is not a pack');
select pg_temp.buy(:'a', 'credits_5k') as p1 \gset
select tests.clear_authentication();
select is((select pack_id || ':' || credits || ':' || amount_minor || ':' || currency || ':' || status
             from public.credit_purchases where id = :'p1'),
  'credits_5k:5000:3690:BRL:created', 'purchase frozen from the DB pack');
select tests.as_service_role();
select is(private.mp_link_purchase(:'p1', 'pref-1', 'https://mp.test/p1') ->> 'code', 'linked', 'link preference');
select is(private.mp_link_purchase(:'p1', 'pref-1', 'https://mp.test/p1') ->> 'code', 'already_linked', 'link again');
select is(private.mp_link_purchase(:'p1', 'pref-2', 'https://mp.test/p2') ->> 'code', 'conflict',
  'another preference: conflict');
select tests.clear_authentication();
-- A later price change does not affect an existing purchase.
update public.credit_packs set amount_minor = 9999 where pack_id = 'credits_5k';

-- ---------------------------------------------------------------------------
-- Webhook verification
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(gen_random_uuid(), '5001')), 'not_a_purchase', 'unknown reference: not a purchase');
select is(private.process_mp_purchase_payment(
            pg_temp.pay(:'p1', '5001') - 'external_reference', :'expect', null) ->> 'code',
  'not_a_purchase', 'no reference: not a purchase');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', p_live => true)), 'rejected_live_mode', 'live_mode mismatch');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', p_collector => '999')), 'rejected_collector', 'collector mismatch');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', p_currency => 'USD')), 'rejected_currency', 'currency mismatch');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', p_amount => 3689)), 'rejected_amount', 'amount below the frozen price');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', p_amount => 9999)), 'rejected_amount',
  'the current pack price is not accepted for an older purchase');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', 'pending')), 'pending', 'pending: nothing granted');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', 'in_process')), 'pending', 'in_process: nothing granted');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '1000+0|', 'still only the Free credits');
select is((select status from public.credit_purchases where id = :'p1'), 'created', 'purchase still created');
update public.credit_packs set amount_minor = 3690 where pack_id = 'credits_5k';

select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p1', '5001')), 'credited', 'approved: credited');
select is(pg_temp.process(pg_temp.pay(:'p1', '5001')), 'already_credited', 'redelivery: idempotent');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '6000+0|5000', 'balance 1000 + 5000, one lot of 5000');
select is((select cp.status || ':' || l.payment_id from public.credit_purchases cp
             join public.credit_lots l on l.purchase_id = cp.id where cp.id = :'p1'), 'paid:5001',
  'purchase paid; its lot is keyed by payment 5001');
select is((select string_agg(kind || ':' || amount, ',') from public.credit_transactions
            where user_id = :'a' and kind = 'purchase'), 'purchase:5000', 'one purchase ledger row');
select is((select count(*)::int from public.credit_purchases where user_id = :'a'), 1, 'one purchase');

-- ---------------------------------------------------------------------------
-- Consumption order: allowance (1000) first, then lots oldest first
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select pg_temp.buy(:'a', 'credits_10k') as p2 \gset
select is(pg_temp.process(pg_temp.pay(:'p2', '5003', p_amount => 7290)), 'credited', 'second pack credited');
select tests.clear_authentication();
update public.credit_lots set created_at = now() - interval '1 hour' where purchase_id = :'p1';
select is(pg_temp.state(:'a'), '16000+0|5000,10000', 'two lots');
select tests.as_service_role();
select is((private.reserve_credits(:'a', 'l5-r1', 800) ->> 'created')::boolean, true, 'reserve 800');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '15200+800|5000,10000', 'a reservation does not consume lots');
select tests.as_service_role();
select is((private.settle_usage(:'a', 'l5-r1', 700, 'm', 'p') ->> 'charged')::bigint, 700::bigint, 'settle 700');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '15300+0|5000,10000', 'charged from the allowance (300 left), lots intact');
select tests.as_service_role();
select private.reserve_credits(:'a', 'l5-r2', 2000);
select private.settle_usage(:'a', 'l5-r2', 2000, 'm', 'p');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '13300+0|3300,10000', 'allowance exhausted, then the oldest lot');
select tests.as_service_role();
select private.debit_credits(:'a', 4000, 'l5-debit-1');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '9300+0|0,9300', 'oldest lot emptied, then the next');
select is((select private.non_purchased_credits(:'a')), 0::bigint, 'no allowance part left');

-- ---------------------------------------------------------------------------
-- Free top-up with purchased credits: only the allowance part is topped up
-- ---------------------------------------------------------------------------
select pg_temp.signed_up(:'a', '40 days');
update public.credit_wallets set period_end = null where user_id = :'a';
select tests.as_service_role();
select is(private.renew_free_credits_for_user(:'a') ->> 'code', 'renewed',
  'a Free user with purchased credits still gets the renewal');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '10300+0|0,9300', 'renewal +1000 (allowance part 0 -> 1000), lots untouched');
select is((select amount from public.credit_transactions
            where user_id = :'a' and idempotency_key like 'free-renewal:%'), 1000::bigint, 'ledger +1000');

-- ---------------------------------------------------------------------------
-- Refunds / chargeback: only this purchase's lot, capped, shortfall
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p2', '5003', p_amount => 7290, p_refunded => 3645)), 'reversed',
  'partial refund (50%): reversed');
select is(pg_temp.process(pg_temp.pay(:'p2', '5003', p_amount => 7290, p_refunded => 3645)), 'already_credited',
  'same partial refund again: idempotent');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '5300+0|0,4300', 'half of the 10k pack (5000) taken from its lot');
select is((select reversed_credits || ':' || shortfall || ':' || status from public.credit_lots where payment_id = 5003),
  '5000:0:credited', 'lot of 5003: 5000 reversed, no shortfall, still credited');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p2', '5003', 'refunded', 7290, 7290)), 'reversed', 'full refund');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '1000+0|0,0', 'lot emptied; the allowance part is never taken by a refund');
select is((select reversed_credits || ':' || shortfall || ':' || status from public.credit_lots where payment_id = 5003),
  '10000:700:refunded', 'only 4300 left in the lot: shortfall 700 (spent credits)');
select is((select private.account_blocked(:'a')), false, 'a refund does not block');
-- The refunded 5k purchase (lot already empty): chargeback blocks, nothing to take.
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'p1', '5001', 'charged_back', 3690, 3690)), 'reversed', 'chargeback');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '1000+0|0,0', 'chargeback never debits the allowance part');
select is((select reversed_credits || ':' || shortfall || ':' || status from public.credit_lots where payment_id = 5001),
  '5000:5000:charged_back', 'chargeback: full shortfall recorded on the lot');
select is((select status from public.credit_purchases where id = :'p1'), 'charged_back', 'purchase charged_back');
select is((select private.account_blocked(:'a')), true, 'chargeback blocks the account');
select tests.as_service_role();
select is(private.mp_create_purchase(:'a', 'credits_5k') ->> 'code', 'blocked', 'blocked: no new purchase');
select tests.clear_authentication();
select is(private.free_renewal_check(:'a', now() - interval '1 day') ->> 'code', 'blocked', 'blocked: no Free renewal');
-- A webhook for a purchase created before the block is not credited.
insert into public.credit_purchases (id, user_id, pack_id, credits, amount_minor, currency)
values ('00000000-0000-4000-8000-0000000000b1', :'a', 'credits_5k', 5000, 3690, 'BRL');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay('00000000-0000-4000-8000-0000000000b1', '5009')), 'rejected_blocked',
  'blocked: an approved payment is not credited');
select tests.clear_authentication();
select is(pg_temp.state(:'a'), '1000+0|0,0', 'nothing granted');

-- Refund larger than the balance: capped by the wallet balance (never negative).
select tests.create_user('l5-c@example.com', true) as c \gset
select tests.as_service_role();
select pg_temp.buy(:'c', 'credits_5k') as pc \gset
select pg_temp.process(pg_temp.pay(:'pc', '5010'));
select private.reserve_credits(:'c', 'l5-c1', 5500);
select tests.clear_authentication();
select is(pg_temp.state(:'c'), '500+5500|5000', 'C: 5500 reserved in flight');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'pc', '5010', 'refunded', 3690, 3690)), 'reversed', 'C: refund in flight');
select tests.clear_authentication();
select is(pg_temp.state(:'c'), '0+5500|4500', 'C: only the available balance (500) is taken, never the reserve');
select is((select shortfall from public.credit_lots where payment_id = 5010), 4500::bigint, 'C: shortfall 4500');
select ok((select sum(remaining) from public.credit_lots where user_id = :'c')
          <= (select balance + reserved from public.credit_wallets where user_id = :'c'),
  'C: invariant sum(remaining) <= balance + reserved');

-- ---------------------------------------------------------------------------
-- Review fix 2: one purchase paid twice (same preference) -> two lots, keyed by payment id
-- ---------------------------------------------------------------------------
select tests.create_user('l5-d@example.com', true) as d \gset
select tests.as_service_role();
select pg_temp.buy(:'d', 'credits_5k') as pd \gset
select is(pg_temp.process(pg_temp.pay(:'pd', '7001')), 'credited', 'D: first payment credited');
select is((private.process_mp_purchase_payment(pg_temp.pay(:'pd', '7002'), :'expect', null) ->> 'additional')::boolean,
  true, 'D: a second approved payment of the same purchase is credited as an additional lot');
select is(pg_temp.process(pg_temp.pay(:'pd', '7002')), 'already_credited', 'D: second payment redelivered: idempotent');
select is(pg_temp.process(pg_temp.pay(:'pd', '7001')), 'already_credited', 'D: first payment redelivered: idempotent');
select is(pg_temp.process(pg_temp.pay(:'pd', '7003', p_amount => 3600)), 'rejected_amount',
  'D: a third payment with the wrong amount');
select is(pg_temp.process(pg_temp.pay(:'pd', '7004', p_collector => '999')), 'rejected_collector',
  'D: a third payment to another collector');
select is(pg_temp.process(pg_temp.pay(:'pd', '7005', p_live => true)), 'rejected_live_mode',
  'D: a third payment in live mode');
select is(pg_temp.process(pg_temp.pay(:'pd', '7006', p_currency => 'USD')), 'rejected_currency',
  'D: a third payment in another currency');
select tests.clear_authentication();
select is(pg_temp.state(:'d'), '11000+0|5000,5000', 'D: two lots of 5000, nothing for the rejected payments');
select is((select string_agg(payment_id::text, ',' order by payment_id) from public.credit_lots where user_id = :'d'),
  '7001,7002', 'D: lots keyed by payment id');
select is((select string_agg(idempotency_key || '=' || amount, ',' order by idempotency_key)
             from public.credit_transactions where user_id = :'d' and kind = 'purchase'),
  'mp:purchase-payment:7001=5000,mp:purchase-payment:7002=5000', 'D: one ledger row per payment id');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'pd', '7002', 'refunded', 3690, 3690)), 'reversed', 'D: refund of the second payment');
select tests.clear_authentication();
select is((select string_agg(payment_id || ':' || remaining || ':' || status, ',' order by payment_id)
             from public.credit_lots where user_id = :'d'),
  '7001:5000:credited,7002:0:refunded', 'D: only the second payment''s lot is touched');
select is((select balance from public.credit_wallets where user_id = :'d'), 6000::bigint, 'D: balance 6000');
select is((select status from public.credit_purchases where id = :'pd'), 'paid', 'D: purchase still paid, not blocked');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'pd', '7001', 'charged_back', 3690, 3690)), 'reversed', 'D: chargeback of the first');
select tests.clear_authentication();
select is((select private.account_blocked(:'d')), true, 'D: a chargeback of any payment blocks');
select tests.as_service_role();
select is(pg_temp.process(pg_temp.pay(:'pd', '7007')), 'rejected_blocked', 'D: blocked: a further payment grants nothing');
select tests.clear_authentication();
select is(pg_temp.state(:'d'), '1000+0|0,0', 'D: both lots reversed, the allowance part untouched');

-- ---------------------------------------------------------------------------
-- Review fix 3: no NULL / missing expectation (null vs null would pass IS DISTINCT FROM)
-- ---------------------------------------------------------------------------
select tests.as_service_role();
select pg_temp.buy(:'c', 'credits_5k') as pn \gset
select throws_ok(format($q$select private.process_mp_purchase_payment(%L::jsonb, '{"live_mode": false}', null)$q$,
                        pg_temp.pay(:'pn', '7101', p_collector => null)),
  '22023', 'invalid payment arguments', 'expected collector_id missing: refused');
select throws_ok(format($q$select private.process_mp_purchase_payment(%L::jsonb, '{"live_mode": false, "collector_id": null}', null)$q$,
                        pg_temp.pay(:'pn', '7101', p_collector => null)),
  '22023', 'invalid payment arguments', 'expected collector_id null: refused even for a null payment collector');
select throws_ok(format($q$select private.process_mp_purchase_payment(%L::jsonb, '{"collector_id": "777"}', null)$q$,
                        pg_temp.pay(:'pn', '7101')),
  '22023', 'invalid payment arguments', 'expected live_mode missing: refused');
select is(pg_temp.process(pg_temp.pay(:'pn', '7101', p_collector => null)), 'rejected_collector',
  'a payment without a collector is rejected');
select tests.clear_authentication();
select is((select count(*)::int from public.credit_lots where purchase_id = :'pn'), 0, 'nothing granted');

-- ---------------------------------------------------------------------------
-- Router access: highest pack access_plan while a lot has credits
-- ---------------------------------------------------------------------------
select tests.create_user('l5-r@example.com', true) as r \gset
select tests.as_service_role();
select is(private.purchase_access_plan(:'r'), null, 'no lots: no purchase access');
select pg_temp.buy(:'r', 'credits_5k') as pr1 \gset
select pg_temp.process(pg_temp.pay(:'pr1', '5020'));
select is(private.purchase_access_plan(:'r'), 'starter', '5k lot: starter');
select pg_temp.buy(:'r', 'credits_25k') as pr2 \gset
select pg_temp.process(pg_temp.pay(:'pr2', '5021', p_amount => 18090));
select is(private.purchase_access_plan(:'r'), 'pro', '25k lot: pro');
select tests.clear_authentication();
update public.credit_lots set remaining = 0 where purchase_id = :'pr2';
select tests.as_service_role();
select is(private.purchase_access_plan(:'r'), 'starter', '25k lot used up: back to starter');
select tests.clear_authentication();
insert into public.subscriptions (user_id, provider, provider_subscription_id, plan, status)
values (:'r', 'mercadopago', 'blockedl5r', 'starter', 'blocked');
select tests.as_service_role();
select is(private.purchase_access_plan(:'r'), null, 'blocked account: no purchase access');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Free renewal batch: a failing user never aborts the batch nor starves it
-- ---------------------------------------------------------------------------
select pg_temp.user_at('00000000-0000-4000-8000-00000000f001', 'l5-b1@example.com') as b1 \gset
select pg_temp.user_at('00000000-0000-4000-8000-00000000f002', 'l5-b2@example.com') as b2 \gset
select pg_temp.user_at('00000000-0000-4000-8000-00000000f003', 'l5-b3@example.com') as b3 \gset
-- Only B1..B3 are due (everyone else is up to date).
update public.credit_wallets set period_end = now() + interval '10 days'
 where user_id not in (:'b1', :'b2', :'b3');
select pg_temp.signed_up(:'b1', '40 days');
select pg_temp.signed_up(:'b2', '40 days');
select pg_temp.signed_up(:'b3', '40 days');
update public.credit_wallets set balance = 0, period_end = null where user_id in (:'b1', :'b2', :'b3');
create function pg_temp.fail_b2() returns trigger language plpgsql as $$
begin
  if new.user_id = '00000000-0000-4000-8000-00000000f002' and new.idempotency_key like 'free-renewal:%' then
    raise exception 'simulated renewal failure' using errcode = 'XX001';
  end if;
  return new;
end;
$$;
create trigger l5_fail_b2 before insert on public.credit_transactions
  for each row execute function pg_temp.fail_b2();

select tests.as_service_role();
select is(private.renew_free_credits(5000), 2, 'batch returns normally: B1 and B3 renewed, B2 failed');
select tests.clear_authentication();
select is((select string_agg(balance::text, ',' order by user_id) from public.credit_wallets
            where user_id in (:'b1', :'b2', :'b3')), '1000,0,1000',
  'users before and after the failing one renewed; B2 untouched (its subtransaction rolled back)');
select is((select period_end is null from public.credit_wallets where user_id = :'b2'), true,
  'B2: period_end not advanced (still due)');
select is((select failures || ':' || sqlstate || ':' || message from private.free_renewal_errors where user_id = :'b2'),
  '1:XX001:simulated renewal failure', 'B2 failure recorded');

-- B2 keeps failing; with p_limit = 1 a newly due user is served first.
select pg_temp.user_at('00000000-0000-4000-8000-00000000f000', 'l5-b0@example.com') as b0 \gset
select pg_temp.signed_up(:'b0', '40 days');
update public.credit_wallets set balance = 0, period_end = null where user_id = :'b0';
select tests.as_service_role();
select is(private.renew_free_credits(1), 1, 'p_limit 1: the healthy user takes the only slot');
select tests.clear_authentication();
select is((select balance from public.credit_wallets where user_id = :'b0'), 1000::bigint,
  'B0 renewed although B2 (lower id) is still failing');
select is((select failures from private.free_renewal_errors where user_id = :'b2'), 1,
  'B2 not retried while others were due');
select tests.as_service_role();
select is(private.renew_free_credits(1), 0, 'only B2 left: retried, fails, batch still returns');
select tests.clear_authentication();
select is((select failures from private.free_renewal_errors where user_id = :'b2'), 2, 'failure count 2');
drop trigger l5_fail_b2 on public.credit_transactions;
select tests.as_service_role();
select is(private.renew_free_credits(1), 1, 'B2 recovers');
select tests.clear_authentication();
select is((select balance from public.credit_wallets where user_id = :'b2'), 1000::bigint, 'B2 renewed');
select is((select count(*)::int from private.free_renewal_errors where user_id = :'b2'), 0, 'error row cleared');

select * from finish();
rollback;
