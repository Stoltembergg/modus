-- B4a: models of the Free plan, served through the single upstream gateway
-- (vibi.top). Replaces the B1 seed ['openai/gpt-6-luna', 'deepseek/deepseek-flash']:
-- the gateway does not serve GPT-6 Luna. Ids are `<native provider>/<native id>`
-- from catalog/models.json and must exist in supabase/functions/_shared/model-catalog.ts
-- (model-catalog.test.ts and the router integration test check it).
--   deepseek/deepseek-flash        DeepSeek V4.1 Flash  (gateway: deepseek-v4.1-flash)
--   zai/glm-5.3-flash              GLM-5.3-Flash        (gateway: glm-5.3-flash)
-- Decided by Gabriel (2026-10-03). To change the list, add a new migration like this one.
update public.plans
   set allowed_models = array['deepseek/deepseek-flash', 'zai/glm-5.3-flash']
 where plan = 'free';

do $$
begin
  if not exists (
    select 1 from public.plans
     where plan = 'free'
       and allowed_models = array['deepseek/deepseek-flash', 'zai/glm-5.3-flash']
  ) then
    raise exception 'free plan not found';
  end if;
end;
$$;
