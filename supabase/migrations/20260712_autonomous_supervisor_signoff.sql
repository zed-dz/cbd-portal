-- Autonomous sign-off (owner request 2026-07-12): the worker's submission goes
-- STRAIGHT to the site supervisor; the supervisor's acceptance both approves
-- the timesheet and makes it billable — no admin step required. Admins can
-- still adjust or reject at any time.

-- Supervisors can now open links for pending sheets too (anything not rejected).
create or replace function public.get_timesheet_for_client_approval(p_token uuid)
returns jsonb
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'header', jsonb_build_object(
      'client', h.client, 'project', h.project, 'role', h.role,
      'wet_hire', h.wet_hire, 'comments', h.comments,
      'client_signature', h.client_signature,
      'status', h.status, 'created_at', h.created_at,
      'client_approved', h.client_approved,
      'client_approved_at', h.client_approved_at,
      'client_approved_by', h.client_approved_by,
      'worker_name', w.name
    ),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'date', t.date, 'shift_type', t.shift_type,
        'start_time', t.start_time, 'end_time', t.end_time,
        'total_break_hours', t.total_break_hours, 'break_minutes', t.break_minutes,
        'total_hours', t.total_hours, 'regular_hours', t.regular_hours,
        'meal_allowance', t.meal_allowance,
        'original_start_time', t.original_start_time, 'original_end_time', t.original_end_time,
        'original_break_minutes', t.original_break_minutes,
        'adjusted_by', t.adjusted_by, 'adjusted_at', t.adjusted_at
      ) order by t.date)
      from public.timesheets t where t.header_id = h.id), '[]'::jsonb)
  )
  from public.timesheet_headers h
  left join public.workers w on w.id = h.worker_id
  where h.client_approval_token = p_token
    and h.status <> 'rejected';
$$;

-- Supervisor acceptance now ALSO approves the timesheet (pending -> approved),
-- so it flows straight into Payroll as billable with no admin action.
create or replace function public.approve_timesheet_via_token(p_token uuid, p_approver text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid; v_worker text; v_client text;
begin
  select h.id, w.name, h.client into v_id, v_worker, v_client
  from public.timesheet_headers h
  left join public.workers w on w.id = h.worker_id
  where h.client_approval_token = p_token and h.status <> 'rejected';

  if v_id is null then
    return false;
  end if;

  update public.timesheet_headers
  set client_approved = true,
      client_approved_at = coalesce(client_approved_at, now()),
      client_approved_by = coalesce(client_approved_by, nullif(trim(coalesce(p_approver,'')),'')),
      status = 'approved',
      updated_at = now()
  where id = v_id;

  update public.timesheets
  set client_approved = true, status = 'approved'
  where header_id = v_id;

  insert into public.notifications (type, title, body)
  values ('timesheet_client_approved',
          'Supervisor signed off: ' || coalesce(v_worker, 'worker') || ' — ' || coalesce(v_client, 'client'),
          'Timesheet accepted by the site supervisor. Approved and billable in Payroll.');

  return true;
end;
$$;
