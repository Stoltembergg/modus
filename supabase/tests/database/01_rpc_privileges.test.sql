-- Cases 1 and 9: the credit RPCs are callable only by service_role, and every
-- function in `private` is SECURITY DEFINER with an empty search_path.
begin;
set local search_path = public, extensions;
select no_plan();

select tests.create_user('a@example.com', true) as uid \gset

-- Case 1: anon / authenticated get permission denied for every RPC.
select tests.as_anon();
select throws_ok(format($q$select private.reserve_credits(%L, 'r1', 1)$q$, :'uid'),
  '42501', null, 'anon: reserve_credits denied');
select throws_ok(format($q$select private.settle_usage(%L, 'r1', 1, 'm', 'p')$q$, :'uid'),
  '42501', null, 'anon: settle_usage denied');
select throws_ok(format($q$select private.grant_credits(%L, 5, 'k')$q$, :'uid'),
  '42501', null, 'anon: grant_credits denied');
select throws_ok($q$select private.release_expired_reservations()$q$,
  '42501', null, 'anon: release_expired_reservations denied');
select throws_ok($q$select private.process_stripe_event('evt_x', 'invoice.paid', '{"livemode": false}')$q$,
  '42501', null, 'anon: process_stripe_event denied');
select throws_ok(format($q$select private.router_claim_request(%L, 'k', repeat('a', 64))$q$, :'uid'),
  '42501', null, 'anon: router_claim_request denied');
select throws_ok(format($q$select private.router_reserve(%L, 'k', 1)$q$, :'uid'),
  '42501', null, 'anon: router_reserve denied');
select throws_ok(format($q$select private.router_store_cost(%L, 'k', 1, 'm', 'p')$q$, :'uid'),
  '42501', null, 'anon: router_store_cost denied');
select tests.clear_authentication();

select tests.authenticate_as(:'uid');
select throws_ok(format($q$select private.reserve_credits(%L, 'r1', 1)$q$, :'uid'),
  '42501', null, 'authenticated: reserve_credits denied');
select throws_ok(format($q$select private.settle_usage(%L, 'r1', 1, 'm', 'p')$q$, :'uid'),
  '42501', null, 'authenticated: settle_usage denied');
select throws_ok(format($q$select private.grant_credits(%L, 5, 'k')$q$, :'uid'),
  '42501', null, 'authenticated: grant_credits denied');
select throws_ok($q$select private.release_expired_reservations()$q$,
  '42501', null, 'authenticated: release_expired_reservations denied');
select throws_ok($q$select private.process_stripe_event('evt_x', 'invoice.paid', '{"livemode": false}')$q$,
  '42501', null, 'authenticated: process_stripe_event denied');
select throws_ok(format($q$select private.router_claim_request(%L, 'k', repeat('a', 64))$q$, :'uid'),
  '42501', null, 'authenticated: router_claim_request denied');
select throws_ok(format($q$select private.router_reserve(%L, 'k', 1)$q$, :'uid'),
  '42501', null, 'authenticated: router_reserve denied');
select throws_ok(format($q$select private.router_store_cost(%L, 'k', 1, 'm', 'p')$q$, :'uid'),
  '42501', null, 'authenticated: router_store_cost denied');
select tests.clear_authentication();

