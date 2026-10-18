-- L3a (Grok, 2026-10-04): per-plan default model for the model-router.
-- 1) public.plans.default_model: the model the router uses when a request names none.
--    NULL = no default (the router answers 400 model_required). It must be one of the plan's
--    allowed_models when the plan has an explicit list (NULL allowed_models = every model).
-- 2) Seed: deepseek/deepseek-flash (the cheapest catalog model, allowed on every plan) for
--    every plan. PROVISIONAL: Grok/Gabriel may pick a different Starter default later.
-- Readable like the rest of public.plans (table-level select for anon / authenticated).

alter table public.plans add column if not exists default_model text;

update public.plans set default_model = 'deepseek/deepseek-flash' where default_model is null;

alter table public.plans
  add constraint plans_default_model_allowed
  check (default_model is null or allowed_models is null or default_model = any (allowed_models));
