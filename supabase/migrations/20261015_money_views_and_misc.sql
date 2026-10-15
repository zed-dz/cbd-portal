-- 2026-10-15 (part 1 of the money-column fix + small audit leftovers). Safe to
-- run BEFORE the client deploy: only adds views, a column, a table, indexes.
-- Part 2 (20261015_money_columns_lockdown.sql) revokes the money columns and is
-- run once the client that reads the views is live.

-- Admin-only full view of clients (money columns included), like v_workers_admin.
create or replace view public.v_clients_admin as
  select * from public.clients where public.is_portal_admin();
revoke all on public.v_clients_admin from anon, authenticated;
grant select on public.v_clients_admin to authenticated;

-- payroll_config without the client charge-rate defaults for non-admins.
create or replace view public.v_payroll_config as
  select * from public.payroll_config
  where public.is_portal_admin() or config_key not like 'default_client_rate%';
revoke all on public.v_payroll_config from anon, authenticated;
grant select on public.v_payroll_config to authenticated;

-- Roles are master data: archive, never delete.
alter table public.job_roles add column if not exists archived_at timestamptz;

-- "Not available" list for the Allocation Board (from Zeff's sheet).
create table if not exists public.worker_unavailability (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references public.workers(id),
  from_date   date not null,
  to_date     date not null,
  reason      text,
  created_by  text,
  created_at  timestamptz not null default now(),
  constraint worker_unavailability_dates check (to_date >= from_date)
);
alter table public.worker_unavailability enable row level security;
drop policy if exists "worker_unavailability office all" on public.worker_unavailability;
create policy "worker_unavailability office all" on public.worker_unavailability
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "worker_unavailability worker read own" on public.worker_unavailability;
create policy "worker_unavailability worker read own" on public.worker_unavailability
  for select to authenticated using (worker_id = public.current_worker_id());
grant select, insert, update, delete on public.worker_unavailability to authenticated;
create index if not exists worker_unavailability_worker_from_idx on public.worker_unavailability(worker_id, from_date);

-- Leftover definer helpers that anon could still call (trigger helpers only).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('payroll_config_num', 'casual_travel_allowance')
  loop
    execute format('revoke execute on function %s from anon, public', r.sig);
  end loop;
end $$;

-- Remaining FK indexes from the audit.
create index if not exists client_invoices_created_by_idx on public.client_invoices(created_by);
create index if not exists payment_runs_created_by_idx on public.payment_runs(created_by);
create index if not exists worker_applications_converted_worker_id_idx on public.worker_applications(converted_worker_id);

-- Public photo bucket: cap size and types (anonymous onboarding uploads).
update storage.buckets
   set file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif']
 where id = 'worker-photos';
