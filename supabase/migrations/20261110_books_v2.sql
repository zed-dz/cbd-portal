-- 20261110_books_v2.sql — Books v2: margin, 13-week cash forecast, debtor
-- chasing, compliance calendar, month-end close, receipts inbox, budgets,
-- demo data flag. Additive + idempotent. Every table is MONEY: readable only
-- by public.is_portal_admin(); admins may WRITE the few tables that hold
-- their own decisions (budgets, closes, promise-to-pay notes, receipt
-- confirmations, snapshots the page computes for Ask-the-books). Xero data
-- itself stays service-role-only.

-- ── 1. Demo flag on the synced tables ───────────────────────────────────────
alter table public.books_transactions add column if not exists is_demo boolean not null default false;
alter table public.books_open_items   add column if not exists is_demo boolean not null default false;
create index if not exists books_transactions_demo_idx on public.books_transactions (is_demo) where is_demo;
create index if not exists books_open_items_demo_idx   on public.books_open_items (is_demo) where is_demo;

-- ── 2. Settings the forecast + calendar need ────────────────────────────────
alter table public.books_settings add column if not exists bas_cycle          text not null default 'quarterly' check (bas_cycle in ('quarterly','monthly'));
alter table public.books_settings add column if not exists payg_cycle         text not null default 'monthly'   check (payg_cycle in ('monthly','quarterly'));
alter table public.books_settings add column if not exists margin_floor_pct   numeric(5,2) not null default 15;
alter table public.books_settings add column if not exists super_rate_pct     numeric(5,2) not null default 12;
alter table public.books_settings add column if not exists payg_rate_pct      numeric(5,2) not null default 20;
alter table public.books_settings add column if not exists payroll_frequency  text not null default 'weekly' check (payroll_frequency in ('weekly','fortnightly'));
alter table public.books_settings add column if not exists payroll_weekday    integer not null default 4 check (payroll_weekday between 0 and 6);   -- 0 = Sunday … 4 = Thursday
alter table public.books_settings add column if not exists bank_balance       numeric(14,2);
alter table public.books_settings add column if not exists bank_balance_date  date;
alter table public.books_settings add column if not exists updated_by         text;

-- ── 3. New tables ───────────────────────────────────────────────────────────
-- Chase log: every email sent about an open invoice, plus promise-to-pay notes.
create table if not exists public.books_chases (
  id              uuid primary key default gen_random_uuid(),
  open_item_xero_id text not null,
  invoice_number  text,
  contact_name    text,
  client_id       uuid,
  kind            text not null default 'chase' check (kind in ('chase','promise','note')),
  to_email        text,
  subject         text,
  body            text,
  promise_date    date,
  promise_amount  numeric(14,2),
  note            text,
  status          text not null default 'sent' check (status in ('sent','failed','noted')),
  error           text,
  provider        text,
  sent_by         text,
  created_at      timestamptz not null default now()
);
create index if not exists books_chases_item_idx on public.books_chases (open_item_xero_id, created_at desc);

-- Receipts inbox: a photo/PDF in the private books-receipts bucket + what the
-- vision model read + the bank line the admin matched it to.
create table if not exists public.books_receipts (
  id               uuid primary key default gen_random_uuid(),
  path             text not null unique,
  uploaded_by      text,
  uploaded_at      timestamptz not null default now(),
  vendor           text,
  receipt_date     date,
  total            numeric(14,2),
  gst              numeric(14,2),
  abn              text,
  account_code     text,
  extracted        jsonb,
  via              text,
  matched_xero_id  text,
  status           text not null default 'new' check (status in ('new','matched','confirmed','rejected')),
  confirmed_by     text,
  confirmed_at     timestamptz,
  is_demo          boolean not null default false
);
create index if not exists books_receipts_status_idx on public.books_receipts (status, uploaded_at desc);

-- Budget per account group per month (editable table on the P&L tab).
create table if not exists public.books_budgets (
  id            uuid primary key default gen_random_uuid(),
  account_group text not null,          -- 'REVENUE' | 'EXPENSE' | a chart account code
  month         date not null,          -- first of month
  amount        numeric(14,2) not null default 0,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  unique (account_group, month)
);

-- Month-end close: one row per month, who closed it, who re-opened it and why.
create table if not exists public.books_month_close (
  month          date primary key,     -- first of month
  closed_by      text,
  closed_at      timestamptz,
  checklist      jsonb,                -- counts at the moment of closing
  reopened_by    text,
  reopened_at    timestamptz,
  reopen_reason  text,
  history        jsonb not null default '[]'::jsonb
);

-- Snapshots the Books page computes in the browser (margin, forecast,
-- compliance) so "Ask the books" can quote the same figures without
-- re-implementing the pay maths in Deno. One row per key.
create table if not exists public.books_snapshots (
  key          text primary key,
  payload      jsonb not null,
  computed_by  text,
  computed_at  timestamptz not null default now()
);

