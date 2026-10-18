-- Free monthly renewal: pg_cron job (same pattern as B1's reservation sweep).
-- Hourly, so a user's monthly anniversary (credit_wallets.period_end) is
-- honoured within the hour; private.renew_free_credits is idempotent, so the
-- cadence only bounds the delay. Runs only when the pg_cron extension is
-- already installed (on Supabase: Database > Extensions); otherwise it does
-- nothing. Re-running is safe: cron.schedule with an existing job name updates it.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    execute $cron$
      select cron.schedule(
        'renew-free-monthly-credits',
        '17 * * * *',
        'select private.renew_free_credits()'
      )
    $cron$;
  end if;
end;
$$;
