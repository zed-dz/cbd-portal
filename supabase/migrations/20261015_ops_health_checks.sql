-- 2026-10-15 — table written by the ops-health-check edge function (daily cron).
-- (Created on CBD by the function's author; recorded here so the mirrors get it.)
create table if not exists public.ops_health_checks (
  id           bigserial primary key,
  run_at       timestamptz not null default now(),
  issue_count  integer not null default 0,
  summary      jsonb not null
);
alter table public.ops_health_checks enable row level security;
drop policy if exists "ops_health_checks office read" on public.ops_health_checks;
create policy "ops_health_checks office read" on public.ops_health_checks
  for select to authenticated using (public.is_office_user());
grant select on public.ops_health_checks to authenticated;
