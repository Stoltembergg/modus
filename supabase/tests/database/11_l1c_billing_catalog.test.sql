-- L1c: public.get_billing_catalog() + private.billing_settings flag.
begin;
set local search_path = public, extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Flag table
-- ---------------------------------------------------------------------------
select has_table('private', 'billing_settings', 'private.billing_settings exists');
select is((select count(*)::int from private.billing_settings), 1, 'billing_settings has exactly one row');
select is((select stripe_enabled from private.billing_settings), false, 'stripe_enabled defaults to false');
select is((select mercadopago_enabled from private.billing_settings), true, 'mercadopago_enabled defaults to true');
select col_default_is('private', 'billing_settings', 'stripe_enabled', 'false', 'stripe_enabled column DEFAULT false');
select throws_ok($q$insert into private.billing_settings (id) values (false)$q$, '23514', null,
  'single-row: id must be true');
select throws_ok($q$insert into private.billing_settings (id) values (true)$q$, '23505', null,
  'single-row: no second row');
select ok((select relrowsecurity from pg_class where oid = 'private.billing_settings'::regclass),
  'RLS enabled on billing_settings');
select is((select count(*)::int from pg_policy where polrelid = 'private.billing_settings'::regclass), 0,
  'no policy on billing_settings');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) as r (role),
          (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p (priv)
    where has_table_privilege(r.role, 'private.billing_settings', p.priv)),
  0, 'anon / authenticated: no table privilege at all on billing_settings');
select ok(has_table_privilege('service_role', 'private.billing_settings', 'update'),
  'service_role: may update billing_settings');

-- anon / authenticated cannot write the flag (privilege errors).
select tests.as_anon();
select throws_ok('update private.billing_settings set stripe_enabled = true', '42501', null,
  'anon: UPDATE flag denied');
select throws_ok('insert into private.billing_settings (id, stripe_enabled) values (true, true)', '42501', null,
  'anon: INSERT flag denied');
select throws_ok('delete from private.billing_settings', '42501', null, 'anon: DELETE flag denied');
select tests.clear_authentication();

select tests.create_user('l1c@example.com', true) as uid \gset
select tests.authenticate_as(:'uid');
select throws_ok('update private.billing_settings set stripe_enabled = true', '42501', null,
  'authenticated: UPDATE flag denied');
select throws_ok('insert into private.billing_settings (id, stripe_enabled) values (true, true)', '42501', null,
  'authenticated: INSERT flag denied');
select throws_ok('delete from private.billing_settings', '42501', null, 'authenticated: DELETE flag denied');
select tests.clear_authentication();
select is((select stripe_enabled from private.billing_settings), false, 'flag unchanged after the denied writes');

-- ---------------------------------------------------------------------------
-- Function shape and privileges
-- ---------------------------------------------------------------------------
select has_function('public', 'get_billing_catalog', array[]::text[], 'public.get_billing_catalog() exists');
select is((select provolatile::text from pg_proc where oid = 'public.get_billing_catalog()'::regprocedure), 's',
  'get_billing_catalog is STABLE');
select ok((select prosecdef from pg_proc where oid = 'public.get_billing_catalog()'::regprocedure),
  'get_billing_catalog is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc
            where oid = 'public.get_billing_catalog()'::regprocedure),
  'get_billing_catalog pins search_path=""');
select ok(has_function_privilege('anon', 'public.get_billing_catalog()', 'execute'), 'anon: may execute');
select ok(has_function_privilege('authenticated', 'public.get_billing_catalog()', 'execute'),
  'authenticated: may execute');
select ok(not has_function_privilege('service_role', 'public.get_billing_catalog()', 'execute'),
  'service_role: no execute grant');
select is(
  (select count(*)::int
     from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = 'public.get_billing_catalog()'::regprocedure and a.grantee = 0),
  0, 'no EXECUTE for PUBLIC');
select is(
  (select array_agg(a.grantee::regrole::text order by a.grantee::regrole::text)
     from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid = 'public.get_billing_catalog()'::regprocedure
      and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner),
  array['anon', 'authenticated'], 'EXECUTE granted only to anon and authenticated (besides the owner)');

-- Output columns: public data only.
select is(
  (select array_agg(x order by ord)
     from pg_proc p, unnest(p.proargnames, p.proargmodes) with ordinality as t (x, m, ord)
    where p.oid = 'public.get_billing_catalog()'::regprocedure and m = 't'),
  array['plan', 'name', 'monthly_credits', 'provider', 'currency', 'amount_minor', 'sort_order'],
  'output columns are exactly the public ones');
