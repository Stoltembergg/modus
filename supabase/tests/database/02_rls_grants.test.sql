-- Case 2: row isolation, no client writes (except own display_name /
-- avatar_url), anon reads only plans.
begin;
set local search_path = public, extensions;
select no_plan();

select tests.create_user('a@example.com', true, '{"full_name": "Alice"}') as a \gset
select tests.create_user('b@example.com', true, '{"full_name": "Bob"}') as b \gset

-- Give both users a row in every per-user table (as service_role).
select tests.as_service_role();
\o /dev/null
select private.reserve_credits(:'a', 'req-a', 10);
select private.reserve_credits(:'b', 'req-b', 10);
select private.settle_usage(:'a', 'req-a', 3, 'model-x', 'prov');
select private.settle_usage(:'b', 'req-b', 3, 'model-x', 'prov');
\o
insert into public.subscriptions (user_id, stripe_subscription_id, plan, status)
values (:'a', 'sub_a', 'pro', 'active'), (:'b', 'sub_b', 'starter', 'active');
insert into public.stripe_events (event_id, type) values ('evt_1', 'invoice.paid');
update public.profiles set stripe_customer_id = 'cus_' || left(id::text, 8);
select tests.clear_authentication();

-- RLS is on for every table in public.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0, 'RLS enabled on every public table');

-- User A sees only A's rows, everywhere.
select tests.authenticate_as(:'a');
select is((select array_agg(id) from public.profiles), array[:'a'::uuid], 'A: profiles = own row only');
select is((select array_agg(user_id) from public.credit_wallets), array[:'a'::uuid], 'A: wallets = own');
select is((select count(*)::int from public.credit_transactions where user_id <> :'a'), 0,
  'A: no foreign ledger rows');
select ok((select count(*) from public.credit_transactions) > 0, 'A: sees own ledger rows');
select is((select array_agg(user_id) from public.credit_reservations), array[:'a'::uuid],
  'A: reservations = own');
select is((select array_agg(user_id) from public.usage_events), array[:'a'::uuid], 'A: usage = own');
select is((select array_agg(user_id) from public.subscriptions), array[:'a'::uuid],
  'A: subscriptions = own');
select is((select count(*)::int from public.plans), 5, 'A: reads the 5 plans');
select throws_ok('select * from public.stripe_events', '42501', null, 'A: stripe_events denied');
select is((select count(*)::int from public.profiles where id = :'b'), 0, 'A: cannot see B by id');
select tests.clear_authentication();

-- Nobody (anon / authenticated) can insert, update or delete anywhere.
create temp table write_attempts (role text, sql text, label text);
insert into write_attempts
select r.role, q.sql, r.role || ': ' || q.label
from (values ('anon'), ('authenticated')) as r (role)
cross join (values
  (format('update public.credit_wallets set balance = 999999 where user_id = %L', :'a'), 'update balance'),
  (format('update public.credit_wallets set reserved = 0 where user_id = %L', :'a'), 'update reserved'),
  (format('update public.profiles set stripe_customer_id = %L where id = %L', 'cus_evil', :'a'), 'update stripe_customer_id'),
  (format('insert into public.credit_wallets (user_id, balance) values (%L, 5)', gen_random_uuid()), 'insert wallet'),
  (format('insert into public.credit_transactions (user_id, amount, kind, idempotency_key) values (%L, 100, %L, %L)', :'a', 'grant', 'evil'), 'insert ledger'),
  (format('insert into public.credit_reservations (user_id, request_id, amount, expires_at) values (%L, %L, 1, now())', :'a', 'evil'), 'insert reservation'),
  (format('insert into public.usage_events (user_id, request_id, model, provider, credits, status) values (%L, %L, %L, %L, 0, %L)', :'a', 'evil', 'm', 'p', 'ok'), 'insert usage'),
  (format('insert into public.subscriptions (user_id, stripe_subscription_id, plan, status) values (%L, %L, %L, %L)', :'a', 'sub_evil', 'ultra', 'active'), 'insert subscription'),
  (format('insert into public.profiles (id) values (%L)', gen_random_uuid()), 'insert profile'),
  ('insert into public.plans (plan, name, price_usd_cents, monthly_credits) values (''evil'', ''Evil'', 0, 999999)', 'insert plan'),
  ('update public.plans set monthly_credits = 999999', 'update plans'),
  ('insert into public.stripe_events (event_id, type) values (''evt_evil'', ''x'')', 'insert stripe_events'),
  ('delete from public.credit_wallets', 'delete wallets'),
  ('delete from public.credit_transactions', 'delete ledger'),
  ('delete from public.credit_reservations', 'delete reservations'),
  ('delete from public.usage_events', 'delete usage'),
  ('delete from public.subscriptions', 'delete subscriptions'),
  ('delete from public.profiles', 'delete profiles'),
  ('delete from public.plans', 'delete plans'),
  ('delete from public.stripe_events', 'delete stripe_events'),
  ('truncate public.credit_wallets', 'truncate wallets'),
  ('select setval(''public.credit_transactions_id_seq'', 1)', 'setval ledger sequence')
) as q (sql, label);
grant select on write_attempts to anon, authenticated;

