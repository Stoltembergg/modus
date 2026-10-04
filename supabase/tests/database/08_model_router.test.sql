-- B4a (20261003063000_b4a_model_router, 20261003063100_b4a_free_plan_models):
-- router_requests (idempotency keys, no client access), router_claim_request
-- (replay vs conflict), router_reserve (4 active reservations per user, 402,
-- reservation + release through settle_usage), router_store_cost + the
-- replaced expiry sweep (stored cost -> settled; none -> refunded), and the Free models.
begin;
set local search_path = public, extensions;
select no_plan();

select tests.create_user('router-a@example.com', true) as a \gset
select tests.create_user('router-b@example.com', true) as b \gset
select tests.create_user('router-c@example.com', true) as c \gset

-- Table: RLS on, no policy, nothing for anon / authenticated.
select ok((select relrowsecurity from pg_class where oid = 'public.router_requests'::regclass),
  'router_requests: RLS enabled');
select is((select count(*)::int from pg_policies where tablename = 'router_requests'), 0,
  'router_requests: no policy');
select ok(not has_table_privilege('authenticated', 'public.router_requests', 'select'),
  'authenticated cannot read router_requests');
select ok(not has_table_privilege('anon', 'public.router_requests', 'select'),
  'anon cannot read router_requests');
select ok(not has_table_privilege('authenticated', 'public.router_requests', 'insert'),
  'authenticated cannot write router_requests');
select ok(has_table_privilege('service_role', 'public.router_requests', 'insert'),
  'service_role writes router_requests');

select tests.as_service_role();

-- Claim: first time claimed; same body -> replay; other body -> conflict.
select is(private.router_claim_request(:'a', 'key-1', repeat('a', 64)) ->> 'code', 'claimed',
  'claim: first use of a key');
select is(private.router_claim_request(:'a', 'key-1', repeat('a', 64)) ->> 'code', 'idempotency_replay',
  'claim: same key + same body hash -> replay');
select is(private.router_claim_request(:'a', 'key-1', repeat('b', 64)) ->> 'code', 'idempotency_conflict',
  'claim: same key + other body hash -> conflict');
select is(private.router_claim_request(:'b', 'key-1', repeat('b', 64)) ->> 'code', 'claimed',
  'claim: keys are per user');
select is((select count(*)::int from public.router_requests), 2, 'two keys stored');
select throws_ok(format($q$select private.router_claim_request(%L, 'bad key', repeat('a', 64))$q$, :'a'),
  '22023', null, 'claim: malformed key rejected');
select throws_ok(format($q$select private.router_claim_request(%L, 'k', 'nothex')$q$, :'a'),
  '22023', null, 'claim: malformed hash rejected');
select throws_ok(format($q$select private.router_claim_request(%L, repeat('k', 201), repeat('a', 64))$q$, :'a'),
  '22023', null, 'claim: key longer than 200 rejected');

-- Reserve: balance 1000 (Free grant).
select is((private.router_reserve(:'a', 'r1', 100) ->> 'created')::boolean, true, 'reserve 1');
select is((select balance from public.credit_wallets where user_id = :'a'), 900::bigint,
  'reserve debits the balance');
select throws_ok(format($q$select private.router_reserve(%L, 'big', 5000)$q$, :'a'),
  'P0402', null, 'reserve above the balance -> P0402');
select is((select count(*)::int from public.credit_reservations where user_id = :'a' and request_id = 'big'), 0,
  '402 leaves no reservation');
select private.router_reserve(:'a', 'r2', 10);
select private.router_reserve(:'a', 'r3', 10);
select private.router_reserve(:'a', 'r4', 10);
select throws_ok(format($q$select private.router_reserve(%L, 'r5', 10)$q$, :'a'),
  'P0429', null, 'a 5th active reservation -> P0429');
select is((select count(*)::int from public.credit_reservations where user_id = :'a' and request_id = 'r5'), 0,
  '429 leaves no reservation');
select is((select balance from public.credit_wallets where user_id = :'a'), 870::bigint,
  '429: balance unchanged');
select is((private.router_reserve(:'a', 'r5', 10, 5) ->> 'created')::boolean, true,
  'the limit is a parameter (5)');

