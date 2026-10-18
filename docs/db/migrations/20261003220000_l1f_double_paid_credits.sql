-- L1f: paid plans grant twice the monthly credits; prices unchanged; Free
-- stays 1000.
--
--   starter 10000 -> 20000   (R$ 49,90 / USD 9)
--   pro     25000 -> 50000
--   max     70000 -> 140000
--   ultra  150000 -> 300000
--
-- Only public.plans.monthly_credits changes. Every credit path reads it at
-- grant time (Stripe invoice.paid subscription_create / subscription_cycle /
-- upgrade difference, Mercado Pago approved payments, get_billing_catalog), so
-- an existing subscriber gets the new amount at the next renewal.
--
-- No retroactive grant: no wallet balance, ledger row or
-- credit_wallets.plan_allowance is touched here. plan_allowance is the
-- per-wallet snapshot of the current period's plan credits; the next renewal
-- resets it to the new value. Mercado Pago reversals keep using each payment's
-- stored credited_amount, so a refund of a pre-L1f payment debits the old
-- amount.
--
-- Explicit target values (not "* 2") keep a re-run harmless.

update public.plans pl
   set monthly_credits = v.credits
  from (values ('starter', 20000::bigint),
               ('pro',     50000::bigint),
               ('max',     140000::bigint),
               ('ultra',   300000::bigint)) as v (plan, credits)
 where pl.plan = v.plan;

do $$
begin
  if (select string_agg(p.plan || '=' || p.monthly_credits, ',' order by p.sort_order)
        from public.plans p)
     is distinct from 'free=1000,starter=20000,pro=50000,max=140000,ultra=300000' then
    raise exception 'L1f: unexpected plan credits after update';
  end if;
end;
$$;
