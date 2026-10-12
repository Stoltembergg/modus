-- ROLLBACK for supabase/migrations/20261012003000_l5a_refunded_lot_rule.sql.
-- NOT a migration: it lives under docs/rollback/ so `supabase db push` never runs it.
-- Apply by hand (SQL editor or apply_migration with a NEW version) only if the forward
-- migration must be undone. It restores the previous function bodies VERBATIM (copied
-- from the migrations named above each one), drops the view, the helper and the column.
--
-- Before running it, save the open debts, because dropping the column loses them:
--   select * from private.open_credit_shortfalls;
-- The forward migration's guarded data fix (remaining = 0 on non-credited lots) is not
-- reversed: it affected 0 rows in production (checked 2026-10-11).
begin;

drop view if exists private.open_credit_shortfalls;

-- private.non_purchased_credits: previous body from supabase/migrations/20261004040000_l5a_credit_packs.sql:153-165
create or replace function private.non_purchased_credits(p_user_id uuid)
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

-- private.consume_credit_lots: previous body from supabase/migrations/20261004040000_l5a_credit_packs.sql:168-203
create or replace function private.consume_credit_lots()
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

-- private.purchase_access_plan: previous body from supabase/migrations/20261004040000_l5a_credit_packs.sql:714-729
create or replace function private.purchase_access_plan(p_user_id uuid)
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

