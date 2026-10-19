-- 2026-10-20 Xero invoice status sync-back (agent: invsync). Additive + idempotent.
--   1. client_invoices: the figures Xero reports back (paid / due / overdue)
--   2. RLS stays admin-only (money) — re-asserted, plus the MFA guard
--   3. pg_cron: run xero-invoice-sync every day at 20:00 GMT
--      (= 06:00 AEST / 07:00 AEDT in Sydney), gated by the vault digest secret.
--
-- MIRRORS: the cron URL below names the CBD project ref. On a mirror, replace
-- tsizneslellcqusjwtub with that project's ref before running, and make sure the
-- mirror has a vault secret named 'digest_secret' equal to its DIGEST_SECRET.

-- ── 1. Columns ───────────────────────────────────────────────────────────────
alter table public.client_invoices add column if not exists amount_due          numeric;   -- inc GST, from Xero
alter table public.client_invoices add column if not exists amount_paid         numeric;   -- inc GST, from Xero
alter table public.client_invoices add column if not exists total               numeric;   -- inc GST, from Xero
alter table public.client_invoices add column if not exists due_date            date;
alter table public.client_invoices add column if not exists fully_paid_on       date;
alter table public.client_invoices add column if not exists xero_synced_at      timestamptz;
alter table public.client_invoices add column if not exists sync_error          text;
-- The day the "overdue" bell went out for this invoice (null = not sent, or
-- the invoice stopped being overdue). One bell per invoice per overdue spell.
alter table public.client_invoices add column if not exists overdue_notified_on date;

create index if not exists client_invoices_xero_sync_idx
  on public.client_invoices (xero_synced_at) where xero_invoice_id is not null;

-- ── 2. Access: admin only (these rows carry dollars) ─────────────────────────
alter table public.client_invoices enable row level security;
drop policy if exists client_invoices_admin on public.client_invoices;
create policy client_invoices_admin on public.client_invoices
  for all to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());
-- anon never needs this table (RLS already returns nothing; drop the grant too).
revoke all on public.client_invoices from anon;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'client_invoices'
                    and policyname = 'require_mfa_when_enrolled') then
    create policy require_mfa_when_enrolled on public.client_invoices
      as restrictive for all to authenticated
      using (public.mfa_satisfied()) with check (public.mfa_satisfied());
  end if;
end $$;

-- ── 3. Daily cron ────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'xero-invoice-sync-daily') then
    perform cron.unschedule('xero-invoice-sync-daily');
  end if;
end $$;

select cron.schedule(
  'xero-invoice-sync-daily',
  '0 20 * * *',
  $cron$
  select net.http_post(
    url := 'https://tsizneslellcqusjwtub.supabase.co/functions/v1/xero-invoice-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-digest-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'digest_secret' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
  $cron$
);
