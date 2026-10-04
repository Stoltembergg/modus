-- L3a: public.plans.default_model (router plan default).
begin;
set local search_path = public, extensions;
select plan(9);

select has_column('public', 'plans', 'default_model', 'plans.default_model exists');
select col_type_is('public', 'plans', 'default_model', 'text', 'default_model is text');
select col_is_null('public', 'plans', 'default_model', 'default_model is nullable (no default -> 400)');

select is((select string_agg(plan || ':' || default_model, ',' order by sort_order) from public.plans),
  (select string_agg(plan || ':deepseek/deepseek-flash', ',' order by sort_order) from public.plans),
  'seed: every plan defaults to deepseek/deepseek-flash');

select ok((select bool_and(default_model is null or allowed_models is null
                           or default_model = any (allowed_models)) from public.plans),
  'every seeded default is allowed on its plan');

-- The check: a default outside the plan's explicit list is refused.
select throws_ok(
  $$update public.plans set default_model = 'anthropic/claude-fable-5-1' where plan = 'free'$$,
  '23514', null, 'free cannot default to a model above the plan (fable)');
select throws_ok(
  $$update public.plans set allowed_models = array['zai/glm-5.3-flash'] where plan = 'free'$$,
  '23514', null, 'removing the default from allowed_models is refused');
select lives_ok(
  $$update public.plans set default_model = 'anthropic/claude-fable-5-1' where plan = 'pro'$$,
  'a NULL-allowed_models plan (pro) may default to any model');

-- Readable by the app (table-level select, RLS plans_read_all).
select tests.authenticate_as(tests.create_user('l3a@example.com', true));
select is((select default_model from public.plans where plan = 'free'), 'deepseek/deepseek-flash',
  'authenticated users can read default_model');
select tests.clear_authentication();

select * from finish();
rollback;
