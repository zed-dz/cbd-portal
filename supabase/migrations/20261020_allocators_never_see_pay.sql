-- Allocators never see pay (owner rule, 2026-10-20).
-- Anyone ticked "allocator" (workers.is_allocator) is shut out of every money
-- door, whatever their access level: pay rates, client rates, rate sets,
-- payroll config, invoices, Xero, and workers' bank / tax / super details.
-- is_portal_admin() is the single money gate the RLS policies, money views
-- and RPCs use, so changing it moves the whole line at once.

create or replace function public.is_portal_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.workers w
    where lower(w.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
      and w.access_level = 'admin'
      and not coalesce(w.is_allocator, false)
      and w.archived_at is null
  )
$function$;

-- Bank, TFN and super details were readable by admin AND manager level.
-- They are pay data: money users only from now on.
drop policy if exists payroll_admin_all on public.worker_payroll_details;
create policy payroll_admin_all on public.worker_payroll_details
  for all to authenticated
  using (public.is_portal_admin())
  with check (public.is_portal_admin());

-- Three things sat behind the money gate but hold no dollars at all. Allocators
-- need them, so every office user may use them:
--   * the required-tickets list (role → ticket names),
--   * the Sent Timesheets log, and the client timesheet PDFs (hours only).
drop policy if exists "role_required_tickets admin write" on public.role_required_tickets;
drop policy if exists "role_required_tickets office write" on public.role_required_tickets;
create policy "role_required_tickets office write" on public.role_required_tickets
  for all to authenticated
  using (public.is_office_user())
  with check (public.is_office_user());

drop policy if exists timesheet_sends_admin on public.timesheet_sends;
drop policy if exists timesheet_sends_office on public.timesheet_sends;
create policy timesheet_sends_office on public.timesheet_sends
  for select to authenticated
  using (public.is_office_user());

drop policy if exists "staff read timesheet pdfs" on storage.objects;
create policy "staff read timesheet pdfs" on storage.objects
  for select to authenticated
  using (bucket_id = 'timesheet-pdfs' and public.is_office_user());