-- private.settle_usage: previous body from supabase/migrations/20261003021143_b1_auth_billing_schema.sql:418-527
create or replace function private.settle_usage(
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

-- private.release_expired_reservations: previous body from supabase/migrations/20261003063000_b4a_model_router.sql:158-234
create or replace function private.release_expired_reservations(p_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users uuid[];
  v_user uuid;
  v_res record;
  v_cost bigint;
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
      select r.id, r.request_id, r.amount, rr.settle_credits, rr.settle_model,
             rr.settle_provider, rr.settle_input_tokens, rr.settle_output_tokens
        from public.credit_reservations r
        left join public.router_requests rr
          on rr.user_id = r.user_id and rr.idempotency_key = r.request_id
       where r.user_id = v_user
         and r.status = 'active'
         and r.expires_at <= now()
       order by r.created_at, r.id
         for update of r
    loop
      if v_res.settle_credits is not null then
        v_cost := least(v_res.settle_credits, v_res.amount);
        update public.credit_reservations r
           set status = 'settled', settled_amount = v_cost, settled_at = now()
         where r.id = v_res.id;
        update public.credit_wallets w
           set balance = w.balance + (v_res.amount - v_cost),
               reserved = w.reserved - v_res.amount,
               updated_at = now()
         where w.user_id = v_user;
        insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
        values (v_user, v_res.amount - v_cost, 'settle', 'settle:' || v_res.request_id, v_res.request_id)
        on conflict (user_id, idempotency_key) do nothing;
        insert into public.usage_events
          (user_id, request_id, model, provider, input_tokens, output_tokens, credits, status)
        values (v_user, v_res.request_id, v_res.settle_model, v_res.settle_provider,
                coalesce(v_res.settle_input_tokens, 0), coalesce(v_res.settle_output_tokens, 0),
                v_cost, 'billed')
        on conflict (user_id, request_id) do nothing;
      else
        update public.credit_reservations r
           set status = 'expired', settled_at = now()
         where r.id = v_res.id;
        update public.credit_wallets w
           set balance = w.balance + v_res.amount,
               reserved = w.reserved - v_res.amount,
               updated_at = now()
         where w.user_id = v_user;
        insert into public.credit_transactions (user_id, amount, kind, idempotency_key, ref)
        values (v_user, v_res.amount, 'refund', 'expire:' || v_res.request_id, v_res.request_id)
        on conflict (user_id, idempotency_key) do nothing;
      end if;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

-- private.process_mp_purchase_payment: previous body from supabase/migrations/20261004040200_l5a_lock_order_starter_models.sql:16-167
create or replace function private.process_mp_purchase_payment(p_pay jsonb, p_expect jsonb, p_request_id text default null)
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
  v_lot public.credit_lots%rowtype;
  v_additional boolean := false;
  v_target bigint;
  v_delta bigint;
  v_balance bigint;
  v_take bigint := 0;
begin
  if p_pay is null or pg_catalog.jsonb_typeof(p_pay) <> 'object'
     or p_expect is null or pg_catalog.jsonb_typeof(p_expect) <> 'object'
     or coalesce(p_expect ->> 'collector_id', '') !~ '^[0-9]{1,20}$'
     or pg_catalog.jsonb_typeof(p_expect -> 'live_mode') is distinct from 'boolean'
     or coalesce(p_pay ->> 'id', '') !~ '^[0-9]{1,18}$'
     or pg_catalog.jsonb_typeof(p_pay -> 'amount_minor') is distinct from 'number'
     or pg_catalog.jsonb_typeof(p_pay -> 'refunded_minor') is distinct from 'number'
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
  -- Lock order purchase -> wallet -> lot, the same as the lots trigger (wallet -> lots) that
  -- every settle_usage / debit_credits / reserve runs under: the wallet is locked here, before
  -- any lot row, on every path (grant, redelivery, refund, chargeback).
  select w.balance into v_balance from public.credit_wallets w
   where w.user_id = v_purchase.user_id for update;

  -- The same checks for every payment of the purchase (first, second, redelivery).
  v_code := case
    when p_pay -> 'live_mode' is distinct from p_expect -> 'live_mode' then 'rejected_live_mode'
    when p_pay ->> 'collector_id' is distinct from p_expect ->> 'collector_id' then 'rejected_collector'
    when p_pay ->> 'currency' is distinct from v_purchase.currency then 'rejected_currency'
    when v_amount <> v_purchase.amount_minor then 'rejected_amount'
  end;

  if v_code is null then
    select l.* into v_lot from public.credit_lots l where l.payment_id = v_pid for update;
    if v_lot.id is null then
      if v_status <> 'approved' or v_refunded > 0 then
        v_code := 'pending';
      elsif private.account_blocked(v_purchase.user_id) then
        v_code := 'rejected_blocked';
      else
        v_additional := exists (select 1 from public.credit_lots l where l.purchase_id = v_purchase.id);
        perform private.grant_credits(v_purchase.user_id, v_purchase.credits,
          'mp:purchase-payment:' || v_pid, 'purchase', v_purchase.id::text);
        insert into public.credit_lots
          (user_id, purchase_id, pack_id, payment_id, credits_granted, remaining)
        values (v_purchase.user_id, v_purchase.id, v_purchase.pack_id, v_pid,
                v_purchase.credits, v_purchase.credits)
        returning * into v_lot;
        update public.credit_purchases cp
           set status = case when cp.status = 'charged_back' then cp.status else 'paid' end,
               updated_at = pg_catalog.now()
         where cp.id = v_purchase.id;
        v_code := 'credited';
        if v_additional then
          raise warning 'mp purchase % paid again by payment %: credited as a new lot (user %)',
            v_purchase.id, v_pid, v_purchase.user_id;
        end if;
      end if;
    else
      v_code := 'already_credited';
    end if;
  end if;

  -- Reversal of this payment: only its lot, capped at the lot's remaining and the wallet
  -- balance (never negative, never the reserve). Spent credits are not recovered: shortfall.
  if v_code in ('already_credited', 'credited') then
    v_target := case
      when v_status in ('refunded', 'charged_back') then v_lot.credits_granted
      when v_refunded > 0 then least(v_lot.credits_granted, (v_lot.credits_granted * v_refunded) / v_amount)
      else 0
    end;
    v_delta := v_target - v_lot.reversed_credits;
    if v_delta > 0 then
      -- Wallet already locked above; re-read the balance (a grant in this call changed it).
      select w.balance into v_balance from public.credit_wallets w
       where w.user_id = v_purchase.user_id;
      select l.remaining into v_lot.remaining from public.credit_lots l where l.id = v_lot.id;
      v_take := least(v_delta, v_lot.remaining, coalesce(v_balance, 0));
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
      update public.credit_lots l
         set reversed_credits = v_target, shortfall = l.shortfall + (v_delta - v_take),
             updated_at = pg_catalog.now()
       where l.id = v_lot.id;
      v_code := 'reversed';
      if v_delta > v_take then
        raise warning 'mp purchase % payment % reversal shortfall % credits (user %)',
          v_purchase.id, v_pid, v_delta - v_take, v_purchase.user_id;
      end if;
    end if;
    update public.credit_lots l
       set refunded_minor = greatest(l.refunded_minor, v_refunded),
           status = case when v_status = 'charged_back' then 'charged_back'
                         when v_status = 'refunded' and l.status <> 'charged_back' then 'refunded'
                         else l.status end,
           updated_at = pg_catalog.now()
     where l.id = v_lot.id
    returning * into v_lot;
    if v_status = 'charged_back' then
      update public.credit_purchases cp set status = 'charged_back', updated_at = pg_catalog.now()
       where cp.id = v_purchase.id;
    end if;
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
    'user_id', v_purchase.user_id, 'credited', v_code = 'credited', 'additional', v_additional,
    'lot_id', v_lot.id, 'reversed_credits', v_lot.reversed_credits, 'shortfall', v_lot.shortfall,
    'balance', (select w.balance from public.credit_wallets w where w.user_id = v_purchase.user_id));
end;
$$;

-- private.renew_free_credits_for_user: previous body from supabase/migrations/20261010175941_free_monthly_renewal_anchor.sql:183-263
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

drop function if exists private.collect_shortfall(uuid, text, text, bigint);
alter table public.credit_wallets drop column if exists shortfall_owed;

revoke all on function private.non_purchased_credits(uuid) from public, anon, authenticated, service_role;
revoke all on function private.consume_credit_lots() from public, anon, authenticated, service_role;
revoke all on function private.purchase_access_plan(uuid) from public, anon, authenticated;
revoke all on function private.settle_usage(uuid, text, bigint, text, text, integer, integer) from public, anon, authenticated;
revoke all on function private.release_expired_reservations(uuid) from public, anon, authenticated;
revoke all on function private.process_mp_purchase_payment(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.renew_free_credits_for_user(uuid) from public, anon, authenticated;
grant execute on function private.purchase_access_plan(uuid) to service_role;
grant execute on function private.settle_usage(uuid, text, bigint, text, text, integer, integer) to service_role;
grant execute on function private.release_expired_reservations(uuid) to service_role;
grant execute on function private.process_mp_purchase_payment(jsonb, jsonb, text) to service_role;
grant execute on function private.renew_free_credits_for_user(uuid) to service_role;

commit;