-- Dedupe for the compliance cron: one notification per (obligation, lead days).
create table if not exists public.books_compliance_notified (
  key          text primary key,
  notified_at  timestamptz not null default now()
);

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  -- read-only for admins, writes only by the service role
  foreach t in array array['books_compliance_notified'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s money read" on public.%I', t, t);
    execute format('create policy "%s money read" on public.%I for select to authenticated using ((select public.is_portal_admin()))', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  -- admins read AND write their own decisions
  foreach t in array array['books_chases','books_receipts','books_budgets','books_month_close','books_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s money read" on public.%I', t, t);
    execute format('create policy "%s money read" on public.%I for select to authenticated using ((select public.is_portal_admin()))', t, t);
    execute format('drop policy if exists "%s money write" on public.%I', t, t);
    execute format('create policy "%s money write" on public.%I for insert to authenticated with check ((select public.is_portal_admin()))', t, t);
    execute format('drop policy if exists "%s money update" on public.%I', t, t);
    execute format('create policy "%s money update" on public.%I for update to authenticated using ((select public.is_portal_admin())) with check ((select public.is_portal_admin()))', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke delete, truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
-- Receipts and budgets may be deleted by admins (a wrong upload, a cleared budget cell).
drop policy if exists "books_receipts money delete" on public.books_receipts;
create policy "books_receipts money delete" on public.books_receipts for delete to authenticated using ((select public.is_portal_admin()));
grant delete on public.books_receipts to authenticated;
drop policy if exists "books_budgets money delete" on public.books_budgets;
create policy "books_budgets money delete" on public.books_budgets for delete to authenticated using ((select public.is_portal_admin()));
grant delete on public.books_budgets to authenticated;

-- Settings: admins may now update the few knobs the page exposes.
drop policy if exists "books_settings money update" on public.books_settings;
create policy "books_settings money update" on public.books_settings for update to authenticated using ((select public.is_portal_admin())) with check ((select public.is_portal_admin()));
grant update (large_claim_threshold, bas_cycle, payg_cycle, margin_floor_pct, super_rate_pct, payg_rate_pct, payroll_frequency, payroll_weekday, bank_balance, bank_balance_date, updated_by, updated_at) on public.books_settings to authenticated;

-- ── 5. Private bucket for receipts (admin-only, same shape as worker-intake) ─
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('books-receipts', 'books-receipts', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "books receipts money insert" on storage.objects;
create policy "books receipts money insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'books-receipts' and (select public.is_portal_admin()));
drop policy if exists "books receipts money read" on storage.objects;
create policy "books receipts money read" on storage.objects
  for select to authenticated
  using (bucket_id = 'books-receipts' and (select public.is_portal_admin()));
drop policy if exists "books receipts money delete" on storage.objects;
create policy "books receipts money delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'books-receipts' and (select public.is_portal_admin()));

-- ── 6. Demo data removal (admins; the tables themselves refuse browser deletes) ─
create or replace function public.books_remove_demo()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n integer := 0; k integer;
begin
  if not (select public.is_portal_admin()) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.books_transactions where is_demo; get diagnostics k = row_count; n := n + k;
  delete from public.books_open_items   where is_demo; get diagnostics k = row_count; n := n + k;
  delete from public.books_receipts     where is_demo; get diagnostics k = row_count; n := n + k;
  delete from public.books_chases where open_item_xero_id like 'demo-%'; get diagnostics k = row_count; n := n + k;
  insert into public.activity_events (actor_id, actor_name, verb, object_type, object_id, after)
  values (null, coalesce((select auth.jwt() ->> 'email'), 'admin'), 'books demo removed', 'books', null, jsonb_build_object('rows', n));
  return n;
end $$;
revoke all on function public.books_remove_demo() from public, anon;
grant execute on function public.books_remove_demo() to authenticated, service_role;

-- Count of demo rows (cheap banner check).
create or replace function public.books_demo_count()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select (select count(*) from public.books_transactions where is_demo)::int
       + (select count(*) from public.books_open_items where is_demo)::int
       + (select count(*) from public.books_receipts where is_demo)::int
$$;
grant execute on function public.books_demo_count() to authenticated, service_role;

-- ── 7. Cron: compliance reminders daily at 20:05 UTC (06:05/07:05 Sydney) ────
do $$ begin perform cron.unschedule('books-compliance-daily'); exception when others then null; end $$;
select cron.schedule('books-compliance-daily', '5 20 * * *',
  $$select net.http_post(
      url:='https://tsizneslellcqusjwtub.supabase.co/functions/v1/books-compliance',
      headers:=jsonb_build_object('Content-Type','application/json','x-digest-secret',(select decrypted_secret from vault.decrypted_secrets where name='digest_secret' limit 1)),
      body:='{}'::jsonb)$$);
