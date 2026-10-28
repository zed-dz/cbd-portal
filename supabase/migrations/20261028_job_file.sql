-- 20261028_job_file.sql
-- Chris (2026-10-28): a "job file" per client site — who signs off hours and who
-- gets the approved PDFs — visible to the office when it creates an allocation,
-- never to workers. The data already lived on client_sites / client_site_contacts;
-- this locks the office-only columns away from the worker role and gives the
-- office a view that still returns everything. Additive: one view, two grants, one policy.

-- 1. Office-only view of sites (same pattern as v_clients_admin / v_workers_admin).
create or replace view public.v_client_sites_office as
  select * from public.client_sites where public.is_office_user();
revoke all on public.v_client_sites_office from anon, authenticated;
grant select on public.v_client_sites_office to authenticated;

-- 2. Workers keep only what the timesheet form and the induction banner need.
revoke select on public.client_sites from authenticated;
grant select (id, client_id, name, address, map_link, is_active, sort_order, created_at)
  on public.client_sites to authenticated;

-- 3. Site contacts (names, phones, emails) are office data. No worker screen reads them.
drop policy if exists "client_site_contacts read" on public.client_site_contacts;
create policy "client_site_contacts read" on public.client_site_contacts
  for select to authenticated using (public.is_office_user());
