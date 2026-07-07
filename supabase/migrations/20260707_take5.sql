-- Take 5 pre-start safety checks.
-- A worker must submit a Take 5 on Tuesdays/Thursdays (AEST) before their
-- timesheet for that date can be submitted (gate lives in DailyTimesheetForm,
-- backed by this table). Mirrors the MRA portal (parity).
create table if not exists public.take5 (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null,
  work_date date not null default current_date,
  client text,
  site text,
  hazards text,
  controls text,
  ppe jsonb default '[]'::jsonb,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists take5_worker_date_idx on public.take5 (worker_id, work_date);

alter table public.take5 enable row level security;

-- Matches the portal's existing RLS pattern (allocations/timesheets):
-- any authenticated user, with per-worker filtering done client-side.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'take5' and policyname = 'Auth users full access'
  ) then
    create policy "Auth users full access" on public.take5 for all
      using ((select auth.uid()) is not null)
      with check ((select auth.uid()) is not null);
  end if;
end $$;

grant all on public.take5 to anon, authenticated, service_role;
