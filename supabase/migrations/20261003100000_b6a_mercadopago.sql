-- B6a: Mercado Pago card subscriptions (preapproval), provider-agnostic
-- billing additions. Never edits B1/B3/B4a; process_stripe_event is untouched.
--
-- 1. public.plan_prices (plan, provider, currency) -> amount_minor. The BRL
--    prices for Mercado Pago live here (adjustable without a PR). A checkout
--    FREEZES its amount at creation, so changing a price never rejects the
--    renewals of existing subscribers.
-- 2. public.subscriptions gains provider ('stripe' | 'mercadopago') and
--    provider_subscription_id; stripe_subscription_id becomes nullable (still
--    required for provider 'stripe' rows, which keep working unchanged).
--    ONE live subscription per user across providers: partial UNIQUE index on
--    user_id for status active / trialing / past_due / unpaid ('incomplete'
--    excluded, so an unpaid checkout never blocks anything).
-- 3. public.billing_checkouts: the server-side checkout record. Its id is the
--    preapproval external_reference; user and plan ALWAYS come from here.
-- 4. public.mp_notifications: delivery dedupe by x-request-id. A row becomes
--    'processed' only in the same transaction as the processing RPC, so a
--    failed delivery (500) is reprocessed by Mercado Pago's retry.
-- 5. public.mp_payments: idempotency by Mercado Pago payment id. Credit once
--    on 'approved'; refunds / chargebacks reverse cumulatively and
--    proportionally (reversed_amount), never more than credited_amount.
-- 6. Private RPCs (SECURITY DEFINER, search_path '', service_role only):
--    mp_create_checkout, mp_link_checkout, mp_claim_notification,
--    mp_finish_notification, process_mp_preapproval, process_mp_payment and
--    debit_credits (idempotent debit that never takes the balance below 0).
-- Live lock: every Mercado Pago object must carry the expected live_mode and
-- collector, passed by the Function from its config (B6a: live_mode false).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.plan_prices (
  plan text not null references public.plans (plan),
  provider text not null check (provider in ('stripe', 'mercadopago')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (plan, provider, currency)
);

insert into public.plan_prices (plan, provider, currency, amount_minor) values
  ('starter', 'mercadopago', 'BRL', 4990),
  ('pro',     'mercadopago', 'BRL', 10990),
  ('max',     'mercadopago', 'BRL', 26990),
  ('ultra',   'mercadopago', 'BRL', 53990);

alter table public.subscriptions
  add column provider text not null default 'stripe',
  add column provider_subscription_id text,
  alter column stripe_subscription_id drop not null,
  add constraint subscriptions_provider_check check (provider in ('stripe', 'mercadopago')),
  add constraint subscriptions_provider_ids_check check (
    (provider = 'stripe' and stripe_subscription_id is not null and provider_subscription_id is null)
    or (provider = 'mercadopago' and stripe_subscription_id is null
        and provider_subscription_id ~ '^[A-Za-z0-9]{1,64}$')),
  add constraint subscriptions_provider_subscription_key unique (provider, provider_subscription_id);

create unique index subscriptions_one_live_per_user
  on public.subscriptions (user_id)
  where status in ('active', 'trialing', 'past_due', 'unpaid');

create table public.billing_checkouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('mercadopago')),
  plan text not null references public.plans (plan),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  provider_ref text check (provider_ref ~ '^[A-Za-z0-9]{1,64}$'),
  checkout_url text check (checkout_url ~ '^https://'),
  status text not null default 'created'
    check (status in ('created', 'superseded', 'active', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_ref)
);
-- At most one open checkout per user and provider (mp_create_checkout reuses it).
create unique index billing_checkouts_one_open_per_user
  on public.billing_checkouts (user_id, provider) where status = 'created';

