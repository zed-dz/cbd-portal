-- save_daily_timesheet now splits hours per the CLIENT's award_profile
-- (split_shift_hours_v2). Only three things changed from the previous version:
--   1. v_profile is looked up once from clients.award_profile,
--   2. the line's times/break are parsed BEFORE the split call,
--   3. the split call goes through split_shift_hours_v2 (which delegates to the
--      untouched legacy function for 'PORTAL' clients).
create or replace function public.save_daily_timesheet(
  p_header_id uuid, p_worker_id uuid, p_client text, p_project text, p_role text,
  p_wet_hire boolean, p_comments text, p_client_signature text,
  p_allowance_lines jsonb, p_status text, p_lines jsonb
) returns uuid
language plpgsql security definer
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
  v_worker_type text;
  v_profile text;
  v_old jsonb := '{}'::jsonb;
  v_snap jsonb;
  v_total numeric; v_regular numeric; v_ot numeric; v_rdo numeric;
  v_ot15 numeric; v_ot2x numeric;
  v_scenario text;
  v_start timestamptz; v_end timestamptz; v_break int;
  v_orig_start timestamptz; v_orig_end timestamptz; v_orig_break int;
  v_adj_by text; v_adj_at timestamptz;
  v_date date; v_shift text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select (w.access_level = 'admin'), w.name into v_is_admin, v_admin_name
  from public.workers w where lower(w.email) = lower((select u.email from auth.users u where u.id = auth.uid())) and w.archived_at is null;
  v_is_admin := coalesce(v_is_admin, false);

  select w.worker_type into v_worker_type from public.workers w where w.id = p_worker_id;

  -- Which hour rules apply is the CLIENT's setting (owner, 2026-09-27).
  select c.award_profile into v_profile
  from public.clients c where lower(c.name) = lower(coalesce(p_client, ''))
  order by c.created_at limit 1;

  for v_alw in select * from jsonb_array_elements(coalesce(p_allowance_lines, '[]'::jsonb))
  loop
    v_total_meal := v_total_meal + coalesce((v_alw->>'meal_allowance')::numeric, 0);
  end loop;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_total_hours := v_total_hours + coalesce((v_line->>'total_hours')::numeric, 0);
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
    v_total    := coalesce((v_line->>'total_hours')::numeric, 0);
    v_scenario := coalesce(nullif(v_line->>'scenario',''),'standard');
    v_date     := nullif(v_line->>'date','')::date;
    v_shift    := nullif(v_line->>'shift_type','');
    v_start    := nullif(v_line->>'start_time','')::timestamptz;
    v_end      := nullif(v_line->>'end_time','')::timestamptz;
    v_break    := round(coalesce((v_line->>'total_break_hours')::numeric,0) * 60)::int;

    -- One source of truth for the penalty split, per the client's profile.
    select s.ordinary, s.rdo, s.ot15, s.ot2x
      into v_regular, v_rdo, v_ot15, v_ot2x
      from public.split_shift_hours_v2(
        v_total, v_worker_type, v_date, v_shift, v_scenario,
        v_profile, v_start, v_end,
        coalesce((v_line->>'total_break_hours')::numeric, 0)) s;

    v_ot := v_ot15 + v_ot2x;
    v_total_regular := v_total_regular + coalesce(v_regular, 0);

    v_snap := v_old->(v_line->>'date');

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
       total_hours, regular_hours, hours, pay_hours, charge_hours,
       overtime_hours, ot15_hours, ot2x_hours, rdo_hours, is_night_shift,
       meal_allowance, status, notes,
       original_start_time, original_end_time, original_break_minutes,
       adjusted_by, adjusted_at)
    values
      (v_header_id, p_worker_id, p_client, p_project, p_role,
       v_date, v_scenario,
       v_start, v_end, v_break,
       coalesce((v_line->>'total_break_hours')::numeric,0),
       v_shift,
       v_total, v_regular,
       v_total, v_total, v_total,
       v_ot, v_ot15, v_ot2x, v_rdo,
       (coalesce(v_shift,'Day') = 'Night'),
       coalesce((v_line->>'meal_allowance')::numeric,0),
       coalesce(p_status,'pending'),
       nullif(v_line->>'notes',''),
       v_orig_start, v_orig_end, v_orig_break, v_adj_by, v_adj_at);
  end loop;

  return v_header_id;
end;
$function$;
