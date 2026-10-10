-- Keep Free monthly renewal boundaries on a stable calendar anchor. Repeatedly
-- adding one month to a clipped month-end (for example Feb 29) can otherwise
-- drift a Jan 31 anniversary to Mar 29/30.

alter table public.credit_wallets
  add column free_renewal_anchor timestamptz;

create function private.free_renewal_period(
  p_anchor timestamptz,
  p_as_of timestamptz
)
returns table (period_start timestamptz, period_end timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_month_offset integer;
begin
  if p_anchor is null or p_as_of is null or p_as_of < p_anchor then
    raise exception 'invalid renewal period arguments' using errcode = '22023';
  end if;

  -- Estimate the month ordinal, then account for whether this month's anchored
  -- boundary has passed. Both bounds derive from the same anchor so a clipped
  -- February date never becomes the next month's anchor.
  v_month_offset := (
    (pg_catalog.date_part('year', p_as_of) - pg_catalog.date_part('year', p_anchor)) * 12
    + pg_catalog.date_part('month', p_as_of) - pg_catalog.date_part('month', p_anchor)
  )::integer;
  if p_anchor + pg_catalog.make_interval(months => v_month_offset) > p_as_of then
    v_month_offset := v_month_offset - 1;
  end if;

  period_start := p_anchor + pg_catalog.make_interval(months => v_month_offset);
  period_end := p_anchor + pg_catalog.make_interval(months => v_month_offset + 1);
  return next;
end;
$$;

create function private.free_renewal_canonical_end(
  p_anchor timestamptz,
  p_existing_end timestamptz
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when bounds.period_start = p_existing_end then p_existing_end
    else bounds.period_end
  end
    from private.free_renewal_period(p_anchor, p_existing_end) bounds
$$;

create function private.infer_free_renewal_anchor(
  p_user_id uuid,
  p_plan_allowance bigint,
  p_period_end timestamptz,
  p_initial_grant timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_plan_allowance > coalesce(
      (select pl.monthly_credits from public.plans pl where pl.plan = 'free'), 0)
      then coalesce(p_period_end, p_initial_grant)
    else coalesce(
      (select max(su.current_period_end)
         from public.subscriptions su
         join public.plans paid_plan on paid_plan.plan = su.plan
        where su.user_id = p_user_id
          and su.status = 'canceled'
          and su.provider = 'mercadopago'
          and paid_plan.monthly_credits > coalesce(
            (select pl.monthly_credits from public.plans pl where pl.plan = 'free'), 0)
          and su.current_period_end is not null
          and su.current_period_end <= p_period_end
          and exists (
            select 1
              from public.mp_payments mp
              join public.credit_transactions paid_tx on paid_tx.id = mp.credited_tx
             where mp.user_id = su.user_id
               and mp.preapproval_id = su.provider_subscription_id
               and mp.credited_amount = paid_plan.monthly_credits
               and paid_tx.amount = paid_plan.monthly_credits
               and paid_tx.created_at >= coalesce(
                 su.current_period_start,
                 su.current_period_end - interval '1 month')
               and paid_tx.created_at <= su.current_period_end
          )),
      case
        -- Stripe invoices currently retain the user and plan amount in the
        -- ledger but not the subscription id. Treat any such payment only as
        -- evidence that this wallet had a paid cadence; keep its current
        -- deadline as the migration anchor instead of attributing an invoice
        -- to a possibly overlapping canceled subscription.
        when exists (
          select 1
            from public.credit_transactions paid_tx
            join public.plans paid_plan on paid_plan.monthly_credits = paid_tx.amount
           where paid_tx.user_id = p_user_id
             and paid_tx.kind = 'renewal'
             and paid_tx.idempotency_key like 'invoice:%'
             and paid_plan.monthly_credits > coalesce(
               (select pl.monthly_credits from public.plans pl where pl.plan = 'free'), 0)
        ) then coalesce(p_period_end, p_initial_grant)
        else p_initial_grant
      end)
  end
$$;

revoke all on function private.free_renewal_period(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.free_renewal_canonical_end(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.infer_free_renewal_anchor(uuid, bigint, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

-- Existing Free wallets without a prior paid cycle use the initial grant.
-- Wallets that already returned to Free retain the latest canceled paid-plan
-- boundary that still precedes their current renewal deadline.
update public.credit_wallets w
   set free_renewal_anchor = private.infer_free_renewal_anchor(
         w.user_id, w.plan_allowance, w.period_end, ct.created_at)
  from public.credit_transactions ct
 where ct.user_id = w.user_id
   and ct.idempotency_key = 'free-initial:' || w.user_id::text
   and w.free_renewal_anchor is null;

-- Reconcile legacy Free deadlines that were shifted by a clipped month-end.
-- Move only the due marker forward to the next canonical boundary; do not touch
-- balances, transactions, or renewal ledger keys. Paid, grace, and blocked
-- wallets are excluded by both their allowance and the established predicate.
with free_deadlines as (
  select w.user_id,
         private.free_renewal_canonical_end(w.free_renewal_anchor, w.period_end) as canonical_end
    from public.credit_wallets w
   where w.period_end is not null
     and w.free_renewal_anchor is not null
     and w.free_renewal_anchor <= w.period_end
     and w.plan_allowance = coalesce(
       (select pl.monthly_credits from public.plans pl where pl.plan = 'free'), 0)
     and private.free_renewal_check(w.user_id, w.period_end) ->> 'code' in ('due', 'not_due')
)
update public.credit_wallets w
   set period_end = d.canonical_end,
       updated_at = pg_catalog.now()
  from free_deadlines d
 where d.user_id = w.user_id
   and d.canonical_end is distinct from w.period_end;

-- Keep the stable anchor synchronized when a paid provider advances the
-- wallet's due date. Free renewal itself sets the schedule anchor explicitly.
create function private.sync_free_renewal_anchor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_free_allowance bigint;
begin
  select pl.monthly_credits into v_free_allowance
    from public.plans pl where pl.plan = 'free';
  if new.plan_allowance > coalesce(v_free_allowance, 0) then
    new.free_renewal_anchor := new.period_end;
  end if;
  return new;
end;
$$;

revoke all on function private.sync_free_renewal_anchor() from public, anon, authenticated, service_role;
create trigger credit_wallets_sync_free_renewal_anchor
before update of plan_allowance, period_end on public.credit_wallets
for each row execute function private.sync_free_renewal_anchor();

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
  v_initial timestamptz;
  v_schedule_anchor timestamptz;
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

  select ct.created_at into v_initial
    from public.credit_transactions ct
   where ct.user_id = p_user_id
     and ct.idempotency_key = 'free-initial:' || p_user_id::text;
  if v_initial is null then
    return pg_catalog.jsonb_build_object('code', 'not_eligible');
  end if;
  select pl.monthly_credits into v_allowance from public.plans pl where pl.plan = 'free';

  v_schedule_anchor := coalesce(v_wallet.free_renewal_anchor, v_wallet.period_end, v_initial);
  select bounds.period_start, bounds.period_end into v_start, v_end
    from private.free_renewal_period(v_schedule_anchor, pg_catalog.now()) bounds;

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
     set plan_allowance = v_allowance,
         free_renewal_anchor = v_schedule_anchor,
         period_end = v_end,
         updated_at = pg_catalog.now()
   where w.user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'code', v_code, 'amount', v_topup, 'period_end', v_end, 'balance', v_balance);
end;
$$;
