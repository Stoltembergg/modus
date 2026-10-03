-- L1a: only Starter is for sale. Never edits an earlier migration.
--
-- 1. public.plans: pro, max and ultra become active = false (UPDATE only; no
--    row is deleted, prices and credits are unchanged). free stays active (the
--    default plan, never purchasable) and starter stays active.
--    Checkout already refuses inactive plans: the create-checkout-session
--    Function (_shared/db.ts: "where plan = ... and active") and
--    private.mp_create_checkout ("pl.active and pl.plan <> 'free'").
-- 2. private.process_stripe_event (B3 body, otherwise unchanged): when the
--    Stripe price maps to an inactive plan nothing is credited and nothing is
--    upserted; the event is recorded as processed with
--    stripe_events.result = 'rejected_inactive_plan' (free text, no CHECK),
--    a WARNING is logged and the Function answers 200 (no Stripe retry).
--    Covered: invoice.paid first / renewal and upgrade invoices, and
--    customer.subscription.created / updated / deleted, except a subscription
--    already stored on that same plan, which keeps syncing its status (and its
--    deletion) so existing subscribers are never left stale. Their renewal
--    invoices are still rejected (no credits) while the plan is inactive.
-- Same privilege rules as B1/B3: SECURITY DEFINER, search_path '', service_role only.

update public.plans set active = false where plan in ('pro', 'max', 'ultra');

