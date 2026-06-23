-- Close a confirmed privilege-escalation + PII-leak hole on public.workers.
--
-- BEFORE: a single policy `"Auth users full access" FOR ALL USING (auth.uid() IS NOT NULL)`
-- let ANY authenticated worker read every worker row (PII: name/email/address/DOB/
-- licence) and UPDATE their own row to set role/access_level = 'admin' — self-promotion
-- to admin, which then unlocked worker_payroll_details / worker_medical_details (those
-- policies key on workers.access_level). Verified exploitable end-to-end, then fixed.
--
-- AFTER:
--   SELECT  — your own row (by email) OR you are admin/manager.  (login bootstrap +
--             admin worker lists keep working; non-admins can no longer read others.)
--   INSERT/UPDATE/DELETE — admin/manager only.  (admin WorkersPage / XeroSync keep
--             working; non-admin self-edits already go through the SECURITY DEFINER
--             RPCs update_my_worker_profile / update_worker_via_token, which bypass
--             RLS and never touch role/access_level, so they are unaffected.)
--
-- A SECURITY DEFINER helper is used for the staff check so the policy on `workers`
-- can consult `workers` without RLS recursion.

create or replace function public.is_cbd_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workers w
    where lower(w.email) = lower((select auth.jwt() ->> 'email'))
      and w.access_level = any (array['admin','manager'])
      and w.archived_at is null
  );
$$;

revoke all on function public.is_cbd_staff() from public, anon;
grant execute on function public.is_cbd_staff() to authenticated, service_role;

drop policy if exists "Auth users full access" on public.workers;

create policy "workers_select_self_or_staff" on public.workers
  for select to authenticated
  using (
    lower(email) = lower((select auth.jwt() ->> 'email'))
    or public.is_cbd_staff()
  );

create policy "workers_insert_staff" on public.workers
  for insert to authenticated
  with check ( public.is_cbd_staff() );

create policy "workers_update_staff" on public.workers
  for update to authenticated
  using ( public.is_cbd_staff() )
  with check ( public.is_cbd_staff() );

create policy "workers_delete_staff" on public.workers
  for delete to authenticated
  using ( public.is_cbd_staff() );
