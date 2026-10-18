-- B1: optional pg_cron sweep of expired credit reservations (cleanup only).
-- reserve_credits already refunds a user's expired reservations before every
-- new reservation, and settle_usage handles an expired one without charging,
-- so the sweep only returns credits of users who stopped calling the router.
-- Runs only when the pg_cron extension is already installed (on Supabase:
-- enable it under Database > Extensions first); otherwise it does nothing.
-- Re-running is safe: cron.schedule with an existing job name updates it.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    execute $cron$
      select cron.schedule(
        'release-expired-credit-reservations',
        '*/5 * * * *',
        'select private.release_expired_reservations()'
      )
    $cron$;
  end if;
end;
$$;