-- Release (settle 0) and settle capped at the reservation.
select is((private.settle_usage(:'a', 'r1', 0, 'deepseek/deepseek-flash', 'deepseek') ->> 'charged')::bigint, 0::bigint,
  'release: settle with 0 credits charges nothing');
select is((private.settle_usage(:'a', 'r2', 999, 'deepseek/deepseek-flash', 'deepseek', 5, 7) ->> 'charged')::bigint, 10::bigint,
  'settle is capped at the reservation');
select is((select balance from public.credit_wallets where user_id = :'a'), 960::bigint,
  'release refunded 100, settle kept 10');
select is((select count(*)::int from public.credit_reservations where user_id = :'a' and status = 'active'), 3,
  'three reservations still active');
select is((private.router_reserve(:'a', 'r6', 10) ->> 'created')::boolean, true,
  'after settling, a new reservation fits under the limit again');

-- Expired reservations are released before counting.
update public.credit_reservations set expires_at = now() - interval '1 second'
 where user_id = :'a' and status = 'active';
select is((private.router_reserve(:'a', 'r7', 10) ->> 'created')::boolean, true,
  'expired reservations do not count (released first)');
select is((select count(*)::int from public.credit_reservations where user_id = :'a' and status = 'active'), 1,
  'only the new reservation is active');
select throws_ok($q$select private.router_reserve('00000000-0000-4000-8000-000000000000', 'x', 1)$q$,
  'P0404', null, 'no wallet -> P0404');
select throws_ok(format($q$select private.router_reserve(%L, 'x', 1, 0)$q$, :'a'),
  '22023', null, 'max_active < 1 rejected');

-- Settle kept failing in the router -> cost stored -> the sweep charges it.
-- User b: balance 1000, three reservations: sc (cost stored), sn (nothing stored),
-- sx (stored cost above the reservation -> capped).
select private.router_claim_request(:'b', 'sc', repeat('c', 64));
select private.router_claim_request(:'b', 'sn', repeat('c', 64));
select private.router_claim_request(:'b', 'sx', repeat('c', 64));
select private.router_reserve(:'b', 'sc', 300);
select private.router_reserve(:'b', 'sn', 200);
select private.router_reserve(:'b', 'sx', 50);
select is((select balance from public.credit_wallets where user_id = :'b'), 450::bigint,
  'store: three reservations debited (550)');
select is(private.router_store_cost(:'b', 'sc', 120, 'deepseek/deepseek-flash', 'deepseek', 50, 40), true,
  'store: cost kept on the router_requests row');
select is(private.router_store_cost(:'b', 'sx', 999, 'zai/glm-5.3-flash', 'zai', 1, 2), true,
  'store: a cost above the reservation is kept as-is (capped by the sweep)');
select is(private.router_store_cost(:'b', 'no-such-key', 1, 'm', 'p'), false,
  'store: unknown key -> false');
select throws_ok(format($q$select private.router_store_cost(%L, 'sc', -1, 'm', 'p')$q$, :'b'),
  '22023', null, 'store: negative credits rejected');
select throws_ok(format($q$select private.router_store_cost(%L, 'sc', 1, null, 'p')$q$, :'b'),
  '22023', null, 'store: model required');
select is((select settle_credits from public.router_requests where user_id = :'b' and idempotency_key = 'sn'),
  null, 'sn: nothing stored');
update public.credit_reservations set expires_at = now() - interval '1 second'
 where user_id = :'b' and status = 'active';
select is(private.release_expired_reservations(), 3, 'sweep: three expired reservations handled');
select is((select status || ':' || settled_amount from public.credit_reservations
            where user_id = :'b' and request_id = 'sc'), 'settled:120',
  'sweep: stored cost -> settled by that cost');
select is((select status from public.credit_reservations where user_id = :'b' and request_id = 'sn'),
  'expired', 'sweep: no stored cost -> released (expired)');
select is((select status || ':' || settled_amount from public.credit_reservations
            where user_id = :'b' and request_id = 'sx'), 'settled:50',
  'sweep: stored cost capped at the reservation');
