-- A14: a first approved payment may already include a partial refund.
-- Grant the frozen purchase and apply the cumulative proportional reversal in this same
-- transaction. The wallet row lock and payment-id ledger keys preserve concurrency idempotency.
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
  v_reserved bigint;
  v_take bigint := 0;
  v_stuck bigint := 0;
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
      if v_status <> 'approved' then
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
      select w.balance, w.reserved into v_balance, v_reserved from public.credit_wallets w
       where w.user_id = v_purchase.user_id;
      select l.remaining into v_lot.remaining from public.credit_lots l where l.id = v_lot.id;
      v_take := least(v_delta, v_lot.remaining, coalesce(v_balance, 0));
      -- Part of this lot that is still unspent but held by an active reservation: it cannot be
      -- taken now; owe it and collect it when the reservation is released. Spent credits
      -- (the rest of the shortfall) are not recovered.
      v_stuck := greatest(0, least(v_delta - v_take, v_lot.remaining - v_take,
                                   coalesce(v_reserved, 0)));
      if v_take + v_stuck > 0 then
        update public.credit_lots l
           set remaining = l.remaining - (v_take + v_stuck), updated_at = pg_catalog.now()
         where l.id = v_lot.id;
      end if;
      if v_take > 0 or v_stuck > 0 then
        update public.credit_wallets w
           set balance = w.balance - v_take,
               shortfall_owed = w.shortfall_owed + v_stuck,
               updated_at = pg_catalog.now()
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
           remaining = case when case when v_status = 'charged_back' then 'charged_back'
                                       when v_status = 'refunded' and l.status <> 'charged_back' then 'refunded'
                                       else l.status end in ('refunded', 'charged_back')
                            then 0 else l.remaining end,
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

revoke all on function private.process_mp_purchase_payment(jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function private.process_mp_purchase_payment(jsonb, jsonb, text) to service_role;
