-- L1e: cancel a Mercado Pago subscription from the app (Edge Function mp-cancel).
--
-- Two private RPCs (SECURITY DEFINER, search_path '', service_role only). The
-- Function never takes a preapproval id from the client:
--   * mp_cancel_targets(user): the user's own LIVE Mercado Pago subscriptions
--     ('incomplete', 'active', 'trialing', 'past_due', 'unpaid', 'paused'),
--     with the preapproval id that only the server sees. Normally at most one
--     row; 'incomplete' rows are outside the one-live-per-user index, so there
--     can be an extra one, and all of them are returned (cancel = no MP
--     subscription keeps charging).
--   * mp_mark_cancel_requested(user, preapproval): after Mercado Pago accepted
--     PUT /preapproval/{id} {status: canceled} but before the cancellation is
--     confirmed, sets cancel_at_period_end = true on that row (own, live,
--     Mercado Pago only). It does NOT set the final status: 'canceled' comes
--     only from process_mp_preapproval (the mp-webhook, or mp-cancel passing it
--     a re-fetched preapproval whose status is canceled), which also resets
--     cancel_at_period_end. Idempotent.
-- No refund and no credit change: credits already granted stay in the wallet.

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
           'cancel_requested', su.cancel_at_period_end)
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
     set cancel_at_period_end = true
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