create or replace function private.process_stripe_event(p_event_id text, p_type text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_customer text;
  v_user uuid;
  v_price text;
  v_plan public.plans%rowtype;
  v_owner uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_grant jsonb;
  v_result jsonb;
  v_sub_id text;
  v_sub_price text;
  v_reason text;
  v_amount_paid numeric;
  v_allowance bigint;
  v_diff bigint;
  v_existing_plan text;
begin
  if p_event_id is null or p_type is null or p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid stripe event arguments' using errcode = '22023';
  end if;
  if (p_payload -> 'livemode') is distinct from 'false'::jsonb then
    raise exception 'only test-mode (livemode false) Stripe objects are accepted'
      using errcode = '22023';
  end if;

  insert into public.stripe_events (event_id, type) values (p_event_id, p_type)
  on conflict (event_id) do nothing;
  if not found then
    select e.status into v_status from public.stripe_events e
     where e.event_id = p_event_id for update;
    if v_status = 'processed' then
      return pg_catalog.jsonb_build_object(
        'processed', false, 'code', 'duplicate', 'event_id', p_event_id);
    end if;
    update public.stripe_events e
       set status = 'processing', type = p_type, result = null, processed_at = null
     where e.event_id = p_event_id;
  end if;

  if p_type in ('customer.subscription.created', 'customer.subscription.updated',
                'customer.subscription.deleted', 'invoice.paid') then
    v_customer := case pg_catalog.jsonb_typeof(p_payload -> 'customer')
      when 'string' then p_payload ->> 'customer'
      when 'object' then p_payload -> 'customer' ->> 'id'
    end;
    if v_customer is null then
      raise exception 'stripe object has no customer' using errcode = '22023';
    end if;
    select pr.id into v_user from public.profiles pr where pr.stripe_customer_id = v_customer;
    if v_user is null then
      raise exception 'unknown stripe customer' using errcode = 'P0404';
    end if;
  end if;

  if p_type in ('customer.subscription.created', 'customer.subscription.updated',
                'customer.subscription.deleted') then
    if p_payload ->> 'object' is distinct from 'subscription' or p_payload ->> 'id' is null then
      raise exception 'expected a subscription object' using errcode = '22023';
    end if;
    v_price := p_payload #>> '{items,data,0,price,id}';
    select * into v_plan from public.plans pl where pl.stripe_price_id = v_price;
    if v_price is null or not found then
      raise exception 'unknown stripe price' using errcode = 'P0404';
    end if;
    v_start := pg_catalog.to_timestamp(coalesce(
      p_payload ->> 'current_period_start', p_payload #>> '{items,data,0,current_period_start}')::double precision);
    v_end := pg_catalog.to_timestamp(coalesce(
      p_payload ->> 'current_period_end', p_payload #>> '{items,data,0,current_period_end}')::double precision);

    select su.user_id into v_owner from public.subscriptions su
     where su.stripe_subscription_id = p_payload ->> 'id' for update;
    if v_owner is not null and v_owner <> v_user then
      raise exception 'subscription belongs to another user' using errcode = 'P0403';
    end if;

    -- A subscription already stored on this same plan (subscribed before the
    -- plan was deactivated) keeps receiving status updates and its deletion:
    -- no credits move here. A new subscription, or a switch INTO an inactive
    -- plan, is rejected.
    select su.plan into v_existing_plan from public.subscriptions su
     where su.stripe_subscription_id = p_payload ->> 'id';
    -- L1a: a price whose plan is inactive (pro / max / ultra) is not applied.
    if not v_plan.active and v_existing_plan is distinct from v_plan.plan then
      raise warning 'stripe event % rejected: rejected_inactive_plan (plan %)', p_event_id, v_plan.plan;
      update public.stripe_events e
         set status = 'processed', result = 'rejected_inactive_plan', processed_at = pg_catalog.now()
       where e.event_id = p_event_id;
      return pg_catalog.jsonb_build_object(
        'processed', true, 'event_id', p_event_id, 'code', 'rejected_inactive_plan',
        'granted', false, 'user_id', v_user, 'plan', v_plan.plan);
    end if;

    insert into public.subscriptions as su
      (user_id, stripe_subscription_id, plan, status, current_period_start,
       current_period_end, cancel_at_period_end)
    values
      (v_user, p_payload ->> 'id', v_plan.plan, coalesce(p_payload ->> 'status', 'unknown'),
       v_start, v_end, coalesce((p_payload ->> 'cancel_at_period_end')::boolean, false))
    on conflict (stripe_subscription_id) do update
       set plan = excluded.plan,
           status = excluded.status,
           current_period_start = excluded.current_period_start,
           current_period_end = excluded.current_period_end,
           cancel_at_period_end = excluded.cancel_at_period_end;

    v_result := pg_catalog.jsonb_build_object(
      'code', 'subscription_upserted', 'user_id', v_user, 'plan', v_plan.plan,
      'status', coalesce(p_payload ->> 'status', 'unknown'));

  elsif p_type = 'invoice.paid' then
    if p_payload ->> 'object' is distinct from 'invoice' or p_payload ->> 'id' is null then
      raise exception 'expected an invoice object' using errcode = '22023';
    end if;
    if p_payload ->> 'status' is distinct from 'paid' then
      raise exception 'invoice is not paid' using errcode = '22023';
    end if;
    -- B3: a paid first / renewal invoice grants the plan's monthly credits
    -- (B1 rule, below). A paid subscription_update invoice (upgrade charged
    -- with proration_behavior=always_invoice) grants only the difference,
    -- see the upgrade branch. $0 invoices (downgrades are scheduled at period
    -- end, 100% coupons) and any other billing_reason grant nothing.
    v_reason := p_payload ->> 'billing_reason';
    v_amount_paid := case when pg_catalog.jsonb_typeof(p_payload -> 'amount_paid') = 'number'
                          then (p_payload ->> 'amount_paid')::numeric end;
    if v_reason is null
       or v_reason not in ('subscription_create', 'subscription_cycle', 'subscription_update')
       or v_amount_paid is null or v_amount_paid <= 0 then
      update public.stripe_events e
         set status = 'processed', result = 'not_grantable', processed_at = pg_catalog.now()
       where e.event_id = p_event_id;
      return pg_catalog.jsonb_build_object(
        'processed', true, 'event_id', p_event_id, 'code', 'not_grantable',
        'granted', false, 'reason', 'not_grantable', 'user_id', v_user,
        'billing_reason', v_reason, 'amount_paid', v_amount_paid);
    end if;

    v_sub_id := coalesce(p_payload ->> 'subscription',
                         p_payload #>> '{parent,subscription_details,subscription}');
    if v_sub_id is null then
      raise exception 'subscription invoice without a subscription id' using errcode = '22023';
    end if;

    -- Server state first: the plan price of the subscription we already know.
    select su.user_id, pl.stripe_price_id into v_owner, v_sub_price
      from public.subscriptions su
      join public.plans pl on pl.plan = su.plan
     where su.stripe_subscription_id = v_sub_id;
    if v_owner is not null and v_owner <> v_user then
      raise exception 'subscription belongs to another user' using errcode = 'P0403';
    end if;

    if v_reason = 'subscription_update' then
      -- Upgrade. New plan: the highest-credit plan among the invoice's
      -- positive lines of this subscription (the charge for the new price;
      -- proration or not), price mapped ONLY through plans.stripe_price_id.
      -- Old plan: server state, the wallet's plan_allowance for the period
      -- (never the invoice). Grant max(0, new - allowance) once per invoice
      -- ('upgrade:<invoice id>'), then raise plan_allowance to the new plan's
      -- credits. plan_allowance never goes down inside a period, so
      -- upgrade -> downgrade -> upgrade grants the difference only once;
      -- subscription_cycle resets it to the renewed plan.
      select pl.* into v_plan
        from (
          select coalesce(l -> 'price' ->> 'id', l #>> '{pricing,price_details,price}') as price,
                 case when pg_catalog.jsonb_typeof(l -> 'amount') = 'number'
                      then (l ->> 'amount')::numeric end as amount,
                 coalesce(l ->> 'subscription',
                          l #>> '{parent,subscription_item_details,subscription}') as sub_id
            from pg_catalog.jsonb_array_elements(coalesce(p_payload #> '{lines,data}', '[]'::jsonb)) as l
        ) x
        join public.plans pl on pl.stripe_price_id = x.price
       where x.amount > 0
         and (x.sub_id = v_sub_id or (x.sub_id is null and v_sub_price is not null))
       order by pl.monthly_credits desc, pl.plan
       limit 1;
      if not found then
        raise exception 'upgrade invoice has no positive line for a known plan price'
          using errcode = 'P0404';
      end if;

      -- L1a: a price whose plan is inactive (pro / max / ultra) is not applied.
      if not v_plan.active then
        raise warning 'stripe event % rejected: rejected_inactive_plan (plan %)', p_event_id, v_plan.plan;
        update public.stripe_events e
           set status = 'processed', result = 'rejected_inactive_plan', processed_at = pg_catalog.now()
         where e.event_id = p_event_id;
        return pg_catalog.jsonb_build_object(
          'processed', true, 'event_id', p_event_id, 'code', 'rejected_inactive_plan',
          'granted', false, 'user_id', v_user, 'plan', v_plan.plan);
      end if;

      select w.plan_allowance into v_allowance
        from public.credit_wallets w
       where w.user_id = v_user
         for update;
      if not found then
        raise exception 'wallet not found' using errcode = 'P0404';
      end if;

      v_diff := greatest(0, v_plan.monthly_credits - v_allowance);
      if v_diff > 0 then
        v_grant := private.grant_credits(
          v_user, v_diff, 'upgrade:' || (p_payload ->> 'id'), 'grant', p_payload ->> 'id');
      else
        v_grant := pg_catalog.jsonb_build_object('granted', false);
      end if;
      update public.credit_wallets w
         set plan_allowance = greatest(w.plan_allowance, v_plan.monthly_credits),
             updated_at = pg_catalog.now()
       where w.user_id = v_user;

      v_result := pg_catalog.jsonb_build_object(
        'code', case when (v_grant ->> 'granted')::boolean then 'upgrade_credits_granted'
                     else 'upgrade_no_credits' end,
        'granted', (v_grant ->> 'granted')::boolean,
        'user_id', v_user, 'plan', v_plan.plan, 'credits', v_diff,
        'previous_allowance', v_allowance,
        'balance', (select w.balance from public.credit_wallets w where w.user_id = v_user));
      update public.stripe_events e
         set status = 'processed', result = v_result ->> 'code', processed_at = pg_catalog.now()
       where e.event_id = p_event_id;
      return v_result || pg_catalog.jsonb_build_object('processed', true, 'event_id', p_event_id);
    end if;

    -- The line that pays for the plan: not a proration, belongs to this
    -- subscription, and (when the server knows the subscription) carries its
    -- price. Never "the first priced line".
    select x.price, x.period_end into v_price, v_end
      from (
        select coalesce(l -> 'price' ->> 'id', l #>> '{pricing,price_details,price}') as price,
               pg_catalog.to_timestamp((l #>> '{period,end}')::double precision) as period_end,
               coalesce((l ->> 'proration')::boolean,
                        (l #>> '{parent,subscription_item_details,proration}')::boolean,
                        false) as proration,
               coalesce(l ->> 'subscription',
                        l #>> '{parent,subscription_item_details,subscription}') as sub_id,
               o.n
          from pg_catalog.jsonb_array_elements(coalesce(p_payload #> '{lines,data}', '[]'::jsonb))
               with ordinality as o (l, n)
      ) x
     where not x.proration
       and x.price is not null
       and (x.sub_id = v_sub_id or (x.sub_id is null and v_sub_price is not null))
       and (v_sub_price is null or x.price = v_sub_price)
     order by x.n
     limit 1;
    if v_price is null then
      raise exception 'invoice has no non-proration line for the subscription price'
        using errcode = 'P0404';
    end if;
    select * into v_plan from public.plans pl where pl.stripe_price_id = v_price;
    if not found then
      raise exception 'unknown stripe price' using errcode = 'P0404';
    end if;

    -- L1a: a price whose plan is inactive (pro / max / ultra) is not applied.
    if not v_plan.active then
      raise warning 'stripe event % rejected: rejected_inactive_plan (plan %)', p_event_id, v_plan.plan;
      update public.stripe_events e
         set status = 'processed', result = 'rejected_inactive_plan', processed_at = pg_catalog.now()
       where e.event_id = p_event_id;
      return pg_catalog.jsonb_build_object(
        'processed', true, 'event_id', p_event_id, 'code', 'rejected_inactive_plan',
        'granted', false, 'user_id', v_user, 'plan', v_plan.plan);
    end if;

    v_grant := private.grant_credits(
      v_user, v_plan.monthly_credits, 'invoice:' || (p_payload ->> 'id'), 'renewal', p_payload ->> 'id');
    update public.credit_wallets w
       set plan_allowance = v_plan.monthly_credits,
           period_end = coalesce(v_end, w.period_end),
           updated_at = pg_catalog.now()
     where w.user_id = v_user;

    v_result := pg_catalog.jsonb_build_object(
      'code', case when (v_grant ->> 'granted')::boolean then 'credits_granted' else 'already_granted' end,
      'granted', (v_grant ->> 'granted')::boolean,
      'user_id', v_user, 'plan', v_plan.plan, 'credits', v_plan.monthly_credits,
      'balance', v_grant -> 'balance');

  else
    v_result := pg_catalog.jsonb_build_object('code', 'ignored');
  end if;

  update public.stripe_events e
     set status = 'processed', result = v_result ->> 'code', processed_at = pg_catalog.now()
   where e.event_id = p_event_id;

  return v_result || pg_catalog.jsonb_build_object('processed', true, 'event_id', p_event_id);
end;
$$;

revoke all on function private.process_stripe_event(text, text, jsonb) from public, anon, authenticated;
grant execute on function private.process_stripe_event(text, text, jsonb) to service_role;
