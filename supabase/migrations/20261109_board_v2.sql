-- Allocation Board v2 (Chris's allocation sheet, 2026-11-09).
-- Additive only. Mirrors ×3 (CBD, MRA, Hecate).
--
-- allocations.shift       day | night | 8hrs | rain_4 | rain_8 | rain_unpaid
-- allocations.left_early  the worker was sent home early that day
-- allocation_type gains   injured | public_holiday (next to work, rdo,
--                         personal_leave = "Sick", annual_leave = "A/L")
-- allocation_day_notes    the little orange dot: a note on a worker-day for
--                         payroll. Office-only (workers never see them).

alter table public.allocations add column if not exists shift text;
alter table public.allocations add column if not exists left_early boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'allocations_shift_check') then
    alter table public.allocations add constraint allocations_shift_check
      check (shift is null or shift in ('day','night','8hrs','rain_4','rain_8','rain_unpaid'));
  end if;
end $$;

create table if not exists public.allocation_day_notes (
  id            uuid primary key default gen_random_uuid(),
  worker_id     uuid not null references public.workers(id) on delete cascade,
  day           date not null,
  allocation_id uuid references public.allocations(id) on delete set null,
  note          text not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists allocation_day_notes_day_idx on public.allocation_day_notes (day);
create index if not exists allocation_day_notes_worker_idx on public.allocation_day_notes (worker_id, day);

alter table public.allocation_day_notes enable row level security;
drop policy if exists "day notes office all" on public.allocation_day_notes;
create policy "day notes office all" on public.allocation_day_notes
  for all to authenticated
  using (public.is_office_user())
  with check (public.is_office_user());
revoke all on public.allocation_day_notes from anon;
grant select, insert, update, delete on public.allocation_day_notes to authenticated;
