-- 2026-10-20 — Saved roster templates (agent `roster`). Additive + idempotent.
-- "Save this crew as a template": a named crew + job (client/site ids with name
-- snapshots, role, weekdays, arrival time, supervisor) that the office can
-- re-roster for next week in one tap. Office read/write; workers see nothing.
-- Archive, never delete: no DELETE grant, no DELETE policy.

create table if not exists public.roster_templates (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (length(btrim(name)) > 0),
  client_id            uuid references public.clients(id) on delete set null,
  client_name_snapshot text,
  site_id              uuid references public.client_sites(id) on delete set null,
  site_name_snapshot   text,
  project              text,
  role                 text,
  worker_ids           uuid[] not null default '{}',
  positions            int check (positions is null or positions >= 1),
  weekdays             int[] not null default '{}'
                         check (weekdays <@ array[0,1,2,3,4,5,6]),   -- 0 = Mon … 6 = Sun
  arrival_time         text check (arrival_time is null or arrival_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  duration_days        int not null default 1 check (duration_days >= 1 and duration_days <= 31),
  notes                text,
  site_manager         text,
  manager_phone        text,
  map_url              text,
  created_by           uuid default public.current_worker_id(),
  created_by_name      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  archived_at          timestamptz
);
create index if not exists roster_templates_live_idx
  on public.roster_templates (lower(name)) where archived_at is null;

create or replace function public.roster_templates_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists roster_templates_touch on public.roster_templates;
create trigger roster_templates_touch before update on public.roster_templates
  for each row execute function public.roster_templates_touch();

alter table public.roster_templates enable row level security;

drop policy if exists "roster_templates office read" on public.roster_templates;
create policy "roster_templates office read" on public.roster_templates
  for select to authenticated using (public.is_office_user());
drop policy if exists "roster_templates office insert" on public.roster_templates;
create policy "roster_templates office insert" on public.roster_templates
  for insert to authenticated with check (public.is_office_user());
drop policy if exists "roster_templates office update" on public.roster_templates;
create policy "roster_templates office update" on public.roster_templates
  for update to authenticated using (public.is_office_user()) with check (public.is_office_user());

revoke all on public.roster_templates from anon;
revoke delete, truncate on public.roster_templates from authenticated;
grant select, insert, update on public.roster_templates to authenticated;

-- MFA: restrictive policy, same as every other RLS table.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'roster_templates'
      and policyname = 'require_mfa_when_enrolled'
  ) then
    create policy require_mfa_when_enrolled on public.roster_templates
      as restrictive for all to authenticated
      using (public.mfa_satisfied()) with check (public.mfa_satisfied());
  end if;
end $$;
