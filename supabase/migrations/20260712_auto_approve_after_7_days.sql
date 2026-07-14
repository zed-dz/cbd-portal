-- 7-day auto-approval (owner request 2026-07-12): if the site supervisor
-- neither accepts nor the office rejects within 7 days of the sign-off link
-- being sent (or of submission, when no link could be sent), the timesheet is
-- approved automatically and becomes billable. Runs hourly via pg_cron; every
-- auto-approval drops an admin bell notification.

create or replace function public.auto_approve_stale_timesheets()
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select h.id, h.client, w.name as worker_name
    from public.timesheet_headers h
    left join public.workers w on w.id = h.worker_id
    where h.client_approved = false
      and h.status <> 'rejected'
      and coalesce(h.client_approval_sent_at, h.created_at) <= now() - interval '7 days'
  loop
    update public.timesheet_headers
    set client_approved = true,
        client_approved_at = now(),
        client_approved_by = 'Auto-approved — no supervisor response within 7 days',
        status = 'approved',
        updated_at = now()
    where id = r.id;

    update public.timesheets
    set client_approved = true, status = 'approved'
    where header_id = r.id;

    insert into public.notifications (type, title, body)
    values ('timesheet_auto_approved',
            'Auto-approved after 7 days: ' || coalesce(r.worker_name, 'worker') || ' — ' || coalesce(r.client, 'client'),
            'No supervisor response within 7 days — approved automatically and now billable in Payroll.');

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

do $$ begin
  perform cron.unschedule('auto-approve-stale-timesheets');
exception when others then null; end $$;

select cron.schedule('auto-approve-stale-timesheets', '15 * * * *',
  'select public.auto_approve_stale_timesheets()');