create table public.mp_notifications (
  request_id text primary key check (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  topic text not null check (char_length(topic) between 1 and 64),
  data_id text not null check (data_id ~ '^[A-Za-z0-9-]{1,64}$'),
  status text not null default 'received' check (status in ('received', 'processed')),
  attempts integer not null default 1,
  result text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.mp_payments (
  payment_id bigint primary key check (payment_id > 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  checkout_id uuid not null references public.billing_checkouts (id),
  preapproval_id text not null,
  status text not null,
  status_detail text,
  amount_minor bigint not null check (amount_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  currency text not null,
  credited_tx bigint,
  credited_amount bigint not null default 0 check (credited_amount >= 0),
  reversed_amount bigint not null default 0 check (reversed_amount >= 0),
  reversal_shortfall bigint not null default 0 check (reversal_shortfall >= 0),
  refund_seen boolean not null default false,
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reversed_amount <= credited_amount)
);
create index mp_payments_checkout_idx on public.mp_payments (checkout_id);
create index mp_payments_user_idx on public.mp_payments (user_id);

-- No client access at all (RLS on, no policy, no client grants), like stripe_events.
alter table public.plan_prices enable row level security;
alter table public.billing_checkouts enable row level security;
alter table public.mp_notifications enable row level security;
alter table public.mp_payments enable row level security;
revoke all on table public.plan_prices, public.billing_checkouts, public.mp_notifications,
  public.mp_payments from public, anon, authenticated;
grant select, insert, update, delete on table public.plan_prices, public.billing_checkouts,
  public.mp_notifications, public.mp_payments to service_role;

-- ---------------------------------------------------------------------------
-- debit_credits: idempotent debit per (user, key). Debits at most the
-- available balance (never negative); returns debited and shortfall.
-- ---------------------------------------------------------------------------
create function private.debit_credits(
  p_user_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_debit bigint;
  v_tx bigint;
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 or p_idempotency_key is null then
    raise exception 'invalid debit arguments' using errcode = '22023';
  end if;
  select w.balance into v_balance
    from public.credit_wallets w
   where w.user_id = p_user_id
     for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'P0404';
  end if;
  v_debit := least(p_amount, v_balance);
  insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
  values (p_user_id, -v_debit, 'adjust', p_idempotency_key, p_ref)
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_tx;
  if v_tx is null then
    return pg_catalog.jsonb_build_object('duplicate', true, 'debited', 0, 'shortfall', 0,
      'balance', v_balance);
  end if;
  update public.credit_wallets w
     set balance = w.balance - v_debit, updated_at = pg_catalog.now()
   where w.user_id = p_user_id
  returning w.balance into v_balance;
  return pg_catalog.jsonb_build_object('duplicate', false, 'transaction_id', v_tx,
    'debited', v_debit, 'shortfall', p_amount - v_debit, 'balance', v_balance);
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout record
-- ---------------------------------------------------------------------------
-- Creates (or reuses) the user's open Mercado Pago checkout for p_plan.
-- Codes: created | reused | unknown_plan | already_subscribed.
create function private.mp_create_checkout(p_user_id uuid, p_plan text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans%rowtype;
  v_amount bigint;
  v_open public.billing_checkouts%rowtype;
  v_new public.billing_checkouts%rowtype;
begin
  if p_user_id is null or p_plan is null then
    raise exception 'invalid checkout arguments' using errcode = '22023';
  end if;
  -- Serialize checkouts per user (same lock as claim_stripe_customer).
  perform 1 from public.profiles pr where pr.id = p_user_id for update;
  if not found then
    raise exception 'profile not found' using errcode = 'P0404';
  end if;

  select pl.* into v_plan from public.plans pl
   where pl.plan = p_plan and pl.active and pl.plan <> 'free';
  select pp.amount_minor into v_amount from public.plan_prices pp
   where pp.plan = p_plan and pp.provider = 'mercadopago' and pp.currency = 'BRL' and pp.active;
  if v_plan.plan is null or v_amount is null then
    return pg_catalog.jsonb_build_object('code', 'unknown_plan');
  end if;

  -- One live subscription per user across providers (paused counts as live here).
  if exists (select 1 from public.subscriptions su
              where su.user_id = p_user_id
                and su.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')) then
    return pg_catalog.jsonb_build_object('code', 'already_subscribed');
  end if;

  select bc.* into v_open from public.billing_checkouts bc
   where bc.user_id = p_user_id and bc.provider = 'mercadopago' and bc.status = 'created'
     for update;
  if v_open.id is not null and v_open.plan = p_plan then
    return pg_catalog.jsonb_build_object(
      'code', 'reused', 'checkout_id', v_open.id, 'plan', v_open.plan, 'plan_name', v_plan.name,
      'amount_minor', v_open.amount_minor, 'currency', v_open.currency,
      'checkout_url', v_open.checkout_url);
  end if;
  if v_open.id is not null then
    update public.billing_checkouts bc
       set status = 'superseded', updated_at = pg_catalog.now()
     where bc.id = v_open.id;
  end if;

  insert into public.billing_checkouts (user_id, provider, plan, currency, amount_minor)
  values (p_user_id, 'mercadopago', p_plan, 'BRL', v_amount)
  returning * into v_new;
  return pg_catalog.jsonb_build_object(
    'code', 'created', 'checkout_id', v_new.id, 'plan', v_new.plan, 'plan_name', v_plan.name,
    'amount_minor', v_new.amount_minor, 'currency', v_new.currency, 'checkout_url', null);
end;
$$;

-- Stores the preapproval created for a checkout. Codes: linked | already_linked | conflict | not_found.
create function private.mp_link_checkout(p_checkout_id uuid, p_preapproval_id text, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.billing_checkouts%rowtype;
begin
  if p_checkout_id is null or p_preapproval_id is null or p_url is null then
    raise exception 'invalid link arguments' using errcode = '22023';
  end if;
  select bc.* into v_row from public.billing_checkouts bc where bc.id = p_checkout_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('code', 'not_found');
  end if;
  if v_row.provider_ref is not null then
    if v_row.provider_ref = p_preapproval_id then
      return pg_catalog.jsonb_build_object('code', 'already_linked', 'checkout_url', v_row.checkout_url);
    end if;
    return pg_catalog.jsonb_build_object('code', 'conflict');
  end if;
  update public.billing_checkouts bc
     set provider_ref = p_preapproval_id, checkout_url = p_url, updated_at = pg_catalog.now()
   where bc.id = p_checkout_id;
  return pg_catalog.jsonb_build_object('code', 'linked', 'checkout_url', p_url);
end;
$$;

-- ---------------------------------------------------------------------------
-- Notification dedupe
-- ---------------------------------------------------------------------------
-- new | retry (seen, not processed: process again) | duplicate (already processed).
create function private.mp_claim_notification(p_request_id text, p_topic text, p_data_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  insert into public.mp_notifications (request_id, topic, data_id)
  values (p_request_id, p_topic, p_data_id)
  on conflict (request_id) do nothing;
  if found then
    return 'new';
  end if;
  select n.status into v_status from public.mp_notifications n
   where n.request_id = p_request_id for update;
  if v_status = 'processed' then
    return 'duplicate';
  end if;
  update public.mp_notifications n set attempts = n.attempts + 1 where n.request_id = p_request_id;
  return 'retry';
end;
$$;

create function private.mp_finish_notification(p_request_id text, p_result text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.mp_notifications n
     set status = 'processed', result = p_result, processed_at = pg_catalog.now()
   where n.request_id = p_request_id;
$$;

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------
-- Validates a normalized preapproval against its checkout. NULL = ok, else the rejection code.
create function private.mp_preapproval_mismatch(
  p_pre jsonb, p_checkout public.billing_checkouts, p_expect jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_pre ->> 'external_reference' is distinct from p_checkout.id::text then 'rejected_reference'
    when p_pre ->> 'collector_id' is distinct from p_expect ->> 'collector_id' then 'rejected_collector'
    when p_pre ->> 'currency' is distinct from p_checkout.currency then 'rejected_currency'
    when (p_pre ->> 'amount_minor')::bigint is distinct from p_checkout.amount_minor then 'rejected_amount'
    else null
  end
$$;

-- ---------------------------------------------------------------------------
-- process_mp_preapproval: subscription state from a re-fetched preapproval.
-- authorized -> 'incomplete' until the first approved payment ('active' comes
-- only from process_mp_payment); paused / canceled follow; 'blocked'
-- (chargeback) never changes here.
-- ---------------------------------------------------------------------------
create function private.process_mp_preapproval(p_pre jsonb, p_expect jsonb, p_request_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.billing_checkouts%rowtype;
  v_sub public.subscriptions%rowtype;
  v_code text;
  v_status text := p_pre ->> 'status';
  v_next timestamptz;
  v_new_status text;
begin
  if p_pre is null or pg_catalog.jsonb_typeof(p_pre) <> 'object' or p_expect is null
     or coalesce(p_pre ->> 'id', '') !~ '^[A-Za-z0-9]{1,64}$'
     or pg_catalog.jsonb_typeof(p_pre -> 'amount_minor') <> 'number'
     or v_status is null then
    raise exception 'invalid preapproval arguments' using errcode = '22023';
  end if;
  v_next := case when coalesce(p_pre ->> 'next_payment_date', '') <> ''
                 then (p_pre ->> 'next_payment_date')::timestamptz end;

  select bc.* into v_checkout from public.billing_checkouts bc
   where bc.provider = 'mercadopago' and bc.provider_ref = p_pre ->> 'id'
     for update;
  if not found then
    v_code := 'unknown_checkout';
  else
    v_code := private.mp_preapproval_mismatch(p_pre, v_checkout, p_expect);
  end if;

  if v_code is null then
    select su.* into v_sub from public.subscriptions su
     where su.provider = 'mercadopago' and su.provider_subscription_id = p_pre ->> 'id'
       for update;

    if v_sub.id is null then
      if v_status in ('authorized', 'paused') then
        insert into public.subscriptions
          (user_id, provider, provider_subscription_id, plan, status, current_period_end)
        values (v_checkout.user_id, 'mercadopago', p_pre ->> 'id', v_checkout.plan, 'incomplete', v_next);
        v_code := 'subscription_incomplete';
      elsif v_status = 'canceled' then
        if v_checkout.status = 'created' then
          update public.billing_checkouts bc set status = 'canceled', updated_at = pg_catalog.now()
           where bc.id = v_checkout.id;
        end if;
        v_code := 'checkout_canceled';
      else
        v_code := 'pending';
      end if;
    elsif v_sub.status = 'blocked' then
      v_code := 'blocked';
    else
      v_new_status := case
        when v_status = 'canceled' then 'canceled'
        when v_status = 'paused' and v_sub.status = 'active' then 'paused'
        when v_status = 'authorized' and v_sub.status = 'paused' then 'active'
        else v_sub.status
      end;
      begin
        update public.subscriptions su
           set status = v_new_status,
               current_period_end = coalesce(v_next, su.current_period_end),
               cancel_at_period_end = false
         where su.id = v_sub.id;
        v_code := 'subscription_' || v_new_status;
      exception when unique_violation then
        raise warning 'mp preapproval %: user % already has another live subscription; kept %',
          p_pre ->> 'id', v_checkout.user_id, v_sub.status;
        v_code := 'rejected_duplicate';
      end;
      if v_new_status = 'canceled' then
        update public.billing_checkouts bc set status = 'canceled', updated_at = pg_catalog.now()
         where bc.id = v_checkout.id and bc.status in ('created', 'active');
      end if;
    end if;
  end if;

  if p_request_id is not null then
    perform private.mp_finish_notification(p_request_id, v_code);
  end if;
  return pg_catalog.jsonb_build_object('code', v_code, 'preapproval_id', p_pre ->> 'id',
    'user_id', v_checkout.user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- process_mp_payment: one re-fetched payment. p_pre is the re-fetched
-- preapproval of the invoice (subscription_authorized_payment) that links the
-- payment to a checkout; NULL for the bare 'payment' topic, which only
-- updates a payment already linked (never creates one, never credits a new one).
-- ---------------------------------------------------------------------------
create function private.process_mp_payment(
  p_pay jsonb, p_pre jsonb, p_expect jsonb, p_request_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pid bigint;
  v_existing public.mp_payments%rowtype;
  v_row public.mp_payments%rowtype;
  v_checkout public.billing_checkouts%rowtype;
  v_plan public.plans%rowtype;
  v_sub public.subscriptions%rowtype;
  v_status text := p_pay ->> 'status';
  v_amount bigint;
  v_refunded bigint;
  v_code text;
  v_target bigint;
  v_debit jsonb;
  v_grant jsonb;
  v_next timestamptz;
  v_shortfall bigint := 0;
begin
  if p_pay is null or pg_catalog.jsonb_typeof(p_pay) <> 'object' or p_expect is null
     or coalesce(p_pay ->> 'id', '') !~ '^[0-9]{1,18}$'
     or pg_catalog.jsonb_typeof(p_pay -> 'amount_minor') <> 'number'
     or pg_catalog.jsonb_typeof(p_pay -> 'refunded_minor') <> 'number'
     or v_status is null
     or (p_pre is not null and coalesce(p_pre ->> 'id', '') !~ '^[A-Za-z0-9]{1,64}$') then
    raise exception 'invalid payment arguments' using errcode = '22023';
  end if;
  v_pid := (p_pay ->> 'id')::bigint;
  v_amount := (p_pay ->> 'amount_minor')::bigint;
  v_refunded := least((p_pay ->> 'refunded_minor')::bigint, v_amount);
  v_next := case when p_pre is not null and coalesce(p_pre ->> 'next_payment_date', '') <> ''
                 then (p_pre ->> 'next_payment_date')::timestamptz end;

  -- Lock order: checkout -> payment -> subscription -> wallet.
  select mp.* into v_existing from public.mp_payments mp where mp.payment_id = v_pid;
  if v_existing.payment_id is not null then
    select bc.* into v_checkout from public.billing_checkouts bc
     where bc.id = v_existing.checkout_id for update;
    if p_pre is not null and p_pre ->> 'id' is distinct from v_existing.preapproval_id then
      v_code := 'rejected_preapproval';
    end if;
  elsif p_pre is null then
    v_code := 'unlinked';
  else
    select bc.* into v_checkout from public.billing_checkouts bc
     where bc.provider = 'mercadopago' and bc.provider_ref = p_pre ->> 'id'
       for update;
    if not found then
      v_code := 'unknown_checkout';
    end if;
  end if;

  -- Decide only from the API objects, against the frozen checkout.
  if v_code is null and p_pre is not null then
    v_code := private.mp_preapproval_mismatch(p_pre, v_checkout, p_expect);
  end if;
  if v_code is null then
    v_code := case
      when p_pay -> 'live_mode' is distinct from p_expect -> 'live_mode' then 'rejected_live_mode'
      when p_pay ->> 'collector_id' is distinct from p_expect ->> 'collector_id' then 'rejected_collector'
      when p_pay ->> 'currency' is distinct from v_checkout.currency then 'rejected_currency'
      when v_amount <> v_checkout.amount_minor then 'rejected_amount'
      when coalesce(p_pay ->> 'external_reference', '') not in ('', v_checkout.id::text)
        then 'rejected_reference'
    end;
  end if;

  if v_code in ('unlinked', 'unknown_checkout') then
    if p_request_id is not null then
      perform private.mp_finish_notification(p_request_id, v_code);
    end if;
    return pg_catalog.jsonb_build_object('code', v_code, 'payment_id', v_pid);
  end if;

  insert into public.mp_payments
    (payment_id, user_id, checkout_id, preapproval_id, status, status_detail, amount_minor,
     refunded_minor, currency, result)
  values
    (v_pid, v_checkout.user_id, v_checkout.id, coalesce(p_pre ->> 'id', v_checkout.provider_ref),
     v_status, p_pay ->> 'status_detail', v_amount, v_refunded, coalesce(p_pay ->> 'currency', ''), v_code)
  on conflict (payment_id) do nothing;
  select mp.* into v_row from public.mp_payments mp where mp.payment_id = v_pid for update;

  if v_code is not null then
    -- Rejected: nothing moves. The row keeps its money state.
    update public.mp_payments mp set result = v_code, updated_at = pg_catalog.now()
     where mp.payment_id = v_pid;
    raise warning 'mp payment % rejected: %', v_pid, v_code;
    if p_request_id is not null then
      perform private.mp_finish_notification(p_request_id, v_code);
    end if;
    return pg_catalog.jsonb_build_object('code', v_code, 'payment_id', v_pid, 'credited', false);
  end if;

  update public.mp_payments mp
     set status = v_status, status_detail = p_pay ->> 'status_detail',
         refunded_minor = greatest(mp.refunded_minor, v_refunded),
         refund_seen = mp.refund_seen or v_refunded > 0
                       or v_status in ('refunded', 'charged_back'),
         updated_at = pg_catalog.now()
   where mp.payment_id = v_pid
  returning * into v_row;

  select pl.* into v_plan from public.plans pl where pl.plan = v_checkout.plan;

  if v_row.credited_tx is null then
    if v_status = 'approved' and not v_row.refund_seen
       and coalesce(v_row.result, '') not like 'rejected%' then
      select su.* into v_sub from public.subscriptions su
       where su.provider = 'mercadopago' and su.provider_subscription_id = v_row.preapproval_id
         for update;
      if v_sub.status = 'blocked' then
        v_code := 'rejected_blocked';
      elsif exists (select 1 from public.subscriptions su
                     where su.user_id = v_checkout.user_id
                       and su.status in ('active', 'trialing', 'past_due', 'unpaid')
                       and su.id is distinct from v_sub.id) then
        v_code := 'rejected_duplicate';
      else
        begin
          if v_sub.id is null then
            insert into public.subscriptions
              (user_id, provider, provider_subscription_id, plan, status, current_period_start,
               current_period_end)
            values (v_checkout.user_id, 'mercadopago', v_row.preapproval_id, v_checkout.plan, 'active',
                    pg_catalog.now(), coalesce(v_next, pg_catalog.now() + interval '1 month'));
          else
            update public.subscriptions su
               set status = 'active', plan = v_checkout.plan, current_period_start = pg_catalog.now(),
                   current_period_end = coalesce(v_next, pg_catalog.now() + interval '1 month')
             where su.id = v_sub.id;
          end if;
          v_grant := private.grant_credits(v_checkout.user_id, v_plan.monthly_credits,
            'mp:payment:' || v_pid, 'renewal', v_pid::text);
          update public.credit_wallets w
             set plan_allowance = v_plan.monthly_credits,
                 period_end = coalesce(v_next, pg_catalog.now() + interval '1 month'),
                 updated_at = pg_catalog.now()
           where w.user_id = v_checkout.user_id;
          update public.billing_checkouts bc set status = 'active', updated_at = pg_catalog.now()
           where bc.id = v_checkout.id and bc.status in ('created', 'superseded');
          update public.mp_payments mp
             set credited_tx = coalesce((v_grant ->> 'transaction_id')::bigint, 0),
                 credited_amount = v_plan.monthly_credits, result = 'credited'
           where mp.payment_id = v_pid
          returning * into v_row;
          v_code := 'credited';
        exception when unique_violation then
          v_code := 'rejected_duplicate';
        end;
      end if;
      if v_code in ('rejected_duplicate', 'rejected_blocked') then
        update public.mp_payments mp set result = v_code, updated_at = pg_catalog.now()
         where mp.payment_id = v_pid;
        raise warning 'mp payment % not credited (%): user % — refund manually', v_pid, v_code,
          v_checkout.user_id;
      end if;
    else
      v_code := 'recorded';
    end if;
  else
    v_code := 'already_credited';
  end if;

  -- Reversal: cumulative and proportional, never above credited_amount.
  if v_row.credited_tx is not null and v_row.credited_amount > 0 then
    v_target := case
      when v_status in ('refunded', 'charged_back') then v_row.credited_amount
      when v_row.refunded_minor > 0 and v_row.amount_minor > 0
        then least(v_row.credited_amount,
               (v_row.credited_amount * v_row.refunded_minor) / v_row.amount_minor)
      else 0
    end;
    if v_target > v_row.reversed_amount then
      v_debit := private.debit_credits(v_checkout.user_id, v_target - v_row.reversed_amount,
        'mp:reversal:' || v_pid || ':' || v_target, v_pid::text);
      v_shortfall := coalesce((v_debit ->> 'shortfall')::bigint, 0);
      update public.mp_payments mp
         set reversed_amount = v_target,
             reversal_shortfall = mp.reversal_shortfall + v_shortfall,
             result = 'reversed', updated_at = pg_catalog.now()
       where mp.payment_id = v_pid
      returning * into v_row;
      v_code := 'reversed';
      if v_shortfall > 0 then
        raise warning 'mp payment % reversal shortfall % credits (user %)', v_pid, v_shortfall,
          v_checkout.user_id;
      end if;
    end if;
  end if;

  -- Block policy: chargeback blocks; full refund cancels; partial refund only debits.
  if v_status = 'charged_back' then
    update public.subscriptions su set status = 'blocked'
     where su.provider = 'mercadopago' and su.provider_subscription_id = v_row.preapproval_id;
    update public.billing_checkouts bc set status = 'canceled', updated_at = pg_catalog.now()
     where bc.id = v_checkout.id and bc.status <> 'canceled';
  elsif v_status = 'refunded' then
    update public.subscriptions su set status = 'canceled'
     where su.provider = 'mercadopago' and su.provider_subscription_id = v_row.preapproval_id
       and su.status <> 'blocked';
    update public.billing_checkouts bc set status = 'canceled', updated_at = pg_catalog.now()
     where bc.id = v_checkout.id and bc.status <> 'canceled';
  end if;

  if p_request_id is not null then
    perform private.mp_finish_notification(p_request_id, v_code);
  end if;
  return pg_catalog.jsonb_build_object(
    'code', v_code, 'payment_id', v_pid, 'user_id', v_checkout.user_id,
    'credited', v_code = 'credited', 'credited_amount', v_row.credited_amount,
    'reversed_amount', v_row.reversed_amount, 'shortfall', v_row.reversal_shortfall,
    'balance', (select w.balance from public.credit_wallets w where w.user_id = v_checkout.user_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: service_role only.
-- ---------------------------------------------------------------------------
revoke all on function private.debit_credits(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function private.mp_create_checkout(uuid, text) from public, anon, authenticated;
revoke all on function private.mp_link_checkout(uuid, text, text) from public, anon, authenticated;
revoke all on function private.mp_claim_notification(text, text, text) from public, anon, authenticated;
revoke all on function private.mp_finish_notification(text, text) from public, anon, authenticated;
revoke all on function private.mp_preapproval_mismatch(jsonb, public.billing_checkouts, jsonb)
  from public, anon, authenticated;
revoke all on function private.process_mp_preapproval(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.process_mp_payment(jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function private.debit_credits(uuid, bigint, text, text) to service_role;
grant execute on function private.mp_create_checkout(uuid, text) to service_role;
grant execute on function private.mp_link_checkout(uuid, text, text) to service_role;
grant execute on function private.mp_claim_notification(text, text, text) to service_role;
grant execute on function private.mp_finish_notification(text, text) to service_role;
grant execute on function private.process_mp_preapproval(jsonb, jsonb, text) to service_role;
grant execute on function private.process_mp_payment(jsonb, jsonb, jsonb, text) to service_role;
