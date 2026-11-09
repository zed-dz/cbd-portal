-- Intake housekeeping (2026-11-09): the PRIVATE worker-intake bucket is a
-- staging area. The photos the office uploads to pre-fill Add Worker are not
-- needed once the worker is saved (ticket photos are copied to cert-photos).
-- A daily cron asks the worker-intake function to delete anything older than
-- 30 days. Same auth shape as timesheet-pdf-daily-bundle: the shared
-- digest_secret from Vault in the x-digest-secret header.
do $$ begin perform cron.unschedule('intake-cleanup-daily'); exception when others then null; end $$;
select cron.schedule('intake-cleanup-daily', '15 16 * * *',   -- 16:15 UTC = 02:15/03:15 Sydney
  $$select net.http_post(
      url:='https://tsizneslellcqusjwtub.supabase.co/functions/v1/worker-intake',
      headers:=jsonb_build_object('Content-Type','application/json','x-digest-secret',(select decrypted_secret from vault.decrypted_secrets where name='digest_secret' limit 1)),
      body:='{"action":"cleanup"}'::jsonb)$$);