select is((select balance from public.credit_wallets where user_id = :'b'), 830::bigint,
  'sweep: 180 back from sc, 200 from sn, 0 from sx');
select is((select reserved from public.credit_wallets where user_id = :'b'), 0::bigint,
  'sweep: nothing left reserved');
select results_eq(
  format($q$select request_id, model, provider, input_tokens, output_tokens, credits, status
              from public.usage_events where user_id = %L order by request_id$q$, :'b'),
  $q$values ('sc', 'deepseek/deepseek-flash', 'deepseek', 50, 40, 120::bigint, 'billed'),
            ('sx', 'zai/glm-5.3-flash', 'zai', 1, 2, 50::bigint, 'billed')$q$,
  'sweep: billed usage rows for the stored costs only');
select results_eq(
  format($q$select idempotency_key, kind, amount from public.credit_transactions
             where user_id = %L and ref in ('sc', 'sn', 'sx') and kind <> 'reserve'
             order by idempotency_key$q$, :'b'),
  $q$values ('expire:sn', 'refund', 200::bigint), ('settle:sc', 'settle', 180::bigint),
            ('settle:sx', 'settle', 0::bigint)$q$,
  'sweep: settle ledger rows for stored costs, refund for the other');
select is(private.settle_usage(:'b', 'sc', 120, 'deepseek/deepseek-flash', 'deepseek') ->> 'code',
  'already_settled', 'a late settle after the sweep does not charge twice');
select is(private.release_expired_reservations(:'b'), 0, 'sweep is idempotent');

-- Progressive cost (round 2): the router stores the prompt estimate BEFORE the
-- fetch and refreshes it while streaming; a killed worker leaves the last value,
-- which the sweep charges (capped). A rejected request (non-2xx) is zeroed first.
select private.router_claim_request(:'c', 'pk', repeat('d', 64));
select private.router_claim_request(:'c', 'pz', repeat('d', 64));
select private.router_reserve(:'c', 'pk', 400);
select private.router_reserve(:'c', 'pz', 100);
select is(private.router_store_cost(:'c', 'pk', 30, 'deepseek/deepseek-flash', 'deepseek', 20, 0), true,
  'progressive: minimum (prompt estimate) stored before the fetch');
select is(private.router_store_cost(:'c', 'pk', 90, 'deepseek/deepseek-flash', 'deepseek', 20, 70), true,
  'progressive: updated while streaming');
select is((select settle_credits || ':' || settle_output_tokens from public.router_requests
            where user_id = :'c' and idempotency_key = 'pk'), '90:70',
  'progressive: the row holds the latest value');
select private.router_store_cost(:'c', 'pz', 10, 'deepseek/deepseek-flash', 'deepseek', 20, 0);
select is(private.router_store_cost(:'c', 'pz', 0, 'deepseek/deepseek-flash', 'deepseek', 0, 0), true,
  'release: the stored minimum is zeroed');
update public.credit_reservations set expires_at = now() - interval '1 second'
 where user_id = :'c' and status = 'active';
select is(private.release_expired_reservations(:'c'), 2, 'killed worker: the sweep handles both');
select is((select status || ':' || settled_amount from public.credit_reservations
            where user_id = :'c' and request_id = 'pk'), 'settled:90',
  'killed worker: charged the last stored cost');
select is((select settled_amount from public.credit_reservations
            where user_id = :'c' and request_id = 'pz'), 0::bigint,
  'rejected request: zeroed cost -> nothing charged');
select is((select balance from public.credit_wallets where user_id = :'c'), 910::bigint,
  'balance: 1000 - 90');
select tests.clear_authentication();

-- Free plan models (B4a migration).
select is((select allowed_models from public.plans where plan = 'free'),
  array['deepseek/deepseek-flash', 'zai/glm-5.3-flash'], 'Free: deepseek/deepseek-flash + zai/glm-5.3-flash');

-- Cascade: deleting the user removes their keys.
delete from auth.users where id = :'b';
select is((select count(*)::int from public.router_requests where user_id = :'b'), 0,
  'router_requests rows cascade with the user');

select * from finish();
rollback;
