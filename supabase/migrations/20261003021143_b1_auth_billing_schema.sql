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
--     every reserve_credits call (a pg_cron sweep in the next migration is
--     only cleanup).
--   * Idempotency is per user: UNIQUE (user_id, request_id) on reservations
--     and usage, UNIQUE (user_id, idempotency_key) on the ledger.

-- ---------------------------------------------------------------------------
-- Schema `private`: never exposed through PostgREST, no client access.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;
grant usage on schema private to service_role;

-- ---------------------------------------------------------------------------
-- Default privileges (Debbie review, point 5). Supabase grants ALL on every
-- NEW table / sequence / function in `public` to anon and authenticated
-- (ALTER DEFAULT PRIVILEGES FOR ROLE postgres / supabase_admin IN SCHEMA
-- public ...). Revoke that, so an object added by a later migration is closed
-- until it gets explicit grants. Postgres itself grants EXECUTE on new
-- functions to PUBLIC globally; a per-schema rule cannot remove a global
-- default, so that one is revoked globally for the creating role. Each
-- grantor role is handled only if it exists and the migration role may act
-- for it (on hosted Supabase, `postgres` cannot alter `supabase_admin`'s
-- defaults; those then stay as Supabase set them).
-- ---------------------------------------------------------------------------
do $$
declare
  v_role text;
begin
  foreach v_role in array array['postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role)
       and pg_catalog.pg_has_role(current_user, v_role, 'USAGE') then
      execute format(
        'alter default privileges for role %I in schema public revoke all on tables from anon, authenticated',
        v_role);
      execute format(
        'alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated',
        v_role);
      execute format(
        'alter default privileges for role %I in schema public revoke all on functions from anon, authenticated',
        v_role);
      execute format(
        'alter default privileges for role %I revoke execute on functions from public', v_role);
    end if;
  end loop;
end;
$$;

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
  avatar_url text check (
    avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 2048)
  ),
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
  -- billed: charged by settle_usage; unbilled: settled after the reservation
  -- had expired (already refunded), recorded with 0 credits.
  status text not null check (status in ('billed', 'unbilled')),
  created_at timestamptz not null default now(),
  unique (user_id, request_id),
  check (status = 'billed' or credits = 0)
);
create index usage_events_user_created_idx on public.usage_events (user_id, created_at desc);

