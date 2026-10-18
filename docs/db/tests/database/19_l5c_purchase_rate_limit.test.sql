-- L5c: credits_25k price (R$ 181,90), the purchase rate limit in private.mp_create_purchase
-- (at most 5 purchases in status 'created' per user in the last 10 minutes) and Starter's
-- explicit model list with anthropic/claude-opus-5-5 (claude-fable-* never in Starter).
-- now() is fixed inside this transaction, so time moves by back-dating rows.
begin;
set local search_path = public, extensions;
select plan(16);

update private.billing_settings set mercadopago_enabled = true;

select is((select string_agg(pack_id || ':' || amount_minor, ',' order by sort_order) from public.credit_packs),
  'credits_5k:3690,credits_10k:7290,credits_25k:18190',
  'prices: 36,90 / 72,90 / 181,90');
select ok((select bool_and((amount_minor / 100.0) * (1 - 0.0498) / (credits * 0.001 * 5.50) >= 1.25)
             from public.credit_packs),
  'every pack: margin >= 1.25 after the 4.98% MP card fee at the USD/BRL 5.50 buffer');

select tests.create_user('l5c-rl@example.com', true) as u \gset
select tests.create_user('l5c-other@example.com', true) as o \gset
select tests.as_service_role();
select is(private.mp_create_purchase(:'u', 'credits_5k') ->> 'code', 'created', 'purchase 1');
select is(private.mp_create_purchase(:'u', 'credits_10k') ->> 'code', 'created', 'purchase 2');
select is(private.mp_create_purchase(:'u', 'credits_25k') ->> 'code', 'created', 'purchase 3');
select is(private.mp_create_purchase(:'u', 'credits_5k') ->> 'code', 'created', 'purchase 4');
select is(private.mp_create_purchase(:'u', 'credits_5k') ->> 'code', 'created', 'purchase 5');
select is(private.mp_create_purchase(:'u', 'credits_5k'),
  '{"code": "too_many_purchases"}'::jsonb, '6th open purchase in 10 min: too_many_purchases, nothing else returned');
select tests.clear_authentication();
select is((select count(*)::int from public.credit_purchases where user_id = :'u'), 5, 'the refused one inserted nothing');

-- Another user is not affected.
select tests.as_service_role();
select is(private.mp_create_purchase(:'o', 'credits_5k') ->> 'code', 'created', 'per user: another user can buy');
select tests.clear_authentication();

-- A paid purchase no longer counts (only status 'created').
update public.credit_purchases set status = 'paid'
 where id = (select id from public.credit_purchases where user_id = :'u' order by created_at, id limit 1);
select tests.as_service_role();
select is(private.mp_create_purchase(:'u', 'credits_5k') ->> 'code', 'created', 'a paid purchase frees a slot');
select is(private.mp_create_purchase(:'u', 'credits_5k') ->> 'code', 'too_many_purchases', 'and the limit is back at 5 open');
select tests.clear_authentication();

-- Older than 10 minutes: no longer counted.
update public.credit_purchases set created_at = now() - interval '11 minutes'
 where user_id = :'u' and status = 'created';
select tests.as_service_role();
select is(private.mp_create_purchase(:'u', 'credits_5k') ->> 'code', 'created', 'open purchases older than 10 min do not count');
select tests.clear_authentication();

-- Starter's explicit list.
select is((select allowed_models from public.plans where plan = 'starter'),
  array['deepseek/deepseek-flash', 'zai/glm-5.3-flash', 'anthropic/claude-opus-5-5'],
  'Starter: the two Free models + anthropic/claude-opus-5-5 (provisional)');
select is((select count(*)::int from public.plans, unnest(coalesce(allowed_models, '{}')) m
            where plan = 'starter' and m like '%claude-fable-%'), 0, 'Starter never lists claude-fable-*');
select is((select count(*)::int from public.plans where plan in ('pro', 'max', 'ultra') and allowed_models is not null), 0,
  'pro / max / ultra: every model (NULL)');

select * from finish();
rollback;
