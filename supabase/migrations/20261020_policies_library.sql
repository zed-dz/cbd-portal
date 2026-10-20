-- 20261020_policies_library.sql
-- Policies library (owner request 2026-10-20): the office uploads SWMS, Take 5
-- forms, incident report forms, annexures and other company files; workers can
-- open them any time from the phone app. Read-only for workers. Nothing to sign
-- here (signing stays in Documents / company_documents).
--
-- Additive only. RLS on every table. Office = public.is_office_user().
-- Worker = public.current_worker_id() is not null. Archive, never delete.
-- No money anywhere in here.

-- ───────────────────────────── categories (master) ─────────────────────────
create table if not exists public.policy_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  sort_order  int  not null default 100,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists policy_categories_name_uq on public.policy_categories (lower(btrim(name)));

alter table public.policy_categories enable row level security;
drop policy if exists "policy_categories office all" on public.policy_categories;
create policy "policy_categories office all" on public.policy_categories
  for all to authenticated
  using ((select public.is_office_user())) with check ((select public.is_office_user()));
drop policy if exists "policy_categories worker select" on public.policy_categories;
create policy "policy_categories worker select" on public.policy_categories
  for select to authenticated
  using (archived_at is null and (select public.current_worker_id()) is not null);
grant select, insert, update on public.policy_categories to authenticated;

insert into public.policy_categories (name, sort_order) values
  ('SWMS', 10), ('Take 5', 20), ('Incident Reports', 30), ('Annexures', 40),
  ('Policies & Procedures', 50), ('Other', 90)
on conflict do nothing;

-- ───────────────────────────── the files ───────────────────────────────────
create table if not exists public.policy_documents (
  id                     uuid primary key default gen_random_uuid(),
  category_id            uuid not null references public.policy_categories(id),
  category_name_snapshot text not null,
  title                  text not null check (char_length(btrim(title)) between 1 and 160),
  description            text check (description is null or char_length(description) <= 400),
  file_path              text not null unique,
  file_name              text not null,
  mime_type              text,
  size_bytes             bigint,
  visible_to_workers     boolean not null default true,
  uploaded_by_id         uuid references public.workers(id) on delete set null,
  uploaded_by_name       text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  archived_at            timestamptz
);
create index if not exists policy_documents_category_idx on public.policy_documents (category_id);
create index if not exists policy_documents_live_idx on public.policy_documents (created_at desc) where archived_at is null;
create index if not exists policy_documents_uploader_idx on public.policy_documents (uploaded_by_id);

alter table public.policy_documents enable row level security;
drop policy if exists "policy_documents office all" on public.policy_documents;
create policy "policy_documents office all" on public.policy_documents
  for all to authenticated
  using ((select public.is_office_user())) with check ((select public.is_office_user()));
drop policy if exists "policy_documents worker select" on public.policy_documents;
create policy "policy_documents worker select" on public.policy_documents
  for select to authenticated
  using (archived_at is null and visible_to_workers and (select public.current_worker_id()) is not null);
-- No delete grant: archive, never delete.
grant select, insert, update on public.policy_documents to authenticated;

create or replace function public.policy_documents_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists policy_documents_touch on public.policy_documents;
create trigger policy_documents_touch before update on public.policy_documents
  for each row execute function public.policy_documents_touch();

-- ───────────────────────────── storage bucket ──────────────────────────────
-- Private. 25 MB a file. Office uploads; a worker can only read a file whose
-- library row is live and shown to workers.
insert into storage.buckets (id, name, public, file_size_limit)
values ('policy-files', 'policy-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "policy files office insert" on storage.objects;
create policy "policy files office insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'policy-files' and (select public.is_office_user()));

drop policy if exists "policy files read" on storage.objects;
create policy "policy files read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'policy-files' and (
      (select public.is_office_user())
      or exists (
        select 1 from public.policy_documents p
        where p.file_path = storage.objects.name
          and p.archived_at is null and p.visible_to_workers
          and (select public.current_worker_id()) is not null
      )
    )
  );
