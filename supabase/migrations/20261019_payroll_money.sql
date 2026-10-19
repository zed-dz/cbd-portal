-- 2026-10-19 money-side sprint (agent: payroll). Additive only.
--   1. workers.xero_employee_id   — link a worker to a Xero Payroll employee by ID
--   2. clients.xero_contact_id    — link a client to a Xero accounting contact
--   3. timesheet_headers.invoiced_at / invoice_id — stamped by xero-invoice
--   4. client_invoices: Xero columns beside the Stripe ones
--   5. plant_items / plant_hours  — plant & equipment register + hours per sheet
-- Money columns (xero ids are not money, but the plant hourly charge IS) stay
-- admin-only: NO column grant to authenticated, read through a definer view.

-- ── 1. Workers ↔ Xero employee ───────────────────────────────────────────────
alter table public.workers add column if not exists xero_employee_id text;
create unique index if not exists workers_xero_employee_id_uidx
  on public.workers (xero_employee_id) where xero_employee_id is not null;
-- Column-level SELECT grants are in force on workers (2026-09-28): the new
-- column is NOT granted to authenticated, so only the admin view exposes it.
-- Keep it OUT of WORKER_SAFE_COLS in src/utils/workerCols.js.
-- Recreate the admin view so it carries the new column (a view's column list
-- is frozen at creation time; `select *` here is re-expanded on create).
drop view if exists public.v_workers_admin;
create view public.v_workers_admin as
  select * from public.workers where public.is_portal_admin();
revoke all on public.v_workers_admin from anon, authenticated;
grant select on public.v_workers_admin to authenticated;

-- ── 2. Clients ↔ Xero contact ────────────────────────────────────────────────
alter table public.clients add column if not exists xero_contact_id text;
drop view if exists public.v_clients_admin;
create view public.v_clients_admin as
  select * from public.clients where public.is_portal_admin();
revoke all on public.v_clients_admin from anon, authenticated;
grant select on public.v_clients_admin to authenticated;

-- ── 3. Headers: invoiced stamp ───────────────────────────────────────────────
alter table public.timesheet_headers add column if not exists invoiced_at timestamptz;
alter table public.timesheet_headers add column if not exists invoice_id uuid;
create index if not exists timesheet_headers_invoiced_idx on public.timesheet_headers (client_id, invoiced_at);

-- The approve-lock compares old/new minus a fixed set of "workflow" columns.
-- invoiced_at / invoice_id are workflow stamps too (set by xero-invoice on an
-- approved, locked sheet) so they join that set. Everything else unchanged.
create or replace function public.block_locked_edits()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_locked boolean;
begin
  if tg_table_name = 'timesheet_headers' then
    if tg_op = 'DELETE' then
      if coalesce(old.locked, false) then
        raise exception 'Timesheet is approved and locked. Use Reset workflow first.';
      end if;
      return old;
    end if;
    if coalesce(old.locked, false) and not coalesce(new.locked, false)
       and auth.uid() is not null and not public.is_portal_admin() then
      raise exception 'Only an admin can unlock an approved timesheet (Reset workflow).';
    end if;
    if coalesce(old.locked, false) and coalesce(new.locked, false)
       and (to_jsonb(new) - 'locked' - 'status' - 'version' - 'pdf_emailed_at' - 'pdf_emailed_to' - 'updated_at'
                          - 'client_approved' - 'client_approved_at' - 'client_approved_by'
                          - 'client_approval_sent_at' - 'client_approval_sent_to'
                          - 'approved_by' - 'approved_at' - 'disputed_at' - 'disputed_note'
                          - 'invoiced_at' - 'invoice_id')
        <> (to_jsonb(old) - 'locked' - 'status' - 'version' - 'pdf_emailed_at' - 'pdf_emailed_to' - 'updated_at'
                          - 'client_approved' - 'client_approved_at' - 'client_approved_by'
                          - 'client_approval_sent_at' - 'client_approval_sent_to'
                          - 'approved_by' - 'approved_at' - 'disputed_at' - 'disputed_note'
                          - 'invoiced_at' - 'invoice_id') then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    select h.locked into v_locked from public.timesheet_headers h where h.id = new.header_id;
    if coalesce(v_locked, false) then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    select h.locked into v_locked from public.timesheet_headers h where h.id = old.header_id;
    if coalesce(v_locked, false) then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return old;
  else
    select h.locked into v_locked from public.timesheet_headers h where h.id = old.header_id;
    if coalesce(v_locked, false)
       and (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'client_approved' - 'xero_exported'
                          - 'processed_at' - 'processed_by')
        <> (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'client_approved' - 'xero_exported'
                          - 'processed_at' - 'processed_by') then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  end if;