create function pg_temp.attempt_as(p_role text, p_sql text, p_user uuid) returns text
language plpgsql as $$
begin
  if p_role = 'anon' then perform tests.as_anon(); else perform tests.authenticate_as(p_user); end if;
  begin
    execute p_sql;
  exception when insufficient_privilege then
    perform tests.clear_authentication();
    return '42501';
  when others then
    perform tests.clear_authentication();
    return sqlstate;
  end;
  perform tests.clear_authentication();
  return 'succeeded';
end;
$$;

select is(pg_temp.attempt_as(w.role, w.sql, :'a'), '42501', w.label || ' -> permission denied')
from write_attempts w;

-- Balances and Stripe ids are untouched after all of that.
select is((select balance from public.credit_wallets where user_id = :'a'), 1000 - 3::bigint,
  'A balance unchanged (free 1000 - settled 3)');
select is((select stripe_customer_id from public.profiles where id = :'a'),
  'cus_' || left(:'a'::text, 8), 'A stripe_customer_id unchanged');

-- The only client write: own display_name / avatar_url.
select tests.authenticate_as(:'a');
select lives_ok($q$update public.profiles set display_name = 'Alice 2', avatar_url = 'https://x/a.png'$q$,
  'A updates own display_name / avatar_url');
update public.profiles set display_name = 'hacked' where id = :'b';
select tests.clear_authentication();
select is((select display_name from public.profiles where id = :'a'), 'Alice 2', 'A display_name updated');
select is((select avatar_url from public.profiles where id = :'a'), 'https://x/a.png', 'A avatar_url updated');
select is((select display_name from public.profiles where id = :'b'), 'Bob', 'B display_name untouched by A');

select tests.authenticate_as(:'a');
select throws_ok(format($q$update public.profiles set id = %L$q$, :'b'), '42501', null,
  'A cannot change profiles.id');
select tests.clear_authentication();

-- avatar_url must be https (CHECK), for clients and everyone else.
select tests.authenticate_as(:'a');
select throws_ok($q$update public.profiles set avatar_url = 'http://x/a.png'$q$, '23514', null,
  'A cannot set an http:// avatar_url');
select throws_ok($q$update public.profiles set avatar_url = 'javascript:alert(1)'$q$, '23514', null,
  'A cannot set a javascript: avatar_url');
select throws_ok($q$update public.profiles set avatar_url = 'HTTPS://x/a.png'$q$, '23514', null,
  'scheme check is exact (lowercase https:// only)');
select lives_ok($q$update public.profiles set avatar_url = null$q$, 'A can clear avatar_url');
select tests.clear_authentication();
select is((select avatar_url from public.profiles where id = :'a'), null, 'A avatar_url cleared');

-- profiles.updated_at is maintained by a trigger.
set local session_replication_role = replica;
update public.profiles set updated_at = '2000-01-01T00:00:00Z' where id in (:'a', :'b');
set local session_replication_role = origin;
select tests.authenticate_as(:'a');
update public.profiles set display_name = 'Alice 3';
select tests.clear_authentication();
select is((select updated_at from public.profiles where id = :'a'), now(),
  'updated_at bumped by the trigger on a client update');
select is((select updated_at from public.profiles where id = :'b'), '2000-01-01T00:00:00Z'::timestamptz,
  'untouched row keeps its updated_at');
select tests.authenticate_as(:'a');
select throws_ok($q$update public.profiles set updated_at = '1999-01-01'$q$, '42501', null,
  'clients cannot write updated_at directly');
select tests.clear_authentication();

-- Column privileges are exactly display_name / avatar_url.
select is(
  (select array_agg(column_name::text order by column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'profiles'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  array['avatar_url', 'display_name'], 'authenticated: UPDATE only on (avatar_url, display_name)');

-- anon reads only plans.
select tests.as_anon();
select is((select count(*)::int from public.plans), 5, 'anon: reads plans');
select throws_ok('select * from public.profiles', '42501', null, 'anon: profiles denied');
select throws_ok('select * from public.credit_wallets', '42501', null, 'anon: wallets denied');
select throws_ok('select * from public.credit_transactions', '42501', null, 'anon: ledger denied');
select throws_ok('select * from public.credit_reservations', '42501', null, 'anon: reservations denied');
select throws_ok('select * from public.usage_events', '42501', null, 'anon: usage denied');
select throws_ok('select * from public.subscriptions', '42501', null, 'anon: subscriptions denied');
select throws_ok('select * from public.stripe_events', '42501', null, 'anon: stripe_events denied');
select tests.clear_authentication();

select is(
  (select array_agg(table_name::text order by table_name)
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'),
  array['plans'], 'anon has privileges on plans only');
select is(
  (select array_agg(distinct privilege_type::text)
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')),
  array['SELECT'], 'anon / authenticated hold table-level SELECT only');

select * from finish();
rollback;