-- Webhook dedup + audit, written only by private.process_stripe_event in the
-- same transaction as the event's effect. No user access at all.
create table public.stripe_events (
  event_id text primary key check (char_length(event_id) between 1 and 255),
  type text not null,
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  result text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
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

-- Refund expired active reservations. Lock order is ALWAYS wallet ->
-- reservations, like reserve_credits / settle_usage, so it cannot deadlock
-- with them: with p_user_id it locks that wallet first (re-entrant when the
-- caller already holds it); without it (cron sweep) it locks each affected
-- wallet, in user_id order, before touching that user's reservations.
create function private.release_expired_reservations(p_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users uuid[];
  v_user uuid;
  v_res record;
  v_count integer := 0;
begin
  if p_user_id is not null then
    v_users := array[p_user_id];
  else
    select coalesce(array_agg(distinct r.user_id order by r.user_id), array[]::uuid[])
      into v_users
      from public.credit_reservations r
     where r.status = 'active' and r.expires_at <= now();
  end if;

  foreach v_user in array v_users loop
    perform 1 from public.credit_wallets w where w.user_id = v_user for update;
    if not found then
      continue;
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

-- Reserve p_amount credits for (p_user_id, p_request_id). Idempotent: any
-- repeat of the request_id (same or different amount, active, settled or
-- expired) returns the existing reservation with "created": false and changes
-- nothing; the router maps that to 409 idempotency_conflict.
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
-- difference goes back to the balance and a 'billed' usage row is written.
-- Idempotent: a settled reservation returns its result again with
-- "settled_now": false. An expired reservation (already refunded) is not
-- charged: it returns "code": "reservation_expired" and records a 0-credit
-- 'unbilled' usage row (once). An unknown reservation raises P0404.
create function private.settle_usage(
  p_user_id uuid,
  p_request_id text,
  p_actual_credits bigint,
  p_model text,
  p_provider text,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
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
  v_in integer := greatest(coalesce(p_input_tokens, 0), 0);
  v_out integer := greatest(coalesce(p_output_tokens, 0), 0);
begin
  if p_user_id is null or p_request_id is null or p_actual_credits is null
     or p_actual_credits < 0 or p_model is null or p_provider is null then
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
      'code', 'already_settled',
      'request_id', v_res.request_id,
      'reserved', v_res.amount,
      'charged', v_res.settled_amount,
      'refunded', v_res.amount - v_res.settled_amount,
      'balance', v_balance
    );
  end if;

  -- Expired but not swept yet: release it now (refund), then fall through
  -- to the expired path.
  if v_res.status = 'active' and v_res.expires_at <= now() then
    perform private.release_expired_reservations(p_user_id);
    select w.balance into v_balance from public.credit_wallets w where w.user_id = p_user_id;
    v_res.status := 'expired';
  end if;

  if v_res.status = 'expired' then
    insert into public.usage_events
      (user_id, request_id, model, provider, input_tokens, output_tokens, credits, status)
    values (p_user_id, p_request_id, p_model, p_provider, v_in, v_out, 0, 'unbilled')
    on conflict (user_id, request_id) do nothing;
    return jsonb_build_object(
      'settled_now', false,
      'code', 'reservation_expired',
      'request_id', v_res.request_id,
      'reserved', v_res.amount,
      'charged', 0,
      'balance', v_balance
    );
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
  values (p_user_id, p_request_id, p_model, p_provider, v_in, v_out, v_cost, 'billed');

  return jsonb_build_object(
    'settled_now', true,
    'code', 'settled',
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
    -- Only https avatars are kept (profiles CHECK); anything else is dropped
    -- instead of failing the signup.
    case
      when new.raw_user_meta_data ->> 'avatar_url' ~ '^https://'
       and char_length(new.raw_user_meta_data ->> 'avatar_url') <= 2048
      then new.raw_user_meta_data ->> 'avatar_url'
    end
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
-- updated_at on profiles / subscriptions
-- ---------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Stripe webhook effects (service_role only), Debbie review point 5.
-- Called by the stripe-webhook Function AFTER it verified the signature and
-- re-fetched the object from the Stripe API: p_payload is that object (a
-- subscription for customer.subscription.*, an invoice for invoice.paid), not
-- the raw event. This function never calls Stripe. In one transaction it
-- records the event in stripe_events and applies the effect; any error rolls
-- both back, so a failed event is never marked processed.
--   * user: ONLY from profiles.stripe_customer_id (never metadata);
--   * plan: ONLY from plans.stripe_price_id (never metadata);
--   * livemode must be exactly false;
--   * credits only on invoice.paid with billing_reason subscription_create /
--     subscription_cycle and amount_paid > 0, for the non-proration line of
--     the subscription's price; idempotent by 'invoice:<invoice id>'. Other
--     paid invoices are recorded as processed with code 'not_grantable';
--   * customer.subscription.created / updated / deleted upsert subscriptions;
--   * any other event type is recorded as processed with code 'ignored';
--   * an event_id already processed returns {processed: false, code: duplicate}.
-- ---------------------------------------------------------------------------
create function private.process_stripe_event(p_event_id text, p_type text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_customer text;
  v_user uuid;
  v_price text;
  v_plan public.plans%rowtype;
  v_owner uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_grant jsonb;
  v_result jsonb;
  v_sub_id text;
  v_sub_price text;
  v_reason text;
  v_amount_paid numeric;
begin
  if p_event_id is null or p_type is null or p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid stripe event arguments' using errcode = '22023';
  end if;
  if (p_payload -> 'livemode') is distinct from 'false'::jsonb then
    raise exception 'only test-mode (livemode false) Stripe objects are accepted'
      using errcode = '22023';
  end if;

  insert into public.stripe_events (event_id, type) values (p_event_id, p_type)
  on conflict (event_id) do nothing;
  if not found then
    select e.status into v_status from public.stripe_events e
     where e.event_id = p_event_id for update;
    if v_status = 'processed' then
      return pg_catalog.jsonb_build_object(
        'processed', false, 'code', 'duplicate', 'event_id', p_event_id);
    end if;
    update public.stripe_events e
       set status = 'processing', type = p_type, result = null, processed_at = null
     where e.event_id = p_event_id;
  end if;

  if p_type in ('customer.subscription.created', 'customer.subscription.updated',
                'customer.subscription.deleted', 'invoice.paid') then
    v_customer := case pg_catalog.jsonb_typeof(p_payload -> 'customer')
      when 'string' then p_payload ->> 'customer'
      when 'object' then p_payload -> 'customer' ->> 'id'
    end;
    if v_customer is null then
      raise exception 'stripe object has no customer' using errcode = '22023';
    end if;
    select pr.id into v_user from public.profiles pr where pr.stripe_customer_id = v_customer;
    if v_user is null then
      raise exception 'unknown stripe customer' using errcode = 'P0404';
    end if;
  end if;

  if p_type in ('customer.subscription.created', 'customer.subscription.updated',
                'customer.subscription.deleted') then
    if p_payload ->> 'object' is distinct from 'subscription' or p_payload ->> 'id' is null then
      raise exception 'expected a subscription object' using errcode = '22023';
    end if;
    v_price := p_payload #>> '{items,data,0,price,id}';
    select * into v_plan from public.plans pl where pl.stripe_price_id = v_price;
    if v_price is null or not found then
      raise exception 'unknown stripe price' using errcode = 'P0404';
    end if;
    v_start := pg_catalog.to_timestamp(coalesce(
      p_payload ->> 'current_period_start', p_payload #>> '{items,data,0,current_period_start}')::double precision);
    v_end := pg_catalog.to_timestamp(coalesce(
      p_payload ->> 'current_period_end', p_payload #>> '{items,data,0,current_period_end}')::double precision);

    select su.user_id into v_owner from public.subscriptions su
     where su.stripe_subscription_id = p_payload ->> 'id' for update;
    if v_owner is not null and v_owner <> v_user then
      raise exception 'subscription belongs to another user' using errcode = 'P0403';
    end if;

    insert into public.subscriptions as su
      (user_id, stripe_subscription_id, plan, status, current_period_start,
       current_period_end, cancel_at_period_end)
    values
      (v_user, p_payload ->> 'id', v_plan.plan, coalesce(p_payload ->> 'status', 'unknown'),
       v_start, v_end, coalesce((p_payload ->> 'cancel_at_period_end')::boolean, false))
    on conflict (stripe_subscription_id) do update
       set plan = excluded.plan,
           status = excluded.status,
           current_period_start = excluded.current_period_start,
           current_period_end = excluded.current_period_end,
           cancel_at_period_end = excluded.cancel_at_period_end;

    v_result := pg_catalog.jsonb_build_object(
      'code', 'subscription_upserted', 'user_id', v_user, 'plan', v_plan.plan,
      'status', coalesce(p_payload ->> 'status', 'unknown'));

  elsif p_type = 'invoice.paid' then
    if p_payload ->> 'object' is distinct from 'invoice' or p_payload ->> 'id' is null then
      raise exception 'expected an invoice object' using errcode = '22023';
    end if;
    if p_payload ->> 'status' is distinct from 'paid' then
      raise exception 'invoice is not paid' using errcode = '22023';
    end if;
    -- Only a paid first / renewal invoice of a subscription grants the plan's
    -- credits. Proration invoices (subscription_update: upgrades) and $0
    -- invoices (e.g. downgrades, 100% coupons) are recorded but grant
    -- nothing; mid-cycle upgrade credits are B3.
    v_reason := p_payload ->> 'billing_reason';
    v_amount_paid := case when pg_catalog.jsonb_typeof(p_payload -> 'amount_paid') = 'number'
                          then (p_payload ->> 'amount_paid')::numeric end;
    if v_reason is null or v_reason not in ('subscription_create', 'subscription_cycle')
       or v_amount_paid is null or v_amount_paid <= 0 then
      update public.stripe_events e
         set status = 'processed', result = 'not_grantable', processed_at = pg_catalog.now()
       where e.event_id = p_event_id;
      return pg_catalog.jsonb_build_object(
        'processed', true, 'event_id', p_event_id, 'code', 'not_grantable',
        'granted', false, 'reason', 'not_grantable', 'user_id', v_user,
        'billing_reason', v_reason, 'amount_paid', v_amount_paid);
    end if;

    v_sub_id := coalesce(p_payload ->> 'subscription',
                         p_payload #>> '{parent,subscription_details,subscription}');
    if v_sub_id is null then
      raise exception 'subscription invoice without a subscription id' using errcode = '22023';
    end if;

    -- Server state first: the plan price of the subscription we already know.
    select su.user_id, pl.stripe_price_id into v_owner, v_sub_price
      from public.subscriptions su
      join public.plans pl on pl.plan = su.plan
     where su.stripe_subscription_id = v_sub_id;
    if v_owner is not null and v_owner <> v_user then
      raise exception 'subscription belongs to another user' using errcode = 'P0403';
    end if;

    -- The line that pays for the plan: not a proration, belongs to this
    -- subscription, and (when the server knows the subscription) carries its
    -- price. Never "the first priced line".
    select x.price, x.period_end into v_price, v_end
      from (
        select coalesce(l -> 'price' ->> 'id', l #>> '{pricing,price_details,price}') as price,
               pg_catalog.to_timestamp((l #>> '{period,end}')::double precision) as period_end,
               coalesce((l ->> 'proration')::boolean,
                        (l #>> '{parent,subscription_item_details,proration}')::boolean,
                        false) as proration,
               coalesce(l ->> 'subscription',
                        l #>> '{parent,subscription_item_details,subscription}') as sub_id,
               o.n
          from pg_catalog.jsonb_array_elements(coalesce(p_payload #> '{lines,data}', '[]'::jsonb))
               with ordinality as o (l, n)
      ) x
     where not x.proration
       and x.price is not null
       and (x.sub_id = v_sub_id or (x.sub_id is null and v_sub_price is not null))
       and (v_sub_price is null or x.price = v_sub_price)
     order by x.n
     limit 1;
    if v_price is null then
      raise exception 'invoice has no non-proration line for the subscription price'
        using errcode = 'P0404';
    end if;
    select * into v_plan from public.plans pl where pl.stripe_price_id = v_price;
    if not found then
      raise exception 'unknown stripe price' using errcode = 'P0404';
    end if;

    v_grant := private.grant_credits(
      v_user, v_plan.monthly_credits, 'invoice:' || (p_payload ->> 'id'), 'renewal', p_payload ->> 'id');
    update public.credit_wallets w
       set plan_allowance = v_plan.monthly_credits,
           period_end = coalesce(v_end, w.period_end),
           updated_at = pg_catalog.now()
     where w.user_id = v_user;

    v_result := pg_catalog.jsonb_build_object(
      'code', case when (v_grant ->> 'granted')::boolean then 'credits_granted' else 'already_granted' end,
      'granted', (v_grant ->> 'granted')::boolean,
      'user_id', v_user, 'plan', v_plan.plan, 'credits', v_plan.monthly_credits,
      'balance', v_grant -> 'balance');

  else
    v_result := pg_catalog.jsonb_build_object('code', 'ignored');
  end if;

  update public.stripe_events e
     set status = 'processed', result = v_result ->> 'code', processed_at = pg_catalog.now()
   where e.event_id = p_event_id;

  return v_result || pg_catalog.jsonb_build_object('processed', true, 'event_id', p_event_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: service_role only for the RPCs; triggers for nobody.
-- ---------------------------------------------------------------------------
revoke all on function private.release_expired_reservations(uuid) from public, anon, authenticated;
revoke all on function private.reserve_credits(uuid, text, bigint, interval) from public, anon, authenticated;
revoke all on function private.settle_usage(uuid, text, bigint, text, text, integer, integer) from public, anon, authenticated;
revoke all on function private.grant_credits(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function private.grant_free_initial_credits() from public, anon, authenticated, service_role;
revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function private.process_stripe_event(text, text, jsonb) from public, anon, authenticated;

grant execute on function private.release_expired_reservations(uuid) to service_role;
grant execute on function private.reserve_credits(uuid, text, bigint, interval) to service_role;
grant execute on function private.settle_usage(uuid, text, bigint, text, text, integer, integer) to service_role;
grant execute on function private.grant_credits(uuid, bigint, text, text, text) to service_role;
grant execute on function private.process_stripe_event(text, text, jsonb) to service_role;
