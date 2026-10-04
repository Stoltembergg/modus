-- Free plan monthly renewal (runs from pg_cron, see 20261004030100_free_renewal_cron.sql).
--
-- Design:
-- * Who: a user with a wallet who already got the Free initial grant
--   ('free-initial:<user>', i.e. a confirmed email) and has NO paid
--   entitlement: no subscription in the live paid set (active, trialing,
--   past_due, unpaid, paused; any provider) and no L1g grace (a mercadopago
--   row 'canceled' + cancel_at_period_end + current_period_end > now()). A
--   user in grace keeps the paid plan_allowance until the grace ends; the
--   next run after that renews Free. incomplete / canceled / blocked rows
--   are Free (the router gives them the Free plan) and get the renewal.
-- * Cadence: per-user monthly anniversary on credit_wallets.period_end, the
--   same field the paid renewals advance. Due when period_end <= now(); a
--   wallet that never had a period (period_end null) is anchored at the
--   Free initial grant + 1 month (the initial grant covers the first month).
--   One grant per due run, no back-fill: a missed month is not granted
--   twice. The new period_end is anchor + n months (n >= 1, computed from
--   the anchor, so no day-of-month drift), the first one in the future.
-- * Amount: plans.monthly_credits of 'free' (1000), added to the balance
--   like a paid renewal (top-up, no reset: B1/B3/B6a renewals add the
--   plan's monthly_credits and set plan_allowance; nothing is ever wiped).
--   Leftover / paid credits stay. plan_allowance := 1000, period_end := the
--   new end. There is only one balance (no separate purchased bucket).
-- * Ledger: private.grant_credits, kind 'renewal', ref 'free-renewal',
--   idempotency key 'free-renewal:<user>:<period start, epoch seconds>'.
-- * Idempotent / concurrent: the per-user step locks the wallet
--   (FOR UPDATE SKIP LOCKED: a wallet busy with the router is retried on the
--   next run instead of blocking it), then re-checks everything under the
--   lock (READ COMMITTED: a subscription committed meanwhile is seen). A
--   re-run in the same period finds period_end in the future; the unique
--   ledger key is the backstop. The batch walks users in user_id order.
-- Both functions: SECURITY DEFINER, search_path '', service_role only.

create function private.renew_free_credits_for_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet public.credit_wallets%rowtype;
  v_initial timestamptz;
  v_amount bigint;
  v_anchor timestamptz;
  v_n integer := 0;
  v_start timestamptz;
  v_end timestamptz;
  v_grant jsonb;
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

  v_anchor := coalesce(v_wallet.period_end, v_initial + interval '1 month');
  if v_anchor > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('code', 'not_due');
  end if;

  select pl.monthly_credits into v_amount from public.plans pl where pl.plan = 'free';
  if coalesce(v_amount, 0) <= 0 then
    return pg_catalog.jsonb_build_object('code', 'no_free_credits');
  end if;

  -- The current period: [anchor + n months, anchor + (n + 1) months) containing now().
  while v_anchor + pg_catalog.make_interval(months => v_n + 1) <= pg_catalog.now() loop
    v_n := v_n + 1;
  end loop;
  v_start := v_anchor + pg_catalog.make_interval(months => v_n);
  v_end := v_anchor + pg_catalog.make_interval(months => v_n + 1);

  v_grant := private.grant_credits(
    p_user_id, v_amount,
    'free-renewal:' || p_user_id::text || ':' || pg_catalog.floor(pg_catalog.date_part('epoch', v_start))::bigint::text,
    'renewal', 'free-renewal');
  update public.credit_wallets w
     set plan_allowance = v_amount, period_end = v_end, updated_at = pg_catalog.now()
   where w.user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'code', case when (v_grant ->> 'granted')::boolean then 'renewed' else 'already_renewed' end,
    'amount', v_amount, 'period_end', v_end, 'balance', v_grant -> 'balance');
end;
$$;

-- Batch for pg_cron: every due Free user (pre-filtered; each one re-checked
-- under its wallet lock). Returns how many were renewed.
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
      join public.credit_transactions ct
        on ct.user_id = w.user_id and ct.idempotency_key = 'free-initial:' || w.user_id::text
     where coalesce(w.period_end, ct.created_at + interval '1 month') <= pg_catalog.now()
       and not exists (
         select 1 from public.subscriptions su
          where su.user_id = w.user_id
            and (su.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')
                 or (su.provider = 'mercadopago' and su.status = 'canceled'
                     and su.cancel_at_period_end and su.current_period_end > pg_catalog.now())))
     order by w.user_id
     limit p_limit
  loop
    if private.renew_free_credits_for_user(v_user) ->> 'code' = 'renewed' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.renew_free_credits_for_user(uuid) from public, anon, authenticated;
revoke all on function private.renew_free_credits(integer) from public, anon, authenticated;
grant execute on function private.renew_free_credits_for_user(uuid) to service_role;
grant execute on function private.renew_free_credits(integer) to service_role;
