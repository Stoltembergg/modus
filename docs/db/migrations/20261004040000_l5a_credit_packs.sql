-- L5a: Mercado Pago one-off credit packs (Pix + card), subscriptions OFF.
--
-- * Flag: private.billing_settings.mercadopago_subscriptions_enabled (DEFAULT
--   false). Off: private.mp_create_checkout returns 'subscriptions_disabled'
--   and get_billing_catalog() lists no Mercado Pago subscription plan. All
--   subscription paths stay intact (webhooks, cancel, renewals keep working
--   for rows that already exist).
-- * Packs: public.credit_packs (exactly credits_5k / credits_10k / credits_25k),
--   price and credits only from the DB. Final prices and tiers are set by
--   20261004040100_l5a_review_fixes.sql (the seed below is superseded there):
--   margin >= 1.25 over US$0.001/credit after the MP card fee (4.98%, D+0) at
--   a USD/BRL 5.50 buffer (spot 5.22 on 2026-10-03): 36,90 / 72,90 / 180,90.
--   access_plan: the plan whose models a holder of an unspent lot of this pack
--   gets: 5k / 10k starter, 25k pro (see the L5 PR body).
-- * Purchases: public.credit_purchases freezes pack, credits, amount, currency
--   at creation (private.mp_create_purchase). Mercado Pago payments for it are
--   verified by private.process_mp_purchase_payment against that frozen row.
-- * Lots: public.credit_lots, one per credited payment (keyed by the MP payment
--   id since 20261004040100; credits_granted, remaining; no expiry).
--   Balance split (per wallet):
--     purchased part = sum(credit_lots.remaining)
--     allowance part = (balance + reserved) - purchased part   (>= 0)
--   Consumption order: allowance first, then lots oldest first. It is enforced
--   by a trigger on credit_wallets: whenever balance + reserved goes down
--   (settle_usage charges, debit_credits, reversals) the oldest lots are cut
--   until sum(remaining) <= balance + reserved. A reservation only moves
--   balance -> reserved (total unchanged), so lots are consumed when usage is
--   actually charged, never by a reservation that is later released. The
--   trigger runs under the wallet row lock (lock order wallet -> lots).
-- * Free renewal: tops up only the allowance part (max(0, 1000 - allowance
--   part)); a user who bought credits still gets the Free top-up. A blocked
--   account (subscription OR purchase chargeback) gets no renewal. The batch
--   isolates each user (exception block + private.free_renewal_errors; failing
--   users are ordered last).
-- * Account blocked: private.account_blocked(user) = a 'blocked' subscription
--   or a 'charged_back' credit purchase. Blocked: no purchase-based model
--   access, no new purchase, no Free renewal.

-- ---------------------------------------------------------------------------
-- Flag
-- ---------------------------------------------------------------------------
alter table private.billing_settings
  add column mercadopago_subscriptions_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Ledger kind 'purchase'
-- ---------------------------------------------------------------------------
alter table public.credit_transactions drop constraint credit_transactions_kind_check;
alter table public.credit_transactions add constraint credit_transactions_kind_check
  check (kind in ('grant', 'renewal', 'reserve', 'settle', 'refund', 'adjust', 'purchase'));

