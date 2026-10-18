-- B3 follow-up: index the foreign key behind subscriptions_plan_fkey
-- (public.subscriptions.plan -> public.plans.plan), flagged by the Supabase
-- performance advisor (unindexed_foreign_keys). Plain CREATE INDEX: the table
-- is tiny and migrations run inside a transaction (no CONCURRENTLY).
create index if not exists subscriptions_plan_idx on public.subscriptions (plan);
