-- L1g: after a cancel, keep the paid plan until current_period_end.
--
-- Design (Mercado Pago only):
-- * When Mercado Pago reports a preapproval canceled (process_mp_preapproval:
--   the mp-webhook, or mp-cancel passing a re-fetched canceled preapproval),
--   the row becomes status 'canceled' as before: it leaves the live set, so
--   mp-cancel has nothing left to do, cancel_requested_at is cleared (L1e) and
--   the one-live-per-user index no longer counts it. NEW: if the row was paid
--   (active / trialing) and current_period_end is still in the future, it gets
--   cancel_at_period_end = true. That is the "paid until" grace: the router
--   (router-db.ts getPlan) grants the plan for a mercadopago row with status
--   'canceled', cancel_at_period_end and current_period_end > now(), and the
--   desktop shows "Cancelled · <Plan> until <date>". Once current_period_end
--   passes, nothing has to run: the same check simply stops matching and the
--   user is on Free. No cron, no status flip.
-- * The cancel never moves current_period_end (the period comes from payments).
-- * No grace when cancelling an incomplete (never paid) or paused (already on
--   Free models) subscription, or after a full refund / chargeback.
-- * A repeat or late webhook on the canceled row keeps the grace.
-- * process_mp_payment (B6a body, replaced): a full refund ('canceled') or a
--   chargeback ('blocked') clears cancel_requested_at (the B6a / L1e rule:
--   cleared only when the row leaves the live set) and the grace; an approved
--   payment that (re)activates a row sets cancel_at_period_end = false, so a
--   reactivated row never shows as "ending" or "cancel requested".
-- Both functions are otherwise verbatim (L1e's process_mp_preapproval, B6a's
-- process_mp_payment); SECURITY DEFINER, search_path '' and the grants are
-- unchanged (re-stated). Stripe rows are untouched (their cancel_at_period_end
-- keeps Stripe's own meaning, and the router grace is mercadopago-only).

-- ---------------------------------------------------------------------------
-- process_mp_preapproval (L1e version + L1g grace)
-- ---------------------------------------------------------------------------
create or replace function private.process_mp_preapproval(p_pre jsonb, p_expect jsonb, p_request_id text default null)
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
               -- L1g: a cancellation never moves the paid period (MP may still send a
               -- next_payment_date for a canceled preapproval).
               current_period_end = case when v_new_status = 'canceled' then su.current_period_end
                                         else coalesce(v_next, su.current_period_end) end,
               -- L1g: cancelling a paid (active / trialing) subscription keeps the plan until
               -- current_period_end (status 'canceled' + cancel_at_period_end); a repeat or
               -- late webhook on the canceled row keeps it; everything else clears it.
               cancel_at_period_end = case
                 when v_new_status = 'canceled' and v_sub.status in ('active', 'trialing')
                   then coalesce(su.current_period_end > pg_catalog.now(), false)
                 when v_new_status = 'canceled' and v_sub.status = 'canceled'
                   then su.cancel_at_period_end
                 else false
               end,
               -- L1e: the cancel request survives every update that keeps the row live.
               cancel_requested_at = case
                 when v_new_status in ('incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused')
                   then su.cancel_requested_at
               end
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

revoke all on function private.process_mp_preapproval(jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function private.process_mp_preapproval(jsonb, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- process_mp_payment (B6a version + L1g: clear on leaving the live set)
-- ---------------------------------------------------------------------------
create or replace function private.process_mp_payment(
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
                   current_period_end = coalesce(v_next, pg_catalog.now() + interval '1 month'),
                   -- L1g: an activation is a new paid period, never "ending".
                   cancel_at_period_end = false
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
    -- L1g: leaving the live set clears the cancel request and any paid-until grace.
    update public.subscriptions su
       set status = 'blocked', cancel_requested_at = null, cancel_at_period_end = false
     where su.provider = 'mercadopago' and su.provider_subscription_id = v_row.preapproval_id;
    update public.billing_checkouts bc set status = 'canceled', updated_at = pg_catalog.now()
     where bc.id = v_checkout.id and bc.status <> 'canceled';
  elsif v_status = 'refunded' then
    update public.subscriptions su
       set status = 'canceled', cancel_requested_at = null, cancel_at_period_end = false
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

revoke all on function private.process_mp_payment(jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function private.process_mp_payment(jsonb, jsonb, jsonb, text) to service_role;