-- ---------------------------------------------------------------------------
-- Packs
-- ---------------------------------------------------------------------------
create table public.credit_packs (
  pack_id text primary key check (pack_id ~ '^[a-z0-9_]{1,32}$'),
  name text not null,
  credits bigint not null check (credits > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  amount_minor bigint not null check (amount_minor > 0),
  access_plan text not null references public.plans (plan),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
insert into public.credit_packs (pack_id, name, credits, amount_minor, access_plan, sort_order) values
  ('credits_5k',  '5,000 credits',  5000,  3490,  'starter', 1),
  ('credits_10k', '10,000 credits', 10000, 6890,  'starter', 2),
  ('credits_25k', '25,000 credits', 25000, 17190, 'ultra',   3);
alter table public.credit_packs enable row level security;
revoke all on table public.credit_packs from public, anon, authenticated;
grant select on table public.credit_packs to service_role;

-- ---------------------------------------------------------------------------
-- Purchases and lots
-- ---------------------------------------------------------------------------
create table public.credit_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pack_id text not null references public.credit_packs (pack_id),
  credits bigint not null check (credits > 0),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  status text not null default 'created'
    check (status in ('created', 'paid', 'refunded', 'charged_back')),
  preference_id text check (preference_id ~ '^[A-Za-z0-9-]{1,128}$'),
  checkout_url text,
  payment_id bigint unique,
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  reversed_credits bigint not null default 0 check (reversed_credits >= 0),
  shortfall bigint not null default 0 check (shortfall >= 0),
  last_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credit_purchases_user_idx on public.credit_purchases (user_id, created_at desc);

create table public.credit_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  purchase_id uuid not null unique references public.credit_purchases (id),
  pack_id text not null references public.credit_packs (pack_id),
  credits_granted bigint not null check (credits_granted > 0),
  remaining bigint not null check (remaining >= 0 and remaining <= credits_granted),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credit_lots_user_open_idx on public.credit_lots (user_id, created_at, id)
  where remaining > 0;

-- Owners read their own purchases / lots; nobody writes from the clients.
alter table public.credit_purchases enable row level security;
alter table public.credit_lots enable row level security;
revoke all on table public.credit_purchases, public.credit_lots from public, anon, authenticated;
grant select (id, pack_id, credits, amount_minor, currency, status, created_at)
  on table public.credit_purchases to authenticated;
grant select (id, purchase_id, pack_id, credits_granted, remaining, created_at)
  on table public.credit_lots to authenticated;
grant select, insert, update on table public.credit_purchases, public.credit_lots to service_role;
create policy credit_purchases_select_own on public.credit_purchases
  for select to authenticated using (user_id = (select auth.uid()));
create policy credit_lots_select_own on public.credit_lots
  for select to authenticated using (user_id = (select auth.uid()));

-- Free renewal failures (batch isolation; one row per failing user).
create table private.free_renewal_errors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  failures integer not null default 1,
  last_failed_at timestamptz not null default now(),
  sqlstate text,
  message text
);
revoke all on table private.free_renewal_errors from public, anon, authenticated;
grant select on table private.free_renewal_errors to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.account_blocked(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.subscriptions su
                  where su.user_id = p_user_id and su.status = 'blocked')
      or exists (select 1 from public.credit_purchases cp
                  where cp.user_id = p_user_id and cp.status = 'charged_back')
$$;

-- Allowance (non-purchased) part of the wallet: (balance + reserved) - lots remaining.
create function private.non_purchased_credits(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, w.balance + w.reserved
                     - coalesce((select sum(l.remaining) from public.credit_lots l
                                  where l.user_id = p_user_id), 0))::bigint
    from public.credit_wallets w
   where w.user_id = p_user_id
$$;

-- Trigger: consume lots (oldest first) when the wallet total goes down.
create function private.consume_credit_lots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_excess bigint;
  v_lot record;
  v_take bigint;
begin
  if new.balance + new.reserved >= old.balance + old.reserved then
    return new;
  end if;
  select coalesce(sum(l.remaining), 0) - (new.balance + new.reserved) into v_excess
    from public.credit_lots l
   where l.user_id = new.user_id;
  if v_excess <= 0 then
    return new;
  end if;
  for v_lot in
    select l.id, l.remaining from public.credit_lots l
     where l.user_id = new.user_id and l.remaining > 0
     order by l.created_at, l.id
       for update
  loop
    exit when v_excess <= 0;
    v_take := least(v_lot.remaining, v_excess);
    update public.credit_lots l
       set remaining = l.remaining - v_take, updated_at = pg_catalog.now()
     where l.id = v_lot.id;
    v_excess := v_excess - v_take;
  end loop;
  return new;
end;
$$;

create trigger credit_wallets_consume_lots
  after update of balance, reserved on public.credit_wallets
  for each row execute function private.consume_credit_lots();

create or replace function private.grant_credits(
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
     or p_kind not in ('grant', 'renewal', 'adjust', 'purchase') then
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

create or replace function private.mp_create_checkout(p_user_id uuid, p_plan text)
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
  -- L5: Mercado Pago subscriptions are built but OFF until the flag is turned on.
  if not coalesce((select bs.mercadopago_subscriptions_enabled from private.billing_settings bs
                    where bs.id), false) then
    return pg_catalog.jsonb_build_object('code', 'subscriptions_disabled');
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

  -- L1g: a cancelled Mercado Pago subscription still paid until current_period_end (the
  -- router's grace) blocks a new checkout until that date; same condition as router-db getPlan.
  if exists (select 1 from public.subscriptions su
              where su.user_id = p_user_id
                and su.provider = 'mercadopago'
                and su.status = 'canceled'
                and su.cancel_at_period_end
                and su.current_period_end > pg_catalog.now()) then
    return pg_catalog.jsonb_build_object('code', 'cancel_grace_active');
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

create or replace function private.free_renewal_check(p_user_id uuid, p_period_end timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_initial timestamptz;
  v_anchor timestamptz;
begin
  select ct.created_at into v_initial from public.credit_transactions ct
   where ct.user_id = p_user_id and ct.idempotency_key = 'free-initial:' || p_user_id::text;
  if v_initial is null then
    return pg_catalog.jsonb_build_object('code', 'not_eligible');
  end if;
  if exists (select 1 from public.subscriptions su
              where su.user_id = p_user_id
                and su.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')) then
    return pg_catalog.jsonb_build_object('code', 'paid');
  end if;
  if exists (select 1 from public.subscriptions su
              where su.user_id = p_user_id
                and su.provider = 'mercadopago'
                and su.status = 'canceled'
                and su.cancel_at_period_end
                and su.current_period_end > pg_catalog.now()) then
    return pg_catalog.jsonb_build_object('code', 'grace');
  end if;
  -- L5: a blocked account (subscription or credit-purchase chargeback) gets no renewal.
  if private.account_blocked(p_user_id) then
    return pg_catalog.jsonb_build_object('code', 'blocked');
  end if;
  if coalesce((select pl.monthly_credits from public.plans pl where pl.plan = 'free'), 0) <= 0 then
    return pg_catalog.jsonb_build_object('code', 'no_free_credits');
  end if;
  v_anchor := coalesce(p_period_end, v_initial + interval '1 month');
  return pg_catalog.jsonb_build_object(
    'code', case when v_anchor <= pg_catalog.now() then 'due' else 'not_due' end,
    'anchor', v_anchor);
end;
$$;

create or replace function private.renew_free_credits_for_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet public.credit_wallets%rowtype;
  v_check jsonb;
  v_allowance bigint;
  v_topup bigint;
  v_anchor timestamptz;
  v_n integer := 0;
  v_start timestamptz;
  v_end timestamptz;
  v_grant jsonb;
  v_code text;
  v_balance bigint;
begin
  if p_user_id is null then
    raise exception 'invalid renewal arguments' using errcode = '22023';
  end if;

  select w.* into v_wallet from public.credit_wallets w
   where w.user_id = p_user_id
     for update skip locked;
  if not found then
    if exists (select 1 from public.credit_wallets w where w.user_id = p_user_id) then
      return pg_catalog.jsonb_build_object('code', 'busy');
    end if;
    return pg_catalog.jsonb_build_object('code', 'no_wallet');
  end if;

  v_check := private.free_renewal_check(p_user_id, v_wallet.period_end);
  if v_check ->> 'code' <> 'due' then
    return pg_catalog.jsonb_build_object('code', v_check ->> 'code');
  end if;
  v_anchor := (v_check ->> 'anchor')::timestamptz;
  select pl.monthly_credits into v_allowance from public.plans pl where pl.plan = 'free';

  -- The current period: [anchor + n months, anchor + (n + 1) months) containing now().
  while v_anchor + pg_catalog.make_interval(months => v_n + 1) <= pg_catalog.now() loop
    v_n := v_n + 1;
  end loop;
  v_start := v_anchor + pg_catalog.make_interval(months => v_n);
  v_end := v_anchor + pg_catalog.make_interval(months => v_n + 1);

  -- Top up to the allowance; never reduce. 0 -> no ledger row.
  -- L5: only the non-purchased part counts: (balance + reserved) - purchased lots remaining.
  v_topup := greatest(0, v_allowance - private.non_purchased_credits(p_user_id));
  v_balance := v_wallet.balance;
  if v_topup > 0 then
    v_grant := private.grant_credits(
      p_user_id, v_topup,
      'free-renewal:' || p_user_id::text || ':'
        || pg_catalog.floor(pg_catalog.date_part('epoch', v_start))::bigint::text,
      'renewal', 'free-renewal');
    v_code := case when (v_grant ->> 'granted')::boolean then 'renewed' else 'already_renewed' end;
    v_balance := (v_grant ->> 'balance')::bigint;
    if v_code = 'already_renewed' then
      v_topup := 0;
    end if;
  else
    v_code := 'renewed_zero';
  end if;

  update public.credit_wallets w
     set plan_allowance = v_allowance, period_end = v_end, updated_at = pg_catalog.now()
   where w.user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'code', v_code, 'amount', v_topup, 'period_end', v_end, 'balance', v_balance);
end;
$$;

create or replace function private.renew_free_credits(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_count integer := 0;
  v_code text;
  v_state text;
  v_msg text;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid renewal arguments' using errcode = '22023';
  end if;
  for v_user in
    select w.user_id
      from public.credit_wallets w
      left join private.free_renewal_errors fe on fe.user_id = w.user_id
     where private.free_renewal_check(w.user_id, w.period_end) ->> 'code' = 'due'
     -- L5: users whose last attempt failed go last, so they only use spare capacity.
     order by fe.last_failed_at nulls first, w.user_id
     limit p_limit
  loop
    -- L5: one failing user never aborts the batch (its own subtransaction is rolled back).
    begin
      v_code := private.renew_free_credits_for_user(v_user) ->> 'code';
      if v_code in ('renewed', 'renewed_zero') then
        v_count := v_count + 1;
      end if;
      delete from private.free_renewal_errors fe where fe.user_id = v_user;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise warning 'free renewal failed for user %: % %', v_user, v_state, v_msg;
      insert into private.free_renewal_errors (user_id, failures, last_failed_at, sqlstate, message)
      values (v_user, 1, pg_catalog.clock_timestamp(), v_state, pg_catalog.left(v_msg, 500))
      on conflict (user_id) do update
        set failures = private.free_renewal_errors.failures + 1,
            last_failed_at = excluded.last_failed_at,
            sqlstate = excluded.sqlstate, message = excluded.message;
    end;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchase record (mp-buy-credits, L5b): pack frozen at creation.
-- Codes: created | unknown_pack | blocked.
-- ---------------------------------------------------------------------------
create function private.mp_create_purchase(p_user_id uuid, p_pack_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack public.credit_packs%rowtype;
  v_new public.credit_purchases%rowtype;
begin
  if p_user_id is null or p_pack_id is null then
    raise exception 'invalid purchase arguments' using errcode = '22023';
  end if;
  perform 1 from public.profiles pr where pr.id = p_user_id for update;
  if not found then
    raise exception 'profile not found' using errcode = 'P0404';
  end if;
  if not coalesce((select bs.mercadopago_enabled from private.billing_settings bs where bs.id), false) then
    return pg_catalog.jsonb_build_object('code', 'unknown_pack');
  end if;
  select cp.* into v_pack from public.credit_packs cp where cp.pack_id = p_pack_id and cp.active;
  if v_pack.pack_id is null then
    return pg_catalog.jsonb_build_object('code', 'unknown_pack');
  end if;
  if private.account_blocked(p_user_id) then
    return pg_catalog.jsonb_build_object('code', 'blocked');
  end if;
  insert into public.credit_purchases (user_id, pack_id, credits, amount_minor, currency)
  values (p_user_id, v_pack.pack_id, v_pack.credits, v_pack.amount_minor, v_pack.currency)
  returning * into v_new;
  return pg_catalog.jsonb_build_object(
    'code', 'created', 'purchase_id', v_new.id, 'pack_id', v_new.pack_id, 'name', v_pack.name,
    'credits', v_new.credits, 'amount_minor', v_new.amount_minor, 'currency', v_new.currency);
end;
$$;

-- Stores the Checkout Pro preference of a purchase. Codes: linked | already_linked | conflict | not_found.
create function private.mp_link_purchase(p_purchase_id uuid, p_preference_id text, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.credit_purchases%rowtype;
begin
  if p_purchase_id is null or p_preference_id is null or p_url is null then
    raise exception 'invalid link arguments' using errcode = '22023';
  end if;
  select cp.* into v_row from public.credit_purchases cp where cp.id = p_purchase_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('code', 'not_found');
  end if;
  if v_row.preference_id is not null then
    if v_row.preference_id = p_preference_id then
      return pg_catalog.jsonb_build_object('code', 'already_linked', 'checkout_url', v_row.checkout_url);
    end if;
    return pg_catalog.jsonb_build_object('code', 'conflict');
  end if;
  update public.credit_purchases cp
     set preference_id = p_preference_id, checkout_url = p_url, updated_at = pg_catalog.now()
   where cp.id = p_purchase_id;
  return pg_catalog.jsonb_build_object('code', 'linked', 'checkout_url', p_url);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment of a purchase (mp-webhook topic 'payment', re-fetched GET /v1/payments/{id}).
-- p_pay: the normalized API payment (id, status, amount_minor, refunded_minor, live_mode,
-- collector_id, currency, external_reference). Nothing from the notification body.
-- Codes: not_a_purchase (no purchase with that external_reference: the caller falls back to
-- the subscription path) | rejected_live_mode | rejected_collector | rejected_currency |
-- rejected_amount | rejected_duplicate (a second payment for a credited purchase) |
-- rejected_blocked | pending (not approved: nothing granted) | credited | already_credited |
-- reversed (refund / chargeback debited from this purchase's lot).
-- Lock order: purchase -> wallet -> lot (the wallet trigger also takes wallet -> lots).
-- ---------------------------------------------------------------------------
create function private.process_mp_purchase_payment(p_pay jsonb, p_expect jsonb, p_request_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pid bigint;
  v_ref text := p_pay ->> 'external_reference';
  v_purchase public.credit_purchases%rowtype;
  v_status text := p_pay ->> 'status';
  v_amount bigint;
  v_refunded bigint;
  v_code text;
  v_grant jsonb;
  v_target bigint;
  v_delta bigint;
  v_balance bigint;
  v_lot public.credit_lots%rowtype;
  v_take bigint := 0;
begin
  if p_pay is null or pg_catalog.jsonb_typeof(p_pay) <> 'object' or p_expect is null
     or coalesce(p_pay ->> 'id', '') !~ '^[0-9]{1,18}$'
     or pg_catalog.jsonb_typeof(p_pay -> 'amount_minor') <> 'number'
     or pg_catalog.jsonb_typeof(p_pay -> 'refunded_minor') <> 'number'
     or v_status is null then
    raise exception 'invalid payment arguments' using errcode = '22023';
  end if;
  v_pid := (p_pay ->> 'id')::bigint;
  v_amount := (p_pay ->> 'amount_minor')::bigint;
  v_refunded := least((p_pay ->> 'refunded_minor')::bigint, v_amount);

  if coalesce(v_ref, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return pg_catalog.jsonb_build_object('code', 'not_a_purchase', 'payment_id', v_pid);
  end if;
  select cp.* into v_purchase from public.credit_purchases cp where cp.id = v_ref::uuid for update;
  if not found then
    return pg_catalog.jsonb_build_object('code', 'not_a_purchase', 'payment_id', v_pid);
  end if;

  -- Verify against the frozen purchase and the account's expectations.
  v_code := case
    when p_pay -> 'live_mode' is distinct from p_expect -> 'live_mode' then 'rejected_live_mode'
    when p_pay ->> 'collector_id' is distinct from p_expect ->> 'collector_id' then 'rejected_collector'
    when p_pay ->> 'currency' is distinct from v_purchase.currency then 'rejected_currency'
    when v_amount <> v_purchase.amount_minor then 'rejected_amount'
    when v_purchase.payment_id is not null and v_purchase.payment_id <> v_pid then
      case when v_status = 'approved' then 'rejected_duplicate' else 'other_payment' end
  end;

  if v_code is null and v_purchase.payment_id is null then
    if v_status <> 'approved' or v_refunded > 0 then
      v_code := 'pending';
    elsif private.account_blocked(v_purchase.user_id) then
      v_code := 'rejected_blocked';
    else
      v_grant := private.grant_credits(v_purchase.user_id, v_purchase.credits,
        'mp:purchase-payment:' || v_pid, 'purchase', v_purchase.id::text);
      insert into public.credit_lots (user_id, purchase_id, pack_id, credits_granted, remaining)
      values (v_purchase.user_id, v_purchase.id, v_purchase.pack_id, v_purchase.credits, v_purchase.credits);
      update public.credit_purchases cp
         set status = 'paid', payment_id = v_pid, updated_at = pg_catalog.now()
       where cp.id = v_purchase.id
      returning * into v_purchase;
      v_code := 'credited';
    end if;
  elsif v_code is null then
    v_code := 'already_credited';
  end if;

  -- Reversal of the credited payment: only this purchase's lot, capped at its remaining and
  -- at the wallet balance (never negative). Spent credits are not recovered: shortfall.
  if v_code in ('already_credited', 'credited') then
    v_target := case
      when v_status in ('refunded', 'charged_back') then v_purchase.credits
      when v_refunded > 0 then least(v_purchase.credits, (v_purchase.credits * v_refunded) / v_amount)
      else 0
    end;
    v_delta := v_target - v_purchase.reversed_credits;
    if v_delta > 0 then
      select w.balance into v_balance from public.credit_wallets w
       where w.user_id = v_purchase.user_id for update;
      select l.* into v_lot from public.credit_lots l where l.purchase_id = v_purchase.id for update;
      v_take := least(v_delta, coalesce(v_lot.remaining, 0), coalesce(v_balance, 0));
      if v_take > 0 then
        update public.credit_lots l
           set remaining = l.remaining - v_take, updated_at = pg_catalog.now()
         where l.id = v_lot.id;
        update public.credit_wallets w
           set balance = w.balance - v_take, updated_at = pg_catalog.now()
         where w.user_id = v_purchase.user_id;
      end if;
      insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
      values (v_purchase.user_id, -v_take, 'adjust',
              'mp:purchase-reversal:' || v_pid || ':' || v_target, v_purchase.id::text)
      on conflict (user_id, idempotency_key) do nothing;
      update public.credit_purchases cp
         set reversed_credits = v_target, shortfall = cp.shortfall + (v_delta - v_take),
             updated_at = pg_catalog.now()
       where cp.id = v_purchase.id
      returning * into v_purchase;
      v_code := 'reversed';
      if v_delta > v_take then
        raise warning 'mp purchase % payment % reversal shortfall % credits (user %)',
          v_purchase.id, v_pid, v_delta - v_take, v_purchase.user_id;
      end if;
    end if;
    update public.credit_purchases cp
       set refunded_minor = greatest(cp.refunded_minor, v_refunded),
           status = case when v_status = 'charged_back' then 'charged_back'
                         when v_status = 'refunded' and cp.status <> 'charged_back' then 'refunded'
                         else cp.status end,
           updated_at = pg_catalog.now()
     where cp.id = v_purchase.id
    returning * into v_purchase;
  end if;

  if v_code like 'rejected%' then
    raise warning 'mp purchase % payment % not credited: %', v_purchase.id, v_pid, v_code;
  end if;
  update public.credit_purchases cp set last_result = v_code where cp.id = v_purchase.id;
  if p_request_id is not null then
    perform private.mp_finish_notification(p_request_id, v_code);
  end if;
  return pg_catalog.jsonb_build_object(
    'code', v_code, 'payment_id', v_pid, 'purchase_id', v_purchase.id,
    'user_id', v_purchase.user_id, 'credited', v_code = 'credited',
    'reversed_credits', v_purchase.reversed_credits, 'shortfall', v_purchase.shortfall,
    'balance', (select w.balance from public.credit_wallets w where w.user_id = v_purchase.user_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Router: the plan that purchased lots unlock (null = none). Highest access_plan
-- among the user's lots with remaining > 0; never for a blocked account.
-- ---------------------------------------------------------------------------
create function private.purchase_access_plan(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select cp.access_plan
    from public.credit_lots l
    join public.credit_packs cp on cp.pack_id = l.pack_id
    join public.plans pl on pl.plan = cp.access_plan
   where l.user_id = p_user_id and l.remaining > 0
     and not private.account_blocked(p_user_id)
   order by pl.monthly_credits desc, pl.plan
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- Catalog: + kind ('subscription' | 'pack'); MP subscription plans only when
-- mercadopago_subscriptions_enabled; packs whenever Mercado Pago is enabled.
-- ---------------------------------------------------------------------------
drop function public.get_billing_catalog();
create function public.get_billing_catalog()
returns table (
  plan text,
  name text,
  monthly_credits bigint,
  provider text,
  currency text,
  amount_minor bigint,
  sort_order integer,
  kind text
)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select bs.stripe_enabled, bs.mercadopago_enabled, bs.mercadopago_subscriptions_enabled
      from private.billing_settings bs
     where bs.id
  )
  select pl.plan, pl.name, pl.monthly_credits, pp.provider, pp.currency, pp.amount_minor,
         pl.sort_order, 'subscription'
    from public.plans pl
    join public.plan_prices pp on pp.plan = pl.plan
    cross join s
   where pl.active
     and pl.plan <> 'free'
     and pp.active
     and pp.provider = 'mercadopago'
     and s.mercadopago_enabled
     and s.mercadopago_subscriptions_enabled
  union all
  select pl.plan, pl.name, pl.monthly_credits, 'stripe', 'USD', pl.price_usd_cents::bigint,
         pl.sort_order, 'subscription'
    from public.plans pl
    cross join s
   where pl.active
     and pl.plan <> 'free'
     and pl.stripe_price_id is not null
     and pl.price_usd_cents > 0
     and s.stripe_enabled
  union all
  select cp.pack_id, cp.name, cp.credits, 'mercadopago', cp.currency, cp.amount_minor,
         cp.sort_order, 'pack'
    from public.credit_packs cp
    cross join s
   where cp.active
     and s.mercadopago_enabled
  order by 8 desc, 7, 1, 4, 5
$$;

comment on function public.get_billing_catalog() is
  'L1c/L5a: sellable offers (public data only). kind subscription: active paid plans per enabled '
  'provider (Mercado Pago only with mercadopago_subscriptions_enabled; Stripe only with '
  'stripe_enabled + STRIPE_ENABLED). kind pack: one-off Mercado Pago credit packs.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.get_billing_catalog() from public, anon, authenticated, service_role;
grant execute on function public.get_billing_catalog() to anon, authenticated;

revoke all on function private.grant_credits(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function private.mp_create_checkout(uuid, text) from public, anon, authenticated;
revoke all on function private.free_renewal_check(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.renew_free_credits_for_user(uuid) from public, anon, authenticated;
revoke all on function private.renew_free_credits(integer) from public, anon, authenticated;
revoke all on function private.account_blocked(uuid) from public, anon, authenticated, service_role;
revoke all on function private.non_purchased_credits(uuid) from public, anon, authenticated, service_role;
revoke all on function private.consume_credit_lots() from public, anon, authenticated, service_role;
revoke all on function private.mp_create_purchase(uuid, text) from public, anon, authenticated;
revoke all on function private.mp_link_purchase(uuid, text, text) from public, anon, authenticated;
revoke all on function private.process_mp_purchase_payment(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.purchase_access_plan(uuid) from public, anon, authenticated;

grant execute on function private.grant_credits(uuid, bigint, text, text, text) to service_role;
grant execute on function private.mp_create_checkout(uuid, text) to service_role;
grant execute on function private.renew_free_credits_for_user(uuid) to service_role;
grant execute on function private.renew_free_credits(integer) to service_role;
grant execute on function private.mp_create_purchase(uuid, text) to service_role;
grant execute on function private.mp_link_purchase(uuid, text, text) to service_role;
grant execute on function private.process_mp_purchase_payment(jsonb, jsonb, text) to service_role;
grant execute on function private.purchase_access_plan(uuid) to service_role;
