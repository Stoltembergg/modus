-- L5c (Grok + Debbie decisions, 2026-10-03).
-- 1) credits_25k costs R$ 181,90 (18190). 5k / 10k unchanged (3690 / 7290). Existing purchases
--    keep the price frozen on their row.
-- 2) private.mp_create_purchase rate limit: at most 5 purchases still in status 'created'
--    (checkout opened, not paid) per user in the last 10 minutes. Counted AFTER the profile
--    row lock, so parallel calls for one user serialize and the 6th sees the first 5.
--    Returns {"code": "too_many_purchases"}; mp-buy-credits maps it to HTTP 429.
-- 3) Starter's explicit allowed_models gains anthropic/claude-opus-5-5 (PROVISIONAL: added to
--    the router's MODEL_CATALOG with vibi /api/pricing prices, pending the upstream probe).
--    anthropic/claude-fable-5-1 is Pro+ only (Pro / Max / Ultra keep NULL = every model).

update public.credit_packs set amount_minor = 18190 where pack_id = 'credits_25k';

create or replace function private.mp_create_purchase(p_user_id uuid, p_pack_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack public.credit_packs%rowtype;
  v_new public.credit_purchases%rowtype;
  v_open integer;
begin
  if p_user_id is null or p_pack_id is null then
    raise exception 'invalid purchase arguments' using errcode = '22023';
  end if;
  perform 1 from public.profiles pr where pr.id = p_user_id for update;
  if not found then
    raise exception 'profile not found' using errcode = 'P0404';
  end if;
  if not coalesce((select bs.mercadopago_enabled from private.billing_settings bs where bs.id), false) then
    return pg_catalog.jsonb_build_object('code', 'unknown_pack');
  end if;
  select cp.* into v_pack from public.credit_packs cp where cp.pack_id = p_pack_id and cp.active;
  if v_pack.pack_id is null then
    return pg_catalog.jsonb_build_object('code', 'unknown_pack');
  end if;
  if private.account_blocked(p_user_id) then
    return pg_catalog.jsonb_build_object('code', 'blocked');
  end if;
  -- Under the profile lock: concurrent calls of this user see each other's inserts.
  select count(*)::integer into v_open
    from public.credit_purchases cp
   where cp.user_id = p_user_id
     and cp.status = 'created'
     and cp.created_at > pg_catalog.now() - interval '10 minutes';
  if v_open >= 5 then
    return pg_catalog.jsonb_build_object('code', 'too_many_purchases');
  end if;
  insert into public.credit_purchases (user_id, pack_id, credits, amount_minor, currency)
  values (p_user_id, v_pack.pack_id, v_pack.credits, v_pack.amount_minor, v_pack.currency)
  returning * into v_new;
  return pg_catalog.jsonb_build_object(
    'code', 'created', 'purchase_id', v_new.id, 'pack_id', v_new.pack_id, 'name', v_pack.name,
    'credits', v_new.credits, 'amount_minor', v_new.amount_minor, 'currency', v_new.currency);
end;
$$;

revoke all on function private.mp_create_purchase(uuid, text) from public, anon, authenticated;
grant execute on function private.mp_create_purchase(uuid, text) to service_role;

update public.plans
   set allowed_models = array['deepseek/deepseek-flash', 'zai/glm-5.3-flash', 'anthropic/claude-opus-5-5']
 where plan = 'starter';
