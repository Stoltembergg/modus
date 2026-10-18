-- L1g (decision 2026-10-03): no resubscribe during the paid-until grace, server-side too.
-- private.mp_create_checkout (B6a body, otherwise verbatim) refuses with
-- 'cancel_grace_active' while the user has a Mercado Pago row with status 'canceled',
-- cancel_at_period_end and current_period_end > now() (the router's grace condition).
-- After current_period_end, or for a canceled row without the flag, checkout works as before.
-- Codes: created | reused | unknown_plan | already_subscribed | cancel_grace_active.
-- SECURITY DEFINER, search_path '' and service_role-only grants unchanged (re-stated).

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

revoke all on function private.mp_create_checkout(uuid, text) from public, anon, authenticated;
grant execute on function private.mp_create_checkout(uuid, text) to service_role;
