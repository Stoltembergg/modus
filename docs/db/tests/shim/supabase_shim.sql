-- Minimal emulation of a Supabase database for the B1 SQL tests, loaded into
-- a throwaway local Postgres BEFORE the migrations. It reproduces only what
-- the migrations and tests rely on:
--   * roles anon, authenticated, service_role (BYPASSRLS) and authenticator;
--   * schema auth with auth.users (subset of columns) and auth.uid() /
--     auth.role() / auth.jwt() reading the request.jwt.claims GUC, like
--     PostgREST sets it;
--   * Supabase's permissive defaults, so the tests prove the migration's
--     REVOKEs work: USAGE on schema public for the API roles, default
--     privileges granting ALL on new public tables / sequences / functions to
--     anon, authenticated and service_role, and Postgres' own default
--     EXECUTE-to-PUBLIC on functions (left untouched);
--   * pgTAP in schema extensions.
--   * role supabase_admin as a second grantor of those default privileges
--     (on hosted Supabase it is the superuser; here postgres is).
-- Not emulated: GoTrue, PostgREST, storage, pg_cron (the cron migration does
-- nothing when the extension is not installed).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin nologin noinherit;
create role supabase_admin nologin;

create schema extensions;
grant usage on schema extensions to public;
create extension pgtap with schema extensions;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
grant all on auth.users to supabase_auth_admin;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(current_setting('request.jwt.claim.sub', true), auth.jwt() ->> 'sub'),
    ''
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select nullif(
    coalesce(current_setting('request.jwt.claim.role', true), auth.jwt() ->> 'role'),
    ''
  )::text
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

-- Supabase defaults for objects created by postgres / supabase_admin in public.
grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to supabase_admin;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on functions to anon, authenticated, service_role;