-- Denied at the function level too, not only by the schema: even with USAGE
-- on `private`, anon / authenticated / PUBLIC have no EXECUTE.
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon: no usage on private');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated: no usage on private');
select ok(has_schema_privilege('service_role', 'private', 'usage'), 'service_role: usage on private');

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join (values ('anon'), ('authenticated')) as r (role)
    where n.nspname = 'private'
      and has_function_privilege(r.role, p.oid, 'execute')),
  0, 'no private function is executable by anon / authenticated');
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'private' and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0, 'no private function grants EXECUTE to PUBLIC');
select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and has_function_privilege('service_role', p.oid, 'execute')),
  array['claim_stripe_customer', 'debit_credits', 'grant_credits', 'mp_cancel_targets',
        'mp_claim_notification', 'mp_create_checkout', 'mp_finish_notification', 'mp_link_checkout',
        'mp_mark_cancel_requested', 'process_mp_payment',
        'process_mp_preapproval', 'process_stripe_event', 'release_expired_reservations',
        'renew_free_credits', 'renew_free_credits_for_user',
        'reserve_credits', 'router_claim_request', 'router_reserve', 'router_store_cost', 'settle_usage'],
  'service_role can execute exactly the twenty RPCs (B1 five + B3 claim_stripe_customer + B4a router_claim_request / router_reserve / router_store_cost + B6a debit_credits / mp_* / process_mp_* + L1e mp_cancel_targets / mp_mark_cancel_requested + Free renewal renew_free_credits / renew_free_credits_for_user; not the trigger functions nor the mp_preapproval_mismatch helper)');

-- service_role: every RPC works.
select tests.as_service_role();
select is((private.grant_credits(:'uid', 50, 'svc-test') ->> 'granted')::boolean, true,
  'service_role: grant_credits works');
select is((private.reserve_credits(:'uid', 'svc-r1', 10) ->> 'created')::boolean, true,
  'service_role: reserve_credits works');
select is((private.settle_usage(:'uid', 'svc-r1', 4, 'm', 'p') ->> 'charged')::bigint, 4::bigint,
  'service_role: settle_usage works');
select is(private.release_expired_reservations(), 0, 'service_role: release_expired_reservations works');
select is(private.process_stripe_event('evt_priv', 'charge.succeeded', '{"livemode": false}') ->> 'code',
  'ignored', 'service_role: process_stripe_event works');
select tests.clear_authentication();

-- Case 9: SECURITY DEFINER + search_path='' on every private function.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'),
  26, 'twenty-six functions in private (20 RPCs + 3 trigger functions + the B6a mp_preapproval_mismatch helper + the Free renewal free_renewal_check / backfill_free_plan_allowance helpers)');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prosecdef
      and p.proconfig @> array['search_path=""']),
  26, 'all private functions are SECURITY DEFINER with search_path=""');
select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.prosecdef
      and p.proconfig @> array['search_path=""']),
  array['backfill_free_plan_allowance', 'claim_stripe_customer', 'debit_credits', 'free_renewal_check', 'grant_credits', 'grant_free_initial_credits',
        'handle_new_user', 'mp_cancel_targets', 'mp_claim_notification', 'mp_create_checkout',
        'mp_finish_notification', 'mp_link_checkout', 'mp_mark_cancel_requested', 'mp_preapproval_mismatch', 'process_mp_payment', 'process_mp_preapproval',
        'process_stripe_event', 'release_expired_reservations', 'renew_free_credits',
        'renew_free_credits_for_user', 'reserve_credits', 'router_claim_request',
        'router_reserve', 'router_store_cost', 'set_updated_at', 'settle_usage'],
  'including the trigger functions handle_new_user, grant_free_initial_credits, set_updated_at');

-- Hijack attempt: a caller-controlled search_path with decoy objects must not
-- change what the function touches.
create schema hijack;
create table hijack.credit_wallets (user_id uuid, balance bigint, reserved bigint);
insert into hijack.credit_wallets values (:'uid', 1000000000, 0);
create function hijack.least(bigint, bigint) returns bigint language sql as 'select 0::bigint';
select tests.as_service_role();
set local search_path = hijack, public, extensions;
select throws_ok(format($q$select private.reserve_credits(%L, 'hijack-r', 999999)$q$, :'uid'),
  'P0402', null, 'decoy credit_wallets on search_path is ignored (real balance used)');
select is((private.reserve_credits(:'uid', 'hijack-r2', 5) ->> 'created')::boolean, true,
  'reserve works with a hostile search_path');
select is((private.settle_usage(:'uid', 'hijack-r2', 3, 'm', 'p') ->> 'charged')::bigint, 3::bigint,
  'settle uses pg_catalog.least, not hijack.least');
set local search_path = public, extensions;
select tests.clear_authentication();

select * from finish();
rollback;