end $function$;

-- ── 4. client_invoices: Xero side ────────────────────────────────────────────
alter table public.client_invoices add column if not exists client_id uuid references public.clients(id);
alter table public.client_invoices add column if not exists source text not null default 'stripe';
alter table public.client_invoices add column if not exists xero_invoice_id text;
alter table public.client_invoices add column if not exists xero_invoice_number text;
alter table public.client_invoices add column if not exists xero_status text;
alter table public.client_invoices add column if not exists xero_url text;
alter table public.client_invoices add column if not exists header_ids uuid[];
alter table public.client_invoices add column if not exists total_hours numeric;
create index if not exists client_invoices_client_id_idx on public.client_invoices (client_id);
-- Invoice rows carry dollars: admin only (was is_cbd_staff = any office login).
drop policy if exists client_invoices_staff on public.client_invoices;
drop policy if exists client_invoices_admin on public.client_invoices;
create policy client_invoices_admin on public.client_invoices
  for all to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());

-- ── 5. Plant / equipment register ────────────────────────────────────────────
create table if not exists public.plant_items (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  type           text,
  rego_or_serial text,
  hourly_charge  numeric,                      -- MONEY: admin only (view below)
  status         text not null default 'active'
                 check (status in ('active', 'off_hire', 'maintenance')),
  notes          text,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.plant_items enable row level security;
-- Everyone signed in may read the register (the daily form lists plant to
-- pick from) — but NOT the charge column: column-level grant below.
drop policy if exists "plant_items read" on public.plant_items;
create policy "plant_items read" on public.plant_items
  for select to authenticated using (true);
drop policy if exists "plant_items admin write" on public.plant_items;
create policy "plant_items admin write" on public.plant_items
  for all to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());
revoke all on public.plant_items from anon, authenticated;
grant select (id, name, type, rego_or_serial, status, notes, archived_at, created_at, updated_at)
  on public.plant_items to authenticated;
grant insert, update on public.plant_items to authenticated;   -- RLS limits to admins
create index if not exists plant_items_status_idx on public.plant_items (status) where archived_at is null;

-- Admin-only full view (hourly_charge included), same pattern as v_clients_admin.
drop view if exists public.v_plant_items_admin;
create view public.v_plant_items_admin as
  select * from public.plant_items where public.is_portal_admin();
revoke all on public.v_plant_items_admin from anon, authenticated;
grant select on public.v_plant_items_admin to authenticated;

create table if not exists public.plant_hours (
  id         uuid primary key default gen_random_uuid(),
  header_id  uuid not null references public.timesheet_headers(id) on delete cascade,
  plant_id   uuid not null references public.plant_items(id),
  hours      numeric not null check (hours >= 0),
  notes      text,
  created_at timestamptz not null default now()
);
alter table public.plant_hours enable row level security;
drop policy if exists "plant_hours office all" on public.plant_hours;
create policy "plant_hours office all" on public.plant_hours
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
-- A worker manages the plant lines on their OWN sheets only.
drop policy if exists "plant_hours worker own" on public.plant_hours;
create policy "plant_hours worker own" on public.plant_hours
  for all to authenticated
  using (exists (select 1 from public.timesheet_headers h
                  where h.id = plant_hours.header_id and h.worker_id = public.current_worker_id()))
  with check (exists (select 1 from public.timesheet_headers h
                       where h.id = plant_hours.header_id and h.worker_id = public.current_worker_id()));
revoke all on public.plant_hours from anon, authenticated;
grant select, insert, update, delete on public.plant_hours to authenticated;
create index if not exists plant_hours_header_idx on public.plant_hours (header_id);
create index if not exists plant_hours_plant_idx on public.plant_hours (plant_id);

-- Plant lines follow the sheet's lock (same trigger as the hour lines).
drop trigger if exists trg_block_locked_plant_hours on public.plant_hours;
create trigger trg_block_locked_plant_hours
  before insert or update or delete on public.plant_hours
  for each row execute function public.block_locked_edits();
