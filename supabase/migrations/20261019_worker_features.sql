-- 20261019_worker_features.sql
-- Worker-side features (sprint 2026-10-19, branch feat/worker):
--   1. clock_events            — server-side clock in / out with time + GPS
--   2. leave_requests          — time-off requests from the phone
--   3. incident_reports        — incident / near-miss / hazard reports (+ photos bucket)
--   4. site_inductions (+ signatures) — per-site induction / SWMS sign-on
--   5. company_documents (+ signatures) — e-sign of contracts / policies (+ PDF bucket)
--
-- Additive only. RLS on every table. Office = public.is_office_user()
-- (workers.role = 'admin'); a worker sees / writes only rows where
-- worker_id = public.current_worker_id(). No money anywhere in here.

-- ───────────────────────────── 1. clock_events ─────────────────────────────
create table if not exists public.clock_events (
  id            uuid primary key default gen_random_uuid(),
  worker_id     uuid not null references public.workers(id) on delete cascade,
  kind          text not null check (kind in ('in','out')),
  at            timestamptz not null default now(),
  lat           double precision,
  lng           double precision,
  accuracy_m    double precision,
  address       text,
  allocation_id uuid references public.allocations(id) on delete set null,
  header_id     uuid references public.timesheet_headers(id) on delete set null,
  device        text,
  created_at    timestamptz not null default now()
);
create index if not exists clock_events_worker_at_idx on public.clock_events (worker_id, at desc);
create index if not exists clock_events_header_idx    on public.clock_events (header_id);

alter table public.clock_events enable row level security;
drop policy if exists "clock_events office all" on public.clock_events;
create policy "clock_events office all" on public.clock_events
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "clock_events worker select own" on public.clock_events;
create policy "clock_events worker select own" on public.clock_events
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "clock_events worker insert own" on public.clock_events;
create policy "clock_events worker insert own" on public.clock_events
  for insert to authenticated with check (worker_id = public.current_worker_id());
-- The worker links the in/out pair to the daily sheet it created (header_id).
drop policy if exists "clock_events worker update own" on public.clock_events;
create policy "clock_events worker update own" on public.clock_events
  for update to authenticated
  using (worker_id = public.current_worker_id())
  with check (worker_id = public.current_worker_id());
grant select, insert, update on public.clock_events to authenticated;

-- ──────────────────────────── 2. leave_requests ────────────────────────────
create table if not exists public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references public.workers(id) on delete cascade,
  from_date   date not null,
  to_date     date not null,
  reason      text,
  status      text not null default 'pending' check (status in ('pending','approved','declined')),
  decided_by  text,
  decided_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  constraint leave_requests_dates check (to_date >= from_date),
  constraint leave_requests_reason_len check (reason is null or char_length(reason) <= 80)
);
create index if not exists leave_requests_worker_idx on public.leave_requests (worker_id, created_at desc);
create index if not exists leave_requests_status_idx on public.leave_requests (status);

alter table public.leave_requests enable row level security;
drop policy if exists "leave_requests office all" on public.leave_requests;
create policy "leave_requests office all" on public.leave_requests
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "leave_requests worker select own" on public.leave_requests;
create policy "leave_requests worker select own" on public.leave_requests
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "leave_requests worker insert own" on public.leave_requests;
create policy "leave_requests worker insert own" on public.leave_requests
  for insert to authenticated
  with check (worker_id = public.current_worker_id() and status = 'pending');
grant select, insert, update on public.leave_requests to authenticated;

-- ─────────────────────────── 3. incident_reports ───────────────────────────
create table if not exists public.incident_reports (
  id           uuid primary key default gen_random_uuid(),
  worker_id    uuid not null references public.workers(id) on delete cascade,
  site_id      uuid references public.client_sites(id) on delete set null,
  client       text,
  site         text,
  occurred_at  timestamptz not null default now(),
  type         text not null check (type in ('incident','near_miss','hazard')),
  description  text not null check (char_length(description) <= 600),
  injured      boolean not null default false,
  first_aid    boolean not null default false,
  photo_paths  text[] not null default '{}',
  status       text not null default 'open' check (status in ('open','reviewed','closed')),
  reviewed_by  text,
  reviewed_at  timestamptz,
  review_notes text,
  created_at   timestamptz not null default now()
);
create index if not exists incident_reports_worker_idx on public.incident_reports (worker_id, created_at desc);
create index if not exists incident_reports_status_idx on public.incident_reports (status, created_at desc);

alter table public.incident_reports enable row level security;
drop policy if exists "incident_reports office all" on public.incident_reports;
create policy "incident_reports office all" on public.incident_reports
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "incident_reports worker select own" on public.incident_reports;
create policy "incident_reports worker select own" on public.incident_reports
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "incident_reports worker insert own" on public.incident_reports;
create policy "incident_reports worker insert own" on public.incident_reports
  for insert to authenticated
  with check (worker_id = public.current_worker_id() and status = 'open');
grant select, insert, update on public.incident_reports to authenticated;

-- Photos: private bucket, {worker_id}/… folder rule like worker-certificates.
insert into storage.buckets (id, name, public)
values ('incident-photos', 'incident-photos', false)
on conflict (id) do nothing;

