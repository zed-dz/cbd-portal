-- Per-role pay rates for subcontractors (owner, 2026-10-14).
-- A subcontractor is paid a different rate depending on the role they do on
-- the day, and their overtime is not 1.5x / 2x. Payroll picks the row whose
-- role matches the timesheet's role; no match falls back to the person's own
-- A/B; still blank is flagged "rate missing", never guessed.
--
-- Additive only. Money table: admins only, enforced by RLS. Rows are archived,
-- never deleted (no DELETE grant), so an old pay run can always be explained.

create table if not exists public.worker_role_rates (
  id            uuid primary key default gen_random_uuid(),
  worker_id     uuid not null references public.workers(id) on delete cascade,
  role_name     text not null check (length(btrim(role_name)) > 0),
  rate_normal   numeric(10,2) check (rate_normal   is null or rate_normal   >= 0),
  rate_overtime numeric(10,2) check (rate_overtime is null or rate_overtime >= 0),
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One live rate per role per person; an archived row can be re-added.
create unique index if not exists worker_role_rates_live_uq
  on public.worker_role_rates (worker_id, lower(btrim(role_name)))
  where archived_at is null;
create index if not exists worker_role_rates_worker_idx on public.worker_role_rates (worker_id);

alter table public.worker_role_rates enable row level security;
revoke all on public.worker_role_rates from anon, authenticated;
grant select, insert, update on public.worker_role_rates to authenticated;

drop policy if exists "worker_role_rates admin only" on public.worker_role_rates;
create policy "worker_role_rates admin only" on public.worker_role_rates
  for all to authenticated
  using (public.is_portal_admin())
  with check (public.is_portal_admin());
