-- Case 8: signup creates profile + wallet (balance 0); the Free credits are
-- granted exactly once, when the email is confirmed (or at insert for users
-- that arrive confirmed, e.g. OAuth). Also the plans seed (allowed_models).
begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.balance(p_user uuid) returns bigint
language sql as $$ select balance from public.credit_wallets where user_id = p_user $$;
create function pg_temp.free_grants(p_user uuid) returns integer
language sql as $$
  select count(*)::int from public.credit_transactions
   where user_id = p_user and idempotency_key = 'free-initial:' || p_user::text
$$;

-- Unconfirmed email signup.
select tests.create_user('new@example.com', false, '{"full_name": "Nova", "avatar_url": "https://x/n.png"}') as u \gset
select is((select display_name from public.profiles where id = :'u'), 'Nova', 'profile created from metadata');
select is((select avatar_url from public.profiles where id = :'u'), 'https://x/n.png', 'avatar from metadata');
select is((select stripe_customer_id from public.profiles where id = :'u'), null, 'no stripe customer yet');
select is(pg_temp.balance(:'u'), 0::bigint, 'unconfirmed: wallet with balance 0');
select is(pg_temp.free_grants(:'u'), 0, 'unconfirmed: no free grant');

-- A non-https avatar in the OAuth metadata is dropped, not a failed signup.
select tests.create_user('js@example.com', true, '{"avatar_url": "javascript:alert(1)"}') as js \gset
select is((select avatar_url from public.profiles where id = :'js'), null,
  'javascript: avatar in metadata -> profile created with avatar_url null');
select tests.create_user('http@example.com', false, '{"avatar_url": "http://x/a.png"}') as hu \gset
select is((select avatar_url from public.profiles where id = :'hu'), null,
  'http:// avatar in metadata -> avatar_url null');

-- Other updates while unconfirmed do not grant.
update auth.users set raw_user_meta_data = '{"x": 1}', updated_at = now() where id = :'u';
select is(pg_temp.balance(:'u'), 0::bigint, 'metadata update: still 0');

-- Confirmation grants once.
update auth.users set email_confirmed_at = now() where id = :'u';
select is(pg_temp.balance(:'u'), 1000::bigint, 'confirmed: free 1000 granted');
select is(pg_temp.free_grants(:'u'), 1, 'one free-initial ledger row');

-- Re-confirming, changing email, or un-confirming and confirming again never regrants.
update auth.users set email_confirmed_at = now() + interval '1 minute' where id = :'u';
update auth.users set email = 'changed@example.com' where id = :'u';
update auth.users set email_confirmed_at = null where id = :'u';
update auth.users set email_confirmed_at = now() where id = :'u';
select is(pg_temp.balance(:'u'), 1000::bigint, 'reconfirm / email change: still 1000');
select is(pg_temp.free_grants(:'u'), 1, 'still exactly one free-initial row');

-- The grant function is idempotent by key, even when called again directly.
select tests.as_service_role();
select is((private.grant_credits(:'u', 1000, 'free-initial:' || :'u', 'grant') ->> 'granted')::boolean,
  false, 'grant_credits with the same key is a no-op');
select is((private.grant_credits(:'u', 250, 'invoice:in_123', 'renewal') ->> 'granted')::boolean,
  true, 'a different key grants');
select is((private.grant_credits(:'u', 250, 'invoice:in_123', 'renewal') ->> 'granted')::boolean,
  false, 'and only once');
select tests.clear_authentication();
select is(pg_temp.balance(:'u'), 1250::bigint, 'balance 1000 + 250');

-- Already confirmed at insert (OAuth): granted immediately, once.
select tests.create_user('oauth@example.com', true) as o \gset
select is(pg_temp.balance(:'o'), 1000::bigint, 'OAuth (confirmed at insert): 1000 right away');
select is(pg_temp.free_grants(:'o'), 1, 'one free-initial row');
update auth.users set email_confirmed_at = now() + interval '1 hour' where id = :'o';
select is(pg_temp.balance(:'o'), 1000::bigint, 'later confirmation change: no regrant');

-- Deleting the auth user cascades.
delete from auth.users where id = :'o';
select is((select count(*)::int from public.credit_wallets where user_id = :'o'), 0, 'wallet removed with the user');
select is((select count(*)::int from public.profiles where id = :'o'), 0, 'profile removed with the user');

-- Trigger wiring.
select is(
  (select array_agg(tgname::text order by tgname) from pg_trigger
    where tgrelid = 'auth.users'::regclass and not tgisinternal),
  array['on_auth_user_created', 'on_auth_user_created_free_grant', 'on_auth_user_email_confirmed_free_grant'],
  'three triggers on auth.users');

-- Plans seed: Free = exactly 2 models (B4a migration 20261003063100 replaced the
-- B1 seed, GPT-6 Luna is not served by the gateway), paid = all (NULL).
select is((select allowed_models from public.plans where plan = 'free'),
  array['deepseek/deepseek-flash', 'zai/glm-5.3-flash'],
  'Free allows exactly deepseek/deepseek-flash and zai/glm-5.3-flash');
-- L5a review 2: Starter has an explicit list (the router catalog minus claude-fable-*);
-- Pro / Max / Ultra stay NULL (all models).
select is((select allowed_models from public.plans where plan = 'starter'),
  array['deepseek/deepseek-flash', 'zai/glm-5.3-flash'],
  'Starter allows exactly the router catalog''s models except claude-fable-* (explicit list)');
select is((select count(*)::int from public.plans where plan not in ('free', 'starter') and allowed_models is not null), 0,
  'pro / max / ultra: allowed_models NULL (all models)');
select is((select array_agg(plan order by sort_order) from public.plans),
  array['free', 'starter', 'pro', 'max', 'ultra'], 'five plans in order');
select is((select array_agg(monthly_credits order by sort_order) from public.plans),
  array[1000, 20000, 50000, 140000, 300000]::bigint[], 'monthly credits per plan');
select is((select stripe_price_id from public.plans where plan = 'free'), null, 'Free has no Stripe price');
select is((select count(*)::int from public.plans where plan <> 'free' and stripe_price_id like 'price\_%'), 4,
  'paid plans carry the test-mode price ids');

select * from finish();
rollback;
