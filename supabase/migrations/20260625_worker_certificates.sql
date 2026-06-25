-- 20260625_worker_certificates.sql
-- Feature 2: worker-uploaded certificates / tickets.
--
-- A worker adds each ticket/licence: a name/keyword (e.g. "Excavator Operator"),
-- uploads the certificate-of-currency file (-> Storage bucket worker-certificates),
-- and records issue and/or expiry date. A worker manages ONLY their own rows;
-- staff (admin/manager) can read everyone's.

-- Helper: map the caller (auth JWT email) to their workers.id. SECURITY DEFINER
-- so RLS policies can resolve the worker without recursion.
create or replace function public.current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select w.id
  from public.workers w
  where lower(w.email) = lower((select auth.jwt() ->> 'email'))
    and w.archived_at is null
  limit 1;
$$;

revoke all on function public.current_worker_id() from public, anon;
grant execute on function public.current_worker_id() to authenticated, service_role;

create table if not exists public.worker_certificates (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references public.workers(id) on delete cascade,
  name        text not null,                 -- keyword/role, e.g. "Excavator Operator"
  file_path   text,                          -- path inside the worker-certificates bucket
  issued_date date,
  expiry_date date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists worker_certificates_worker_id_idx
  on public.worker_certificates (worker_id);

alter table public.worker_certificates enable row level security;

-- SELECT: own rows OR staff.
drop policy if exists worker_certificates_select on public.worker_certificates;
create policy worker_certificates_select on public.worker_certificates
  for select to authenticated
  using ( worker_id = public.current_worker_id() or public.is_cbd_staff() );

-- INSERT: only for your own worker_id (staff may also insert on a worker's behalf).
drop policy if exists worker_certificates_insert on public.worker_certificates;
create policy worker_certificates_insert on public.worker_certificates
  for insert to authenticated
  with check ( worker_id = public.current_worker_id() or public.is_cbd_staff() );

-- UPDATE: own rows (or staff).
drop policy if exists worker_certificates_update on public.worker_certificates;
create policy worker_certificates_update on public.worker_certificates
  for update to authenticated
  using ( worker_id = public.current_worker_id() or public.is_cbd_staff() )
  with check ( worker_id = public.current_worker_id() or public.is_cbd_staff() );

-- DELETE: own rows (or staff).
drop policy if exists worker_certificates_delete on public.worker_certificates;
create policy worker_certificates_delete on public.worker_certificates
  for delete to authenticated
  using ( worker_id = public.current_worker_id() or public.is_cbd_staff() );

-- keep updated_at fresh
create or replace function public.tg_worker_certificates_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists worker_certificates_touch on public.worker_certificates;
create trigger worker_certificates_touch
  before update on public.worker_certificates
  for each row execute function public.tg_worker_certificates_touch();

-- ---------------------------------------------------------------------------
-- Storage bucket + object policies for the certificate files.
-- The bucket is PRIVATE; a worker can only read/write objects under their own
-- {worker_id}/ prefix; staff can read all. (Run with sufficient privileges; if
-- storage.buckets insert is restricted, create the bucket in the dashboard with
-- the same id/public=false and keep the policies below.)
insert into storage.buckets (id, name, public)
values ('worker-certificates', 'worker-certificates', false)
on conflict (id) do nothing;

-- helper: first path segment ({worker_id}) of a storage object name
-- storage.foldername(name)[1] gives the first folder.

drop policy if exists worker_certs_obj_select on storage.objects;
create policy worker_certs_obj_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'worker-certificates'
    and (
      (storage.foldername(name))[1] = public.current_worker_id()::text
      or public.is_cbd_staff()
    )
  );

drop policy if exists worker_certs_obj_insert on storage.objects;
create policy worker_certs_obj_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'worker-certificates'
    and (
      (storage.foldername(name))[1] = public.current_worker_id()::text
      or public.is_cbd_staff()
    )
  );

drop policy if exists worker_certs_obj_update on storage.objects;
create policy worker_certs_obj_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'worker-certificates'
    and (
      (storage.foldername(name))[1] = public.current_worker_id()::text
      or public.is_cbd_staff()
    )
  );

drop policy if exists worker_certs_obj_delete on storage.objects;
create policy worker_certs_obj_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'worker-certificates'
    and (
      (storage.foldername(name))[1] = public.current_worker_id()::text
      or public.is_cbd_staff()
    )
  );