drop policy if exists incident_photos_select on storage.objects;
create policy incident_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'incident-photos'
         and ((storage.foldername(name))[1] = public.current_worker_id()::text or public.is_office_user()));
drop policy if exists incident_photos_insert on storage.objects;
create policy incident_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'incident-photos'
         and ((storage.foldername(name))[1] = public.current_worker_id()::text or public.is_office_user()));
drop policy if exists incident_photos_delete on storage.objects;
create policy incident_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'incident-photos' and public.is_office_user());

-- ─────────────────────── 4. site inductions + signatures ───────────────────
create table if not exists public.site_inductions (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.client_sites(id) on delete cascade,
  title       text not null,
  content     text not null default '',
  required    boolean not null default true,
  version     int not null default 1,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists site_inductions_site_idx on public.site_inductions (site_id) where archived_at is null;

alter table public.site_inductions enable row level security;
drop policy if exists "site_inductions office all" on public.site_inductions;
create policy "site_inductions office all" on public.site_inductions
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "site_inductions worker read" on public.site_inductions;
create policy "site_inductions worker read" on public.site_inductions
  for select to authenticated using (archived_at is null);
grant select, insert, update on public.site_inductions to authenticated;

create table if not exists public.site_induction_signatures (
  id            uuid primary key default gen_random_uuid(),
  induction_id  uuid not null references public.site_inductions(id) on delete cascade,
  worker_id     uuid not null references public.workers(id) on delete cascade,
  signed_name   text not null,
  signed_at     timestamptz not null default now(),
  version       int not null,
  unique (induction_id, worker_id, version)
);
create index if not exists site_induction_signatures_worker_idx on public.site_induction_signatures (worker_id);

alter table public.site_induction_signatures enable row level security;
drop policy if exists "site_induction_signatures office all" on public.site_induction_signatures;
create policy "site_induction_signatures office all" on public.site_induction_signatures
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "site_induction_signatures worker select own" on public.site_induction_signatures;
create policy "site_induction_signatures worker select own" on public.site_induction_signatures
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "site_induction_signatures worker insert own" on public.site_induction_signatures;
create policy "site_induction_signatures worker insert own" on public.site_induction_signatures
  for insert to authenticated with check (worker_id = public.current_worker_id());
grant select, insert on public.site_induction_signatures to authenticated;

-- ─────────────────────── 5. company documents + e-sign ─────────────────────
create table if not exists public.company_documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text,
  file_path    text,                         -- path inside the company-documents bucket (PDF)
  required_for text[] not null default '{}', -- worker types; empty = everyone
  version      int not null default 1,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);

alter table public.company_documents enable row level security;
drop policy if exists "company_documents office all" on public.company_documents;
create policy "company_documents office all" on public.company_documents
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "company_documents worker read" on public.company_documents;
create policy "company_documents worker read" on public.company_documents
  for select to authenticated using (archived_at is null);
grant select, insert, update on public.company_documents to authenticated;

create table if not exists public.document_signatures (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.company_documents(id) on delete cascade,
  worker_id    uuid not null references public.workers(id) on delete cascade,
  version      int not null,
  signed_name  text not null,
  signed_at    timestamptz not null default now(),
  ip           text,
  unique (document_id, worker_id, version)
);
create index if not exists document_signatures_worker_idx on public.document_signatures (worker_id);

alter table public.document_signatures enable row level security;
drop policy if exists "document_signatures office all" on public.document_signatures;
create policy "document_signatures office all" on public.document_signatures
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "document_signatures worker select own" on public.document_signatures;
create policy "document_signatures worker select own" on public.document_signatures
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "document_signatures worker insert own" on public.document_signatures;
create policy "document_signatures worker insert own" on public.document_signatures
  for insert to authenticated with check (worker_id = public.current_worker_id());
grant select, insert on public.document_signatures to authenticated;

-- PDFs: private bucket; every signed-in worker may read (signed URL), office writes.
insert into storage.buckets (id, name, public)
values ('company-documents', 'company-documents', false)
on conflict (id) do nothing;

drop policy if exists company_documents_obj_select on storage.objects;
create policy company_documents_obj_select on storage.objects
  for select to authenticated using (bucket_id = 'company-documents');
drop policy if exists company_documents_obj_insert on storage.objects;
create policy company_documents_obj_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'company-documents' and public.is_office_user());
drop policy if exists company_documents_obj_update on storage.objects;
create policy company_documents_obj_update on storage.objects
  for update to authenticated using (bucket_id = 'company-documents' and public.is_office_user());
drop policy if exists company_documents_obj_delete on storage.objects;
create policy company_documents_obj_delete on storage.objects
  for delete to authenticated using (bucket_id = 'company-documents' and public.is_office_user());

-- updated_at touch for the two editable "master text" tables
create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists site_inductions_touch on public.site_inductions;
create trigger site_inductions_touch before update on public.site_inductions
  for each row execute function public.tg_touch_updated_at();
drop trigger if exists company_documents_touch on public.company_documents;
create trigger company_documents_touch before update on public.company_documents
  for each row execute function public.tg_touch_updated_at();
