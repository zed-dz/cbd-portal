-- 20261022_video_guide.sql
-- Video guide (owner request 2026-10-22): the narrated office walkthrough lives inside
-- the portal. Files sit in a private bucket; any office user can watch, only money
-- admins can upload or replace. Additive only.
insert into storage.buckets (id, name, public, file_size_limit)
values ('video-guide', 'video-guide', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "video guide office read" on storage.objects;
create policy "video guide office read" on storage.objects
  for select to authenticated
  using (bucket_id = 'video-guide' and (select public.is_office_user()));

drop policy if exists "video guide admin write" on storage.objects;
create policy "video guide admin write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'video-guide' and (select public.is_portal_admin()));

drop policy if exists "video guide admin update" on storage.objects;
create policy "video guide admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'video-guide' and (select public.is_portal_admin()))
  with check (bucket_id = 'video-guide' and (select public.is_portal_admin()));
