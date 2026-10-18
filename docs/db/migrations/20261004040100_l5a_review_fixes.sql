-- L5a review fixes (Debbie, on 48678c1).
--
-- 1) Prices with an FX buffer: margin >= 1.25 over US$0.001/credit after the 4.98% MP card
--    fee (D+0) at USD/BRL 5.50 (spot 5.22 on 2026-10-03): 36,90 / 72,90 / 180,90 (the 25k
--    pack needs R$ 180,88: at the limit, accepted). Tiers: 5k / 10k -> starter, 25k -> pro.
-- 2) Several payments of one purchase (the same Checkout Pro preference paid twice) are each
--    credited as their OWN lot (no automatic refund). Lots are keyed by the Mercado Pago
--    payment id (credit_lots.payment_id UNIQUE; purchase_id no longer unique). Reversal state
--    (refunded_minor, reversed_credits, shortfall, status) lives on the lot: a refund or a
--    chargeback of a payment debits only that payment's lot. A chargeback of any payment also
--    marks the purchase charged_back, which blocks the account (private.account_blocked).
--    Idempotent per payment id. Every payment goes through the same checks (live_mode,
--    collector, currency, the purchase's frozen amount); any failure grants nothing. The
--    purchase-level 'rejected_duplicate' result is gone.
-- 3) process_mp_purchase_payment refuses (22023) when the expectations carry no
--    collector_id / live_mode: a NULL expectation would otherwise compare equal to a NULL
--    payment field under IS DISTINCT FROM.
-- Backlog (blocker before mercadopago_subscriptions_enabled = true): a subscription refund
-- (process_mp_payment -> debit_credits) debits the whole balance, so through the lots trigger
-- it can consume purchased lots; it must be capped at private.non_purchased_credits first.

-- ---------------------------------------------------------------------------
-- 1) Prices and tiers
-- ---------------------------------------------------------------------------
update public.credit_packs set amount_minor = 3690 where pack_id = 'credits_5k';
update public.credit_packs set amount_minor = 7290 where pack_id = 'credits_10k';
update public.credit_packs set amount_minor = 18090, access_plan = 'pro' where pack_id = 'credits_25k';
comment on table public.credit_packs is
  'L5a: one-off Mercado Pago credit packs (BRL). Prices: margin >= 1.25 over US$0.001/credit '
  'after the 4.98% card fee at USD/BRL 5.50. access_plan: the plan whose models a holder of an '
  'unspent lot of this pack gets (5k / 10k starter, 25k pro).';

-- ---------------------------------------------------------------------------
-- 2) Lots per payment; reversal state on the lot
-- ---------------------------------------------------------------------------
alter table public.credit_lots drop constraint credit_lots_purchase_id_key;
alter table public.credit_lots
  add column payment_id bigint,
  add column status text not null default 'credited'
    check (status in ('credited', 'refunded', 'charged_back')),
  add column refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  add column reversed_credits bigint not null default 0 check (reversed_credits >= 0),
  add column shortfall bigint not null default 0 check (shortfall >= 0);
update public.credit_lots l
   set payment_id = cp.payment_id, refunded_minor = cp.refunded_minor,
       reversed_credits = cp.reversed_credits, shortfall = cp.shortfall,
       status = case cp.status when 'refunded' then 'refunded'
                               when 'charged_back' then 'charged_back' else 'credited' end
  from public.credit_purchases cp
 where cp.id = l.purchase_id;
alter table public.credit_lots alter column payment_id set not null;
alter table public.credit_lots add constraint credit_lots_payment_id_key unique (payment_id);
create index credit_lots_purchase_idx on public.credit_lots (purchase_id);

alter table public.credit_purchases
  drop column payment_id,
  drop column refunded_minor,
  drop column reversed_credits,
  drop column shortfall;
-- 'paid': at least one payment credited; 'charged_back': a payment was charged back (blocks).
alter table public.credit_purchases drop constraint credit_purchases_status_check;
alter table public.credit_purchases add constraint credit_purchases_status_check
  check (status in ('created', 'paid', 'charged_back'));

-- Owners still read their lots, never the provider payment id.
revoke select on table public.credit_lots from authenticated;
grant select (id, purchase_id, pack_id, credits_granted, remaining, status, created_at)
  on table public.credit_lots to authenticated;

-- ---------------------------------------------------------------------------
-- 2) + 3) Purchase payments
-- Codes: not_a_purchase | rejected_live_mode | rejected_collector | rejected_currency |
-- rejected_amount | rejected_blocked | pending | credited (a new lot for this payment id;
-- 'additional' = true when the purchase already had a credited payment) | already_credited |
-- reversed (refund / chargeback debited from THIS payment's lot).
-- Lock order: purchase -> wallet -> lot (the wallet trigger takes wallet -> lots).
-- ---------------------------------------------------------------------------
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
      select w.balance into v_balance from public.credit_wallets w
       where w.user_id = v_purchase.user_id for update;
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

revoke all on function private.process_mp_purchase_payment(jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function private.process_mp_purchase_payment(jsonb, jsonb, text) to service_role;
