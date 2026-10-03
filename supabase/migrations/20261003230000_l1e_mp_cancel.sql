-- L1e: cancel a Mercado Pago subscription from the app (Edge Function mp-cancel).
--
-- * public.subscriptions.cancel_requested_at (timestamptz, null): when the user
--   asked to cancel this Mercado Pago subscription and Mercado Pago has not
--   confirmed it yet. It is NOT cancel_at_period_end (Stripe's field, which L1g
--   uses for "cancelled, access until the period end"); L1e never writes that.
--   Clients read it through the existing select-own policy (table-level SELECT);
--   anon / authenticated have no INSERT / UPDATE on the table.
-- * Two private RPCs (SECURITY DEFINER, search_path '', service_role only). The
--   Function never takes a preapproval id from the client:
--   * mp_cancel_targets(user): the user's own LIVE Mercado Pago subscriptions
--     ('incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused'),
--     with the preapproval id that only the server sees. Normally at most one
--     row; 'incomplete' rows are outside the one-live-per-user index, so there
--     can be an extra one, and all of them are returned (cancel = no MP
--     subscription keeps charging).
--   * mp_mark_cancel_requested(user, preapproval): after Mercado Pago accepted
--     PUT /preapproval/{id} {status: canceled} but before the cancellation is
--     confirmed, sets cancel_requested_at = coalesce(cancel_requested_at, now())
--     on that row (own, live, Mercado Pago only). It does NOT set the final
--     status: 'canceled' comes only from process_mp_preapproval (the mp-webhook,
--     or mp-cancel passing it a re-fetched preapproval whose status is
--     canceled). Idempotent.
-- * process_mp_preapproval (B6a) is replaced with one change: it keeps
--   cancel_requested_at while the row stays live (a late 'authorized' or
--   'paused' webhook does not clear the request) and clears it only when the
--   status leaves the live set. Everything else is the B6a body verbatim;
--   SECURITY DEFINER, search_path '' and the grants are unchanged (re-stated).
-- No refund and no credit change: credits already granted stay in the wallet.

alter table public.subscriptions add column cancel_requested_at timestamptz null;
comment on column public.subscriptions.cancel_requested_at is
  'L1e: Mercado Pago cancel requested from the app, not yet confirmed by Mercado Pago. Cleared when the status leaves the live set.';

create function private.mp_cancel_targets(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'preapproval_id', su.provider_subscription_id,
           'status', su.status,
           'cancel_requested', su.cancel_requested_at is not null)
         order by su.updated_at desc, su.id), '[]'::jsonb)
    from public.subscriptions su
   where p_user_id is not null
     and su.user_id = p_user_id
     and su.provider = 'mercadopago'
     and su.provider_subscription_id is not null
     and su.status in ('incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused')
$$;

create function private.mp_mark_cancel_requested(p_user_id uuid, p_preapproval_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or coalesce(p_preapproval_id, '') !~ '^[A-Za-z0-9]{1,64}$' then
    raise exception 'invalid cancel arguments' using errcode = '22023';
  end if;
  update public.subscriptions su
     set cancel_requested_at = coalesce(su.cancel_requested_at, pg_catalog.now())
   where su.user_id = p_user_id
     and su.provider = 'mercadopago'
     and su.provider_subscription_id = p_preapproval_id
     and su.status in ('incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused')
  returning su.id into v_id;
  return pg_catalog.jsonb_build_object('code', case when v_id is null then 'not_found' else 'marked' end);
end;
$$;

revoke all on function private.mp_cancel_targets(uuid) from public, anon, authenticated;
revoke all on function private.mp_mark_cancel_requested(uuid, text) from public, anon, authenticated;
grant execute on function private.mp_cancel_targets(uuid) to service_role;
grant execute on function private.mp_mark_cancel_requested(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- process_mp_preapproval (B6a), replaced: identical except cancel_requested_at
-- (kept while live, cleared when the status leaves the live set).
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
               current_period_end = coalesce(v_next, su.current_period_end),
               cancel_at_period_end = false,
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
