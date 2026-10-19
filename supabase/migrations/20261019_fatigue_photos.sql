-- 2026-10-19 — Fatigue flags on the daily timesheet + photos (dockets, plant
-- hours). Additive only. Requires is_office_user() and current_worker_id().

-- 1. Fatigue breaches computed by the form (>12h shift, <10h rest, >60h week).
--    jsonb array of {type, date, text}; null = no breach. The worker ticks
--    "I confirm these hours are correct" before Submit; the office decides.
alter table public.timesheet_headers add column if not exists fatigue_flags jsonb;

-- 2. Private bucket for timesheet photos. Path = <worker_id>/<header_id>/<uuid>.jpg
insert into storage.buckets (id, name, public)
values ('timesheet-photos', 'timesheet-photos', false)
on conflict (id) do nothing;

drop policy if exists "timesheet photos insert" on storage.objects;
create policy "timesheet photos insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'timesheet-photos'
    and ((storage.foldername(name))[1] = public.current_worker_id()::text or public.is_office_user()));

drop policy if exists "timesheet photos select" on storage.objects;
create policy "timesheet photos select" on storage.objects
  for select to authenticated
  using (bucket_id = 'timesheet-photos'
    and ((storage.foldername(name))[1] = public.current_worker_id()::text or public.is_office_user()));

drop policy if exists "timesheet photos delete" on storage.objects;
create policy "timesheet photos delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'timesheet-photos'
    and ((storage.foldername(name))[1] = public.current_worker_id()::text or public.is_office_user()));

-- 3. One row per photo. Cascades with the header; archive-never-delete does
--    not apply (a photo is an attachment, not master data).
create table if not exists public.timesheet_photos (
  id          uuid primary key default gen_random_uuid(),
  header_id   uuid not null references public.timesheet_headers(id) on delete cascade,
  worker_id   uuid not null references public.workers(id),
  path        text not null,
  caption     text,
  created_at  timestamptz not null default now()
);
create index if not exists timesheet_photos_header_idx on public.timesheet_photos(header_id);
create index if not exists timesheet_photos_worker_idx on public.timesheet_photos(worker_id);

alter table public.timesheet_photos enable row level security;

drop policy if exists "timesheet_photos office all" on public.timesheet_photos;
create policy "timesheet_photos office all" on public.timesheet_photos
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());

drop policy if exists "timesheet_photos worker select own" on public.timesheet_photos;
create policy "timesheet_photos worker select own" on public.timesheet_photos
  for select to authenticated using (worker_id = public.current_worker_id());

drop policy if exists "timesheet_photos worker insert own" on public.timesheet_photos;
create policy "timesheet_photos worker insert own" on public.timesheet_photos
  for insert to authenticated with check (worker_id = public.current_worker_id());

drop policy if exists "timesheet_photos worker delete own" on public.timesheet_photos;
create policy "timesheet_photos worker delete own" on public.timesheet_photos
  for delete to authenticated using (worker_id = public.current_worker_id());

revoke all on public.timesheet_photos from anon;
grant select, insert, delete on public.timesheet_photos to authenticated;

-- The UI never updates a photo row (remove + re-add instead); keep the
-- default UPDATE grant off the table.
revoke update on public.timesheet_photos from authenticated;
