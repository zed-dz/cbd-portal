-- Add worker from photos (2026-11-09).
-- 1. A PRIVATE staging bucket for the photos the office uploads (employment
--    form, licence, white card, tickets). Office users only, and each office
--    user sees only the folder named after their own auth uid. Workers have no
--    policy here at all, so they can neither upload nor read.
-- 2. certifications.cert_number — the ticket / licence number the vision
--    model reads off the card. Additive; nothing existing changes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('worker-intake', 'worker-intake', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "worker intake office insert own" on storage.objects;
create policy "worker intake office insert own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'worker-intake'
    and (select public.is_office_user())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "worker intake office read own" on storage.objects;
create policy "worker intake office read own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'worker-intake'
    and (select public.is_office_user())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "worker intake office delete own" on storage.objects;
create policy "worker intake office delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'worker-intake'
    and (select public.is_office_user())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Ticket / licence number read off the card. Text: cards mix letters and digits.
alter table public.certifications add column if not exists cert_number text;
grant select (cert_number), insert (cert_number), update (cert_number) on public.certifications to authenticated;
