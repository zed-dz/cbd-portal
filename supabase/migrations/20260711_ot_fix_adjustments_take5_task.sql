-- 2026-07-11 — Team feedback round
-- 1) FIX: save_daily_timesheet was writing pay_hours = regular_hours (7.6-capped)
--    and never setting overtime_hours, so every daily-flow submission silently
--    dropped the worker's overtime from pay while still charging the client the
--    full hours. pay_hours now = total worked hours, overtime_hours = total - regular.
-- 2) Audit trail for admin time adjustments: the edit model is delete+reinsert,
--    so the originally-submitted times are snapshotted and carried across saves.
--    adjusted_by/adjusted_at are stamped only when an ADMIN changes times away
--    from the original submission (a worker editing their own pending sheet just
--    updates it — that's a resubmission, not an adjustment).
-- 3) Take 5: task + per-task hazards/controls (jsonb [{hazard, control}]).

alter table public.timesheets
  add column if not exists original_start_time    timestamptz,
  add column if not exists original_end_time      timestamptz,
  add column if not exists original_break_minutes int,
  add column if not exists adjusted_by            text,
  add column if not exists adjusted_at            timestamptz;

alter table public.take5
  add column if not exists task         text,
  add column if not exists task_hazards jsonb default '[]'::jsonb;

create or replace function public.save_daily_timesheet(
  p_header_id uuid, p_worker_id uuid, p_client text, p_project text, p_role text,
  p_wet_hire boolean, p_comments text, p_client_signature text,
  p_allowance_lines jsonb, p_status text, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_header_id uuid;
  v_line jsonb;
  v_total_hours numeric := 0;
  v_total_regular numeric := 0;
  v_total_meal numeric := 0;
  v_alw jsonb;
  v_is_admin boolean := false;
  v_admin_name text;
  v_old jsonb := '{}'::jsonb;
  v_snap jsonb;
  v_total numeric; v_regular numeric; v_ot numeric;
  v_start timestamptz; v_end timestamptz; v_break int;
  v_orig_start timestamptz; v_orig_end timestamptz; v_orig_break int;
  v_adj_by text; v_adj_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select (w.access_level = 'admin'), w.name into v_is_admin, v_admin_name
  from public.workers w where w.id = auth.uid();
  v_is_admin := coalesce(v_is_admin, false);

  for v_alw in select * from jsonb_array_elements(coalesce(p_allowance_lines, '[]'::jsonb))
  loop
    v_total_meal := v_total_meal + coalesce((v_alw->>'meal_allowance')::numeric, 0);
  end loop;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_total_hours   := v_total_hours   + coalesce((v_line->>'total_hours')::numeric, 0);
    v_total_regular := v_total_regular + coalesce((v_line->>'regular_hours')::numeric, 0);
  end loop;

  if p_header_id is null then
    insert into public.timesheet_headers
      (worker_id, client, project, role, wet_hire, comments, client_signature,
       allowance_lines, total_hours, total_regular_hours, total_meal_allowance, status)
    values
      (p_worker_id, p_client, p_project, p_role, coalesce(p_wet_hire,false), p_comments, p_client_signature,
       coalesce(p_allowance_lines,'[]'::jsonb), v_total_hours, v_total_regular, v_total_meal, coalesce(p_status,'pending'))
    returning id into v_header_id;
  else
    v_header_id := p_header_id;
    update public.timesheet_headers set
      worker_id = p_worker_id, client = p_client, project = p_project, role = p_role,
      wet_hire = coalesce(p_wet_hire,false), comments = p_comments, client_signature = p_client_signature,
      allowance_lines = coalesce(p_allowance_lines,'[]'::jsonb),
      total_hours = v_total_hours, total_regular_hours = v_total_regular,
      total_meal_allowance = v_total_meal, status = coalesce(p_status,status),
      updated_at = now()
    where id = v_header_id;

    -- snapshot the prior line rows (keyed by date) so first-submitted times and
    -- any existing adjustment stamps survive the delete+reinsert below
    select coalesce(jsonb_object_agg(t.date::text, jsonb_build_object(
      'orig_start', coalesce(t.original_start_time,    t.start_time),
      'orig_end',   coalesce(t.original_end_time,      t.end_time),
      'orig_break', coalesce(t.original_break_minutes, t.break_minutes),
      'adj_by', t.adjusted_by, 'adj_at', t.adjusted_at
    )), '{}'::jsonb) into v_old
    from public.timesheets t where t.header_id = v_header_id;
  end if;

  delete from public.timesheets where header_id = v_header_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_total   := coalesce((v_line->>'total_hours')::numeric, 0);
    v_regular := coalesce((v_line->>'regular_hours')::numeric, 0);
    v_ot      := greatest(0, v_total - v_regular);
    v_start   := nullif(v_line->>'start_time','')::timestamptz;
    v_end     := nullif(v_line->>'end_time','')::timestamptz;
    v_break   := round(coalesce((v_line->>'total_break_hours')::numeric,0) * 60)::int;
    v_snap    := v_old->(v_line->>'date');

    if v_snap is not null then
      v_orig_start := (v_snap->>'orig_start')::timestamptz;
      v_orig_end   := (v_snap->>'orig_end')::timestamptz;
      v_orig_break := (v_snap->>'orig_break')::int;
      v_adj_by     := v_snap->>'adj_by';
      v_adj_at     := (v_snap->>'adj_at')::timestamptz;
      if v_is_admin and (v_start is distinct from v_orig_start
                      or v_end   is distinct from v_orig_end
                      or v_break is distinct from v_orig_break) then
        v_adj_by := coalesce(v_admin_name, 'Admin');
        v_adj_at := now();
      end if;
    else
      v_orig_start := v_start; v_orig_end := v_end; v_orig_break := v_break;
      v_adj_by := null; v_adj_at := null;
    end if;

    insert into public.timesheets
      (header_id, worker_id, client, project, role, date, scenario,
       start_time, end_time, break_minutes, total_break_hours, shift_type,
       total_hours, regular_hours, hours, pay_hours, charge_hours, overtime_hours,
       meal_allowance, status, notes,
       original_start_time, original_end_time, original_break_minutes,
       adjusted_by, adjusted_at)
    values
      (v_header_id, p_worker_id, p_client, p_project, p_role,
       nullif(v_line->>'date','')::date,
       coalesce(nullif(v_line->>'scenario',''),'standard'),
       v_start, v_end, v_break,
       coalesce((v_line->>'total_break_hours')::numeric,0),
       nullif(v_line->>'shift_type',''),
       v_total, v_regular,
       v_total,   -- hours mirror
       v_total,   -- pay_hours = ALL worked hours (was regular_hours: OT was being lost)
       v_total,   -- charge_hours
       v_ot,
       coalesce((v_line->>'meal_allowance')::numeric,0),
       coalesce(p_status,'pending'),
       nullif(v_line->>'notes',''),
       v_orig_start, v_orig_end, v_orig_break, v_adj_by, v_adj_at);
  end loop;

  return v_header_id;
end;
$function$;
