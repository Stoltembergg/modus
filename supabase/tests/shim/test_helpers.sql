-- Test-only helpers (schema `tests`), loaded by run.sh after the migrations.
-- Never part of a migration.
create schema tests;
grant usage on schema tests to public;

-- New auth user (fires the signup triggers like GoTrue's insert would).
create function tests.create_user(
  p_email text,
  p_confirmed boolean default false,
  p_meta jsonb default '{}'::jsonb
) returns uuid
language sql
as $$
  insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
  values (p_email, case when p_confirmed then now() end, p_meta)
  returning id
$$;

-- Act as a signed-in user / anon / service_role for the rest of the
-- transaction, the way PostgREST does (role + request.jwt.claims).
create function tests.authenticate_as(p_user uuid) returns void
language sql
as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function tests.as_anon() returns void
language sql
as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true);
  select set_config('role', 'anon', true);
$$;

create function tests.as_service_role() returns void
language sql
as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select set_config('role', 'service_role', true);
$$;

-- Back to the test owner (postgres).
create function tests.clear_authentication() returns void
language sql
as $$
  select set_config('request.jwt.claims', '', true);
  select set_config('role', 'postgres', true);
$$;

grant execute on all functions in schema tests to public;
