-- Debbie review point 5: Supabase's default privileges on schema public no
-- longer reach anon / authenticated. Objects created AFTER the migration (by
-- postgres or supabase_admin, the grantors the shim emulates) are closed to
-- clients until a later migration grants them explicitly; service_role keeps
-- Supabase's default access.
begin;
set local search_path = public, extensions;
select no_plan();

create table public.after_b1 (id int primary key, secret text);
insert into public.after_b1 values (1, 'x');
create sequence public.after_b1_seq;
create function public.after_b1_fn() returns int language sql as 'select 42';
create function private.after_b1_private_fn() returns int language sql as 'select 7';

set local role supabase_admin;
create table public.after_b1_admin (id int);
create function public.after_b1_admin_fn() returns int language sql as 'select 1';
reset role;

select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) as r (role),
          (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p (priv),
          (values ('public.after_b1'), ('public.after_b1_admin')) as t (tbl)
    where has_table_privilege(r.role, t.tbl, p.priv)),
  0, 'new tables (postgres / supabase_admin): no privilege for anon / authenticated');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) as r (role),
          (values ('usage'), ('select'), ('update')) as p (priv)
    where has_sequence_privilege(r.role, 'public.after_b1_seq', p.priv)),
  0, 'new sequence: no privilege for anon / authenticated');
select is(
  (select count(*)::int
     from (values ('anon'), ('authenticated')) as r (role),
          (values ('public.after_b1_fn()'), ('public.after_b1_admin_fn()'),
                  ('private.after_b1_private_fn()')) as f (fn)
    where has_function_privilege(r.role, f.fn, 'execute')),
  0, 'new functions (public and private): not executable by anon / authenticated');
select is(
  (select count(*)::int
     from pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid in ('public.after_b1_fn()'::regprocedure, 'private.after_b1_private_fn()'::regprocedure)
      and a.grantee = 0),
  0, 'new functions created by postgres: no EXECUTE for PUBLIC');

select tests.as_anon();
select throws_ok('select * from public.after_b1', '42501', null, 'anon: select on new table denied');
select throws_ok($q$insert into public.after_b1 values (2, 'y')$q$, '42501', null,
  'anon: insert on new table denied');
select throws_ok('select public.after_b1_fn()', '42501', null, 'anon: new function denied');
select tests.clear_authentication();

select tests.create_user('a@example.com', true) as a \gset
select tests.authenticate_as(:'a');
select throws_ok('select * from public.after_b1', '42501', null, 'authenticated: select on new table denied');
select throws_ok('delete from public.after_b1', '42501', null, 'authenticated: delete on new table denied');
select throws_ok($q$select nextval('public.after_b1_seq')$q$, '42501', null,
  'authenticated: new sequence denied');
select throws_ok('select public.after_b1_fn()', '42501', null, 'authenticated: new function denied');
select tests.clear_authentication();

select ok(has_table_privilege('service_role', 'public.after_b1', 'select'),
  'service_role keeps the Supabase default on new tables');

-- The default ACL entries themselves: none left for anon / authenticated in
-- public, for either grantor.
select is(
  (select count(*)::int
     from pg_default_acl d
     join pg_namespace n on n.oid = d.defaclnamespace,
     lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole)),
  0, 'pg_default_acl: no public-schema defaults for anon / authenticated');

select * from finish();
rollback;
