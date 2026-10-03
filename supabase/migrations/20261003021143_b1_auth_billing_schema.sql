-- B1: auth + billing schema (profiles, plans, subscriptions, credit wallets,
-- ledger, reservations, usage, stripe events), RLS, grants, credit RPCs and
-- the auth.users signup / free-grant triggers.
--
-- Security model (PLAN-auth-billing.md, Debbie's review, which overrides the
-- earlier sections):
--   * Every table has RLS on. Clients (anon / authenticated) get SELECT only,
--     restricted by policy to their own rows; anon reads only `plans`.
--     INSERT / UPDATE / DELETE are revoked from anon and authenticated on every
--     table. The one client write is `profiles (display_name, avatar_url)` via
--     a column-level GRANT plus an own-row policy.
--   * All credit mutations go through RPCs in schema `private` (not exposed by
--     the REST API): SECURITY DEFINER, `SET search_path = ''`, fully qualified
--     names, EXECUTE revoked from PUBLIC / anon / authenticated and granted to
--     service_role only. Trigger functions follow the same rule.
--   * Credits are integers. `credit_wallets.balance` is the spendable balance
--     and `reserved` the sum of active reservations; both are CHECK >= 0.
--     A reservation deducts from `balance` immediately (inside the wallet's
--     FOR UPDATE lock); settlement charges at most the reserved amount and
--     refunds the rest; expired reservations are refunded at the start of
--     every reserve_credits call (and by an optional pg_cron job).
--   * Idempotency is per user: UNIQUE (user_id, request_id) on reservations
--     and usage, UNIQUE (user_id, idempotency_key) on the ledger.

-- ---------------------------------------------------------------------------
-- Schema `private`: never exposed through PostgREST, no client access.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;
grant usage on schema private to service_role;

