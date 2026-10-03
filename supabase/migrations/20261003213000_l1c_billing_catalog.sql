-- L1c: public billing catalog + DB-side provider visibility flag.
--
-- private.billing_settings is a single-row config table. stripe_enabled
-- (DEFAULT false) decides whether the catalog advertises Stripe prices to the
-- UI; mercadopago_enabled (DEFAULT true) does the same for Mercado Pago. Only
-- migrations / service_role may change it: schema private is not usable by
-- anon / authenticated, and the table has no grant and no policy for them.
--
-- This flag is UI visibility only. Stripe checkout is still gated by the
-- STRIPE_ENABLED env of the Edge Functions (L1b); enabling Stripe needs BOTH.
-- If they disagree nothing gets sold through Stripe (the env blocks checkout,
-- or the UI never offers it).
--
-- public.get_billing_catalog() is the anon / authenticated read path. It is
-- SECURITY DEFINER (plan_prices and private.billing_settings are not readable
-- by the clients) with search_path = '' and returns public data only: no
-- Stripe price id / lookup key, no Mercado Pago ids or credentials.

create table private.billing_settings (
  id boolean primary key default true check (id),
  stripe_enabled boolean not null default false,
  mercadopago_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into private.billing_settings (id) values (true);

alter table private.billing_settings enable row level security;

revoke all on table private.billing_settings from public, anon, authenticated;
grant select, update on table private.billing_settings to service_role;

create trigger billing_settings_set_updated_at
  before update on private.billing_settings
  for each row execute function private.set_updated_at();

create function public.get_billing_catalog()
returns table (
  plan text,
  name text,
  monthly_credits bigint,
  provider text,
  currency text,
  amount_minor bigint,
  sort_order integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select bs.stripe_enabled, bs.mercadopago_enabled
      from private.billing_settings bs
     where bs.id
  )
  select pl.plan, pl.name, pl.monthly_credits, pp.provider, pp.currency, pp.amount_minor, pl.sort_order
    from public.plans pl
    join public.plan_prices pp on pp.plan = pl.plan
    cross join s
   where pl.active
     and pl.plan <> 'free'
     and pp.active
     and pp.provider = 'mercadopago'
     and s.mercadopago_enabled
  union all
  select pl.plan, pl.name, pl.monthly_credits, 'stripe', 'USD', pl.price_usd_cents::bigint, pl.sort_order
    from public.plans pl
    cross join s
   where pl.active
     and pl.plan <> 'free'
     and pl.stripe_price_id is not null
     and pl.price_usd_cents > 0
     and s.stripe_enabled
  order by 7, 1, 4, 5
$$;

comment on function public.get_billing_catalog() is
  'L1c: active paid plans with their enabled providers and prices (public data only). '
  'Stripe rows only when private.billing_settings.stripe_enabled; checkout also needs STRIPE_ENABLED=true.';

revoke all on function public.get_billing_catalog() from public, anon, authenticated, service_role;
grant execute on function public.get_billing_catalog() to anon, authenticated;