select is(
  (select count(*)::int
     from pg_proc p, unnest(p.proargnames) as x
    where p.oid = 'public.get_billing_catalog()'::regprocedure
      and (x ~* 'stripe|price_id|lookup|collector|secret|token|credential|customer|mp_|preapproval')),
  0, 'no sensitive column name in the output');

-- ---------------------------------------------------------------------------
-- Content (flag off: default)
-- ---------------------------------------------------------------------------
select tests.as_anon();
select is(
  (select string_agg(plan || ':' || name || ':' || monthly_credits || ':' || provider || ':' || currency || ':'
                     || amount_minor, ',' order by sort_order, provider)
     from public.get_billing_catalog()),
  'starter:Starter:10000:mercadopago:BRL:4990',
  'anon, flag off: only Starter via Mercado Pago, BRL 4990, 10000 credits');
select is((select count(*)::int from public.get_billing_catalog() where plan in ('pro', 'max', 'ultra')), 0,
  'anon: inactive plans (pro / max / ultra) excluded');
select is((select count(*)::int from public.get_billing_catalog() where plan = 'free'), 0, 'anon: free excluded');
select is((select count(*)::int from public.get_billing_catalog() where provider = 'stripe'), 0,
  'anon, flag off: no stripe provider');
select is(
  (select count(*)::int from public.get_billing_catalog() c
    where row_to_json(c)::text ~ 'price_1|modus_.*_monthly'),
  0, 'anon: no Stripe price id / lookup key value in any row');
select tests.clear_authentication();

select tests.authenticate_as(:'uid');
select is(
  (select string_agg(plan || ':' || provider || ':' || currency || ':' || amount_minor, ',')
     from public.get_billing_catalog()),
  'starter:mercadopago:BRL:4990', 'authenticated, flag off: same catalog');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Stripe appears only when the flag is true (toggled as service_role)
-- ---------------------------------------------------------------------------
select tests.as_service_role();
update private.billing_settings set stripe_enabled = true;
select tests.clear_authentication();
select is((select stripe_enabled from private.billing_settings), true, 'service_role: flag set to true');

select tests.as_anon();
select is(
  (select string_agg(plan || ':' || monthly_credits || ':' || provider || ':' || currency || ':' || amount_minor,
                     ',' order by sort_order, provider)
     from public.get_billing_catalog()),
  'starter:10000:mercadopago:BRL:4990,starter:10000:stripe:USD:900',
  'anon, flag on: Starter via Mercado Pago and Stripe (USD 900)');
select is((select count(*)::int from public.get_billing_catalog() where plan in ('pro', 'max', 'ultra')), 0,
  'anon, flag on: inactive plans still excluded');
select is(
  (select count(*)::int from public.get_billing_catalog() c
    where row_to_json(c)::text ~ 'price_1|modus_.*_monthly'),
  0, 'anon, flag on: no Stripe price id / lookup key value in any row');
select tests.clear_authentication();

select tests.authenticate_as(:'uid');
select is((select count(*)::int from public.get_billing_catalog() where provider = 'stripe'), 1,
  'authenticated, flag on: stripe provider present');
select tests.clear_authentication();

-- Re-activating a plan in the DB alone is not enough without a price.
update public.plans set active = true where plan = 'pro';
update public.plan_prices set active = false where plan = 'pro';
update private.billing_settings set stripe_enabled = false;
select tests.as_anon();
select is((select count(*)::int from public.get_billing_catalog() where plan = 'pro'), 0,
  'active plan without an active MP price and Stripe off: not listed');
select tests.clear_authentication();

-- Mercado Pago can be switched off too.
update public.plans set active = false where plan = 'pro';
update private.billing_settings set mercadopago_enabled = false;
select tests.as_anon();
select is((select count(*)::int from public.get_billing_catalog()), 0,
  'both providers off: empty catalog');
select tests.clear_authentication();

-- Back off -> stripe gone again.
update private.billing_settings set mercadopago_enabled = true;
select tests.as_anon();
select is((select count(*)::int from public.get_billing_catalog() where provider = 'stripe'), 0,
  'flag back to false: stripe provider gone');
select tests.clear_authentication();

select * from finish();
rollback;
