-- Free plan monthly renewal (runs from pg_cron, see 20261004030100_free_renewal_cron.sql).
--
-- Design:
-- * Who: a user with a wallet who already got the Free initial grant
--   ('free-initial:<user>', i.e. a confirmed email) and has no paid
--   entitlement: no subscription in the live paid set (active, trialing,
--   past_due, unpaid, paused; any provider), no L1g grace (a mercadopago
--   row 'canceled' + cancel_at_period_end + current_period_end > now()), and
--   no 'blocked' row (a Mercado Pago chargeback: Free models with whatever
--   balance is left, never new credits). A user in grace keeps the paid
--   plan_allowance until the grace ends; the next run after that renews
--   Free. incomplete / canceled rows are Free and get the renewal.
-- * One predicate: private.free_renewal_check(user, period_end) decides
--   eligibility and due-ness for both the batch pre-filter and the per-user
--   step (re-run under the wallet lock), so they cannot drift and ineligible
--   users never take a place in the batch limit (unconfirmed, paid, grace,
--   blocked, or a Free plan with 0 credits are all excluded up front).
-- * Cadence: per-user monthly anniversary on credit_wallets.period_end, the
--   same field the paid renewals advance. Due when period_end <= now(); a
--   wallet that never had a period (period_end null) is anchored at the
--   Free initial grant + 1 month (the initial grant covers the first month).
--   One renewal per due run, no back-fill. The new period_end is anchor + n
--   months (n >= 1, from the anchor: no day-of-month drift), the first one in
--   the future. period_end ALWAYS advances when due, also when nothing is
--   granted.
-- * Amount: top up to the Free allowance (plans.monthly_credits of 'free',
--   1000): grant max(0, allowance - balance). Credits are never reduced; a
--   balance >= 1000 (leftover paid credits, refunds) stays as is and gets 0.
--   A 0 top-up writes no ledger row (grant_credits is not called).
--   plan_allowance := 1000, period_end := the new end.
-- * Ledger: private.grant_credits, kind 'renewal', ref 'free-renewal',
--   idempotency key 'free-renewal:<user>:<period start, epoch seconds>'.
-- * Result codes (renew_free_credits_for_user ->> 'code'):
--     renewed          due; topped up (amount > 0, one ledger row)
--     renewed_zero     due; balance already >= allowance: 0 granted, no
--                      ledger row, period_end advanced anyway
--     already_renewed  due, but this period's ledger key exists (backstop);
--                      period_end synced, nothing granted
--     not_due          period_end (or signup + 1 month) still in the future
--     paid | grace | blocked | not_eligible | no_free_credits   skipped
--     busy             the wallet is locked right now (router / payment /
--                      another run): retried by the next run
--     no_wallet        unknown user
--   renew_free_credits returns how many users renewed (renewed + renewed_zero).
-- * Idempotent / concurrent: the per-user step locks the wallet
--   (FOR UPDATE SKIP LOCKED), then re-checks everything under the lock
--   (READ COMMITTED: a subscription committed meanwhile is seen). A re-run
--   in the same period finds period_end in the future; the unique ledger key
--   is the backstop. The batch walks users in user_id order.
-- * Signup: the Free initial grant now also sets plan_allowance to the Free
--   allowance (only while it is 0), and existing Free wallets at 0 are
--   backfilled once (plan_allowance only; no balance / ledger change).
-- All functions: SECURITY DEFINER, search_path ''. The two renewal RPCs are
-- service_role only; the predicate and the backfill have no client EXECUTE.

-- ---------------------------------------------------------------------------
-- Shared predicate
-- ---------------------------------------------------------------------------
-- {code, anchor}: code is 'due' | 'not_due' | 'not_eligible' | 'paid' |
-- 'grace' | 'blocked' | 'no_free_credits'; anchor = when the current Free
-- period started counting (period_end, or signup + 1 month).
create function private.free_renewal_check(p_user_id uuid, p_period_end timestamptz)
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
  if exists (select 1 from public.subscriptions su
              where su.user_id = p_user_id and su.status = 'blocked') then
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

-- ---------------------------------------------------------------------------
-- Per-user renewal
-- ---------------------------------------------------------------------------
create function private.renew_free_credits_for_user(p_user_id uuid)
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
  v_topup := greatest(0, v_allowance - v_wallet.balance);
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

-- ---------------------------------------------------------------------------
-- Batch for pg_cron
-- ---------------------------------------------------------------------------
-- Every due, eligible Free user (the same predicate; re-checked per user under
-- its wallet lock). Returns how many renewed (renewed + renewed_zero).
create function private.renew_free_credits(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_count integer := 0;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'invalid renewal arguments' using errcode = '22023';
  end if;
  for v_user in
    select w.user_id
      from public.credit_wallets w
     where private.free_renewal_check(w.user_id, w.period_end) ->> 'code' = 'due'
     order by w.user_id
     limit p_limit
  loop
    if private.renew_free_credits_for_user(v_user) ->> 'code' in ('renewed', 'renewed_zero') then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Signup: plan_allowance = the Free allowance with the initial grant
-- ---------------------------------------------------------------------------
create or replace function private.grant_free_initial_credits()
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
    -- Only while unset: never overwrite a paid plan's allowance.
    update public.credit_wallets w
       set plan_allowance = v_amount, updated_at = pg_catalog.now()
     where w.user_id = new.id and w.plan_allowance = 0;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: existing Free wallets at plan_allowance 0 -> the Free allowance
-- ---------------------------------------------------------------------------
-- plan_allowance only (no balance / ledger change); only wallets the renewal
-- treats as Free (confirmed, not paid / grace / blocked). Idempotent.
create function private.backfill_free_plan_allowance()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount bigint;
  v_count integer;
begin
  select p.monthly_credits into v_amount from public.plans p where p.plan = 'free';
  if coalesce(v_amount, 0) <= 0 then
    return 0;
  end if;
  update public.credit_wallets w
     set plan_allowance = v_amount, updated_at = pg_catalog.now()
   where w.plan_allowance = 0
     and private.free_renewal_check(w.user_id, w.period_end) ->> 'code' in ('due', 'not_due');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.free_renewal_check(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.renew_free_credits_for_user(uuid) from public, anon, authenticated;
revoke all on function private.renew_free_credits(integer) from public, anon, authenticated;
revoke all on function private.backfill_free_plan_allowance() from public, anon, authenticated, service_role;
revoke all on function private.grant_free_initial_credits() from public, anon, authenticated, service_role;
grant execute on function private.renew_free_credits_for_user(uuid) to service_role;
grant execute on function private.renew_free_credits(integer) to service_role;

select private.backfill_free_plan_allowance();
