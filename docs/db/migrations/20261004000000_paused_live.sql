-- Paused subscriptions are live: one live subscription per user, 'paused' included.
--
-- B6a's partial unique index covered active / trialing / past_due / unpaid only.
-- mp_create_checkout and the Functions' LIVE_SUBSCRIPTION_STATUSES already
-- treat 'paused' (a Mercado Pago pause) as live, but process_mp_payment's
-- duplicate pre-check and the index did not, so an approved first payment of a
-- second preapproval could activate it on top of a paused one (two paid plans,
-- double billing once the pause ends). With 'paused' in the index that update
-- raises unique_violation, which process_mp_payment already catches as
-- 'rejected_duplicate' (no credit, recorded for a manual refund); the same holds
-- for process_mp_preapproval (paused -> active while another live row exists).
--
-- 'incomplete' stays out of the index on purpose (an authorized preapproval
-- without an approved payment is not a paid plan; the app still treats it as
-- live so the user cancels it first: "Cancel and try again").
--
-- The live set is now, everywhere: index = active, trialing, past_due, unpaid,
-- paused; app / L1e targets = that + incomplete. The router keeps unlocking
-- paid models only for active / trialing (paused -> Free plan's models).
--
-- Fails loudly instead of silently picking a row if a user already has two
-- rows in the new live set.

do $$
begin
  if exists (
    select 1 from public.subscriptions su
     where su.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')
     group by su.user_id having count(*) > 1
  ) then
    raise exception 'paused_live: a user has more than one live subscription (paused included); resolve it before applying'
      using errcode = '23505';
  end if;
end;
$$;

drop index public.subscriptions_one_live_per_user;
create unique index subscriptions_one_live_per_user
  on public.subscriptions (user_id)
  where status in ('active', 'trialing', 'past_due', 'unpaid', 'paused');