-- Functions created later in `private` must not be executable by PUBLIC /
-- anon / authenticated by default (Postgres grants EXECUTE to PUBLIC).
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from anon, authenticated;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Plan catalog (public read). Free has no Stripe price.
create table public.plans (
  plan text primary key check (plan ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  price_usd_cents integer not null check (price_usd_cents >= 0),
  stripe_price_id text unique,
  stripe_lookup_key text unique,
  monthly_credits bigint not null check (monthly_credits >= 0),
  -- Model ids the plan may use; NULL = every model in the server catalog.
  -- Enforced by the model-router (B4: 403 model_not_in_plan before reserving),
  -- not by the credit RPCs.
  allowed_models text[] check (allowed_models is null or cardinality(allowed_models) > 0),
  features jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 200),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_subscription_id text not null unique,
  plan text not null references public.plans (plan),
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_user_id_idx on public.subscriptions (user_id);

create table public.credit_wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  reserved bigint not null default 0 check (reserved >= 0),
  plan_allowance bigint not null default 0 check (plan_allowance >= 0),
  period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Append-only ledger. `amount` is signed (+ grant / refund, - reserve).
create table public.credit_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount bigint not null,
  kind text not null check (kind in ('grant', 'renewal', 'reserve', 'settle', 'refund', 'adjust')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  ref text,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index credit_transactions_user_created_idx
  on public.credit_transactions (user_id, created_at desc);

create table public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id text not null check (char_length(request_id) between 1 and 200),
  amount bigint not null check (amount > 0),
  settled_amount bigint check (settled_amount >= 0),
  status text not null default 'active' check (status in ('active', 'settled', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, request_id),
  check (settled_amount is null or settled_amount <= amount)
);
create index credit_reservations_active_expiry_idx
  on public.credit_reservations (expires_at) where status = 'active';

create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id text not null check (char_length(request_id) between 1 and 200),
  model text not null,
  provider text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  credits bigint not null check (credits >= 0),
  status text not null,
  created_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index usage_events_user_created_idx on public.usage_events (user_id, created_at desc);

-- Webhook dedup. No user access at all (written by the stripe-webhook Function).
create table public.stripe_events (
  event_id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Grants: start from nothing for clients (Supabase grants ALL on new public
-- tables to anon / authenticated by default), then add back the minimum.
-- ---------------------------------------------------------------------------
revoke all on table
  public.plans, public.profiles, public.subscriptions, public.credit_wallets,
  public.credit_transactions, public.credit_reservations, public.usage_events,
  public.stripe_events
from public, anon, authenticated;

grant select on table public.plans to anon, authenticated;
grant select on table
  public.profiles, public.subscriptions, public.credit_wallets,
  public.credit_transactions, public.credit_reservations, public.usage_events
to authenticated;
-- profiles: no table-level UPDATE; only these two columns.
revoke update on table public.profiles from authenticated;
grant update (display_name, avatar_url) on table public.profiles to authenticated;

-- Identity sequences: Supabase's default privileges also grant USAGE / UPDATE
-- on new sequences, and UPDATE allows setval() (which could break inserts).
revoke all on sequence public.credit_transactions_id_seq, public.usage_events_id_seq
from public, anon, authenticated;

-- service_role (Edge Functions only; bypasses RLS).
grant select, insert, update, delete on table
  public.plans, public.profiles, public.subscriptions, public.credit_wallets,
  public.credit_transactions, public.credit_reservations, public.usage_events,
  public.stripe_events
to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.credit_wallets enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.usage_events enable row level security;
alter table public.stripe_events enable row level security;

create policy plans_read_all on public.plans
  for select to anon, authenticated using (true);

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy credit_wallets_select_own on public.credit_wallets
  for select to authenticated using (user_id = (select auth.uid()));
create policy credit_transactions_select_own on public.credit_transactions
  for select to authenticated using (user_id = (select auth.uid()));
create policy credit_reservations_select_own on public.credit_reservations
  for select to authenticated using (user_id = (select auth.uid()));
create policy usage_events_select_own on public.usage_events
  for select to authenticated using (user_id = (select auth.uid()));
-- stripe_events: RLS on, no policy, no client grants.

-- ---------------------------------------------------------------------------
-- Seed: plans. Prices / credits: placeholders from the plan doc (Gabriel
-- sets the final values). Stripe ids are the TEST-MODE objects of account
-- acct_1QC4NbDuKWPSLmWm (livemode false); live mode will need new ids, so the
-- lookup_key is stored too. Free has no Stripe object and is limited to two
-- models (Gabriel, 2026-10-02 23:14 BRT); paid plans allow every model.
-- ---------------------------------------------------------------------------
insert into public.plans
  (plan, name, price_usd_cents, stripe_price_id, stripe_lookup_key, monthly_credits, allowed_models, sort_order)
values
  ('free',    'Free',    0,     null,                             null,                  1000,
     array['openai/gpt-6-luna', 'deepseek/deepseek-flash'], 0),
  ('starter', 'Starter', 900,   'price_1UMISRDuKWPSLmWmyVh3aXHh', 'modus_starter_monthly', 10000,  null, 1),
  ('pro',     'Pro',     2000,  'price_1UMISdDuKWPSLmWmJZqqbZiV', 'modus_pro_monthly',     25000,  null, 2),
  ('max',     'Max',     5000,  'price_1UMISfDuKWPSLmWmNvJnT969', 'modus_max_monthly',     70000,  null, 3),
  ('ultra',   'Ultra',   10000, 'price_1UMIShDuKWPSLmWmXrIsnPVM', 'modus_ultra_monthly',   150000, null, 4);

-- ---------------------------------------------------------------------------
-- Credit RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Refund expired active reservations. With p_user_id the caller must already
-- hold that user's wallet lock (reserve_credits does); without it (cron) each
-- affected wallet is locked first, in user_id order, so the lock order is
-- always wallet -> reservations (no deadlock with reserve / settle).
create function private.release_expired_reservations(p_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_res record;
  v_count integer := 0;
begin
  for v_user in
    select distinct r.user_id
    from public.credit_reservations r
    where r.status = 'active'
      and r.expires_at <= now()
      and (p_user_id is null or r.user_id = p_user_id)
    order by r.user_id
  loop
    if p_user_id is null then
      perform 1 from public.credit_wallets w where w.user_id = v_user for update;
    end if;
    for v_res in
      update public.credit_reservations r
         set status = 'expired', settled_at = now()
       where r.user_id = v_user
         and r.status = 'active'
         and r.expires_at <= now()
      returning r.request_id, r.amount
    loop
      update public.credit_wallets w
         set balance = w.balance + v_res.amount,
             reserved = w.reserved - v_res.amount,
             updated_at = now()
       where w.user_id = v_user;
      insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
      values (v_user, v_res.amount, 'refund', 'expire:' || v_res.request_id, v_res.request_id)
      on conflict (user_id, idempotency_key) do nothing;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

-- Reserve p_amount credits for (p_user_id, p_request_id). Idempotent: a repeat
-- returns the existing reservation with "created": false and changes nothing.
-- Raises SQLSTATE P0402 when the balance is insufficient (balance unchanged).
create function private.reserve_credits(
  p_user_id uuid,
  p_request_id text,
  p_amount bigint,
  p_ttl interval default interval '15 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_existing public.credit_reservations%rowtype;
  v_res public.credit_reservations%rowtype;
begin
  if p_user_id is null or p_request_id is null or p_amount is null or p_amount <= 0 then
    raise exception 'invalid reservation arguments' using errcode = '22023';
  end if;
  if p_ttl is null or p_ttl <= interval '0' or p_ttl > interval '1 day' then
    raise exception 'invalid reservation ttl' using errcode = '22023';
  end if;

  select w.balance into v_balance
    from public.credit_wallets w
   where w.user_id = p_user_id
   for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'P0404';
  end if;

  -- Orphans first: give expired reservations back before checking the balance.
  if private.release_expired_reservations(p_user_id) > 0 then
    select w.balance into v_balance from public.credit_wallets w where w.user_id = p_user_id;
  end if;

  select * into v_existing
    from public.credit_reservations r
   where r.user_id = p_user_id and r.request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'created', false,
      'reservation_id', v_existing.id,
      'request_id', v_existing.request_id,
      'amount', v_existing.amount,
      'status', v_existing.status,
      'expires_at', v_existing.expires_at,
      'balance', v_balance
    );
  end if;

  if v_balance < p_amount then
    raise exception 'insufficient credits'
      using errcode = 'P0402',
            detail = format('balance %s, requested %s', v_balance, p_amount);
  end if;

  update public.credit_wallets w
     set balance = w.balance - p_amount,
         reserved = w.reserved + p_amount,
         updated_at = now()
   where w.user_id = p_user_id
  returning w.balance into v_balance;

  insert into public.credit_reservations (user_id, request_id, amount, expires_at)
  values (p_user_id, p_request_id, p_amount, now() + p_ttl)
  returning * into v_res;

  insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
  values (p_user_id, -p_amount, 'reserve', 'reserve:' || p_request_id, p_request_id);

  return jsonb_build_object(
    'created', true,
    'reservation_id', v_res.id,
    'request_id', v_res.request_id,
    'amount', v_res.amount,
    'status', v_res.status,
    'expires_at', v_res.expires_at,
    'balance', v_balance
  );
end;
$$;

-- Settle a reservation with the real cost, capped at the reserved amount; the
-- difference goes back to the balance. Idempotent: a settled reservation
-- returns its result again with "settled_now": false. An expired reservation
-- (already refunded) raises P0410; an unknown one P0404.
create function private.settle_usage(
  p_user_id uuid,
  p_request_id text,
  p_actual_credits bigint,
  p_model text,
  p_provider text,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0,
  p_status text default 'completed'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_res public.credit_reservations%rowtype;
  v_cost bigint;
  v_refund bigint;
begin
  if p_user_id is null or p_request_id is null or p_actual_credits is null
     or p_actual_credits < 0 or p_model is null or p_provider is null or p_status is null then
    raise exception 'invalid settle arguments' using errcode = '22023';
  end if;

  select w.balance into v_balance
    from public.credit_wallets w
   where w.user_id = p_user_id
   for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'P0404';
  end if;

  select * into v_res
    from public.credit_reservations r
   where r.user_id = p_user_id and r.request_id = p_request_id
   for update;
  if not found then
    raise exception 'reservation not found' using errcode = 'P0404';
  end if;

  if v_res.status = 'settled' then
    return jsonb_build_object(
      'settled_now', false,
      'request_id', v_res.request_id,
      'reserved', v_res.amount,
      'charged', v_res.settled_amount,
      'refunded', v_res.amount - v_res.settled_amount,
      'balance', v_balance
    );
  end if;
  if v_res.status = 'expired' then
    raise exception 'reservation expired' using errcode = 'P0410';
  end if;

  v_cost := least(p_actual_credits, v_res.amount);
  v_refund := v_res.amount - v_cost;

  update public.credit_wallets w
     set balance = w.balance + v_refund,
         reserved = w.reserved - v_res.amount,
         updated_at = now()
   where w.user_id = p_user_id
  returning w.balance into v_balance;

  update public.credit_reservations r
     set status = 'settled', settled_amount = v_cost, settled_at = now()
   where r.id = v_res.id;

  insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
  values (p_user_id, v_refund, 'settle', 'settle:' || p_request_id, p_request_id);

  insert into public.usage_events
    (user_id, request_id, model, provider, input_tokens, output_tokens, credits, status)
  values
    (p_user_id, p_request_id, p_model, p_provider,
     greatest(coalesce(p_input_tokens, 0), 0), greatest(coalesce(p_output_tokens, 0), 0),
     v_cost, p_status);

  return jsonb_build_object(
    'settled_now', true,
    'request_id', p_request_id,
    'reserved', v_res.amount,
    'charged', v_cost,
    'refunded', v_refund,
    'balance', v_balance
  );
end;
$$;

-- Add credits once per (user, idempotency key), e.g. 'free-initial:<user_id>'
-- or 'invoice:<invoice_id>'. Returns "granted": false on a repeat.
create function private.grant_credits(
  p_user_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_kind text default 'grant',
  p_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_tx bigint;
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 or p_idempotency_key is null
     or p_kind not in ('grant', 'renewal', 'adjust') then
    raise exception 'invalid grant arguments' using errcode = '22023';
  end if;

  select w.balance into v_balance
    from public.credit_wallets w
   where w.user_id = p_user_id
   for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'P0404';
  end if;

  insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
  values (p_user_id, p_amount, p_kind, p_idempotency_key, p_ref)
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_tx;

  if v_tx is null then
    return jsonb_build_object('granted', false, 'balance', v_balance);
  end if;

  update public.credit_wallets w
     set balance = w.balance + p_amount, updated_at = now()
   where w.user_id = p_user_id
  returning w.balance into v_balance;

  return jsonb_build_object('granted', true, 'transaction_id', v_tx, 'balance', v_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- Signup triggers on auth.users
-- ---------------------------------------------------------------------------

-- Profile + wallet (balance 0) for every new user.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 200),
    left(new.raw_user_meta_data ->> 'avatar_url', 2048)
  )
  on conflict (id) do nothing;
  insert into public.credit_wallets (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Free plan credits, once, when the email is confirmed (OAuth users arrive
-- confirmed). Idempotency key free-initial:<user_id>.
create function private.grant_free_initial_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount bigint;
begin
  select p.monthly_credits into v_amount from public.plans p where p.plan = 'free';
  if coalesce(v_amount, 0) > 0 then
    perform private.grant_credits(new.id, v_amount, 'free-initial:' || new.id::text, 'grant', 'free-initial');
  end if;
  return new;
end;
$$;

-- Trigger names fire in alphabetical order: the profile / wallet trigger
-- (on_auth_user_created) runs before the free grant on insert.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger on_auth_user_created_free_grant
  after insert on auth.users
  for each row
  when (new.email_confirmed_at is not null)
  execute function private.grant_free_initial_credits();

create trigger on_auth_user_email_confirmed_free_grant
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function private.grant_free_initial_credits();

-- ---------------------------------------------------------------------------
-- Function privileges: service_role only for the RPCs; triggers for nobody.
-- ---------------------------------------------------------------------------
revoke all on function private.release_expired_reservations(uuid) from public, anon, authenticated;
revoke all on function private.reserve_credits(uuid, text, bigint, interval) from public, anon, authenticated;
revoke all on function private.settle_usage(uuid, text, bigint, text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function private.grant_credits(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function private.grant_free_initial_credits() from public, anon, authenticated, service_role;

grant execute on function private.release_expired_reservations(uuid) to service_role;
grant execute on function private.reserve_credits(uuid, text, bigint, interval) to service_role;
grant execute on function private.settle_usage(uuid, text, bigint, text, text, integer, integer, text) to service_role;
grant execute on function private.grant_credits(uuid, bigint, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Optional pg_cron sweep of orphaned reservations (Debbie point 4). Only when
-- the extension is available (Supabase has it; a plain local Postgres may not).
-- reserve_credits already releases a user's expired reservations itself.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute $cron$
      select cron.schedule(
        'release-expired-credit-reservations',
        '*/5 * * * *',
        'select private.release_expired_reservations()'
      )
    $cron$;
  end if;
end;
$$;
