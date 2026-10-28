-- 20261028_pdf_daily_bundle.sql
-- Chris (2026-10-28): site engineers get one email per approved sheet — "4 emails from
-- 1 site". Approved PDFs now wait in the ledger and go out once a night, one email
-- per client site with every PDF attached. Per client: pdf_delivery 'daily' (default)
-- or 'instant' (the old behaviour). Additive: one column, one status, one cron job.

alter table public.clients add column if not exists pdf_delivery text not null default 'daily';
do $$ begin
  alter table public.clients add constraint clients_pdf_delivery_check check (pdf_delivery in ('instant', 'daily'));
exception when duplicate_object then null; end $$;
grant select (pdf_delivery) on public.clients to authenticated;

-- 'held' = PDF built and stored, waiting for tonight's bundle.
do $$ declare r record; begin
  for r in select conname from pg_constraint
           where conrelid = 'public.timesheet_sends'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%status%'
  loop execute format('alter table public.timesheet_sends drop constraint %I', r.conname); end loop;
end $$;
alter table public.timesheet_sends add constraint timesheet_sends_status_check
  check (status in ('queued', 'held', 'sent', 'failed'));
alter table public.timesheet_sends add column if not exists batch_id uuid;
create index if not exists timesheet_sends_held_idx on public.timesheet_sends (created_at) where status = 'held';

-- Hourly; the function itself only sends in the Sydney midnight hour (or when a
-- held row is older than 26 h, so a missed night still goes out).
do $$ begin perform cron.unschedule('timesheet-pdf-daily-bundle'); exception when others then null; end $$;
select cron.schedule('timesheet-pdf-daily-bundle', '5 * * * *',
  $$select net.http_post(
      url:='https://tsizneslellcqusjwtub.supabase.co/functions/v1/send-timesheet-bundle-daily',
      headers:=jsonb_build_object('Content-Type','application/json','x-digest-secret',(select decrypted_secret from vault.decrypted_secrets where name='digest_secret' limit 1)),
      body:='{}'::jsonb)$$);
