-- 2026-08-06 timesheet feedback round.
--
-- F11/F12 Penalty rates. The old model had a single `overtime_hours` bucket paid
--   at one OT rate, so "8 hours at 1.5x then 2 hours at 2x" could not be
--   expressed at all. Split into ot15_hours (band B, 1.5x) and ot2x_hours
--   (band C, 2x); `overtime_hours` is kept as their sum so existing payroll,
--   Xero export and reports keep working untouched.
--
--   Rules confirmed by the owner 2026-08-06:
--     Sunday                -> every hour at 2x
--     Public holiday        -> every hour at 2x
--     Saturday NIGHT        -> every hour at 2x (never split)
--     Saturday DAY          -> first 2h at 1.5x, the rest at 2x
--     Weekday NIGHT         -> first 8h at 1.5x, beyond 8h at 2x
--     Weekday DAY, full-time-> 7.6 ordinary + 0.4 RDO, then 1.5x to 10h, 2x after
--     Weekday DAY, casual   -> 8h ordinary, then 1.5x to 10h, 2x after
--   No RDO accrues on an all-overtime shift (owner decision): RDO is banked
--   only on a standard weekday DAY shift for a full-timer.
--
-- F10 Records WHO approved a timesheet and WHEN, so the printed sheet can carry
--   an audit trail if a client ever disputes it.
--
-- Applies to NEW timesheets only (owner decision) - no historical rows are
-- recalculated here, so nothing already paid or invoiced silently changes.

alter table public.timesheets
  add column if not exists ot15_hours  numeric not null default 0,
  add column if not exists ot2x_hours  numeric not null default 0,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

comment on column public.timesheets.ot15_hours is 'Overtime hours paid at band B (1.5x).';
comment on column public.timesheets.ot2x_hours is 'Overtime hours paid at band C (2x).';
comment on column public.timesheets.approved_by is 'Name of whoever approved this timesheet (site supervisor, admin, or "System" for the 7-day auto-approval).';

-- Backfill so historical rows keep paying exactly what they pay today: all of
-- their existing overtime sits in the 1.5x bucket. Nothing is re-rated.
update public.timesheets
   set ot15_hours = coalesce(overtime_hours, 0)
 where ot15_hours = 0 and coalesce(overtime_hours, 0) > 0;

-- ── The penalty-rate split, in one place ───────────────────────────────────
-- Returns ordinary / rdo / ot@1.5x / ot@2x for one worked day.
create or replace function public.split_shift_hours(
  p_total       numeric,
  p_worker_type text,
  p_date        date,
  p_shift_type  text,
  p_scenario    text
)
returns table (ordinary numeric, rdo numeric, ot15 numeric, ot2x numeric)
language plpgsql
immutable
as $$
declare
  v_total numeric := greatest(coalesce(p_total, 0), 0);
  v_dow   int     := extract(dow from p_date)::int;   -- 0 = Sunday, 6 = Saturday
  v_night boolean := coalesce(nullif(p_shift_type, ''), 'Day') = 'Night';
  v_ft    boolean := p_worker_type = 'full-time';
  v_ord_threshold numeric;
begin
  ordinary := 0; rdo := 0; ot15 := 0; ot2x := 0;
  if v_total <= 0 then return next; return; end if;

  -- Leave and other non-worked scenarios stay ordinary time; they are paid a
  -- flat day and must never attract a penalty rate.
  if coalesce(p_scenario, 'standard') not in ('standard', 'emergency_callout', 'public_holiday') then
    ordinary := v_total;
    return next; return;
  end if;

  -- Everything at 2x: Sunday, public holidays, and Saturday night shifts.
  if v_dow = 0
     or coalesce(p_scenario, '') = 'public_holiday'
     or (v_dow = 6 and v_night) then
    ot2x := v_total;
    return next; return;
  end if;

  -- Saturday day: first 2 hours at 1.5x, everything after at 2x.
  if v_dow = 6 then
    ot15 := least(2, v_total);
    ot2x := v_total - ot15;
    return next; return;
  end if;

  -- Weekday night: the whole shift is overtime, 1.5x for 8h then 2x.
  if v_night then
    ot15 := least(8, v_total);
    ot2x := v_total - ot15;
    return next; return;
  end if;

  -- Weekday day. Full-timers bank 0.4h RDO on top of 7.6h ordinary; casuals and
  -- subcontractors get a flat 8h ordinary and never accrue RDO.
  if v_ft then
    ordinary := least(7.6, v_total);
    rdo      := least(0.4, v_total - ordinary);
  else
    ordinary := least(8, v_total);
  end if;

  -- Overtime past the ordinary block: 1.5x up to the 10th hour, then 2x.
  ot15 := greatest(0, least(v_total, 10) - ordinary - rdo);
  ot2x := greatest(0, v_total - 10);
  return next;
end;
$$;

grant execute on function public.split_shift_hours(numeric, text, date, text, text) to authenticated, anon;

-- ── save_daily_timesheet v4: use the shared split ──────────────────────────
create or replace function public.save_daily_timesheet(
  p_header_id uuid, p_worker_id uuid, p_client text, p_project text, p_role text,
  p_wet_hire boolean, p_comments text, p_client_signature text,
  p_allowance_lines jsonb, p_status text, p_lines jsonb
)
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
  v_worker_type text;
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
  from public.workers w where w.id = auth.uid();
  v_is_admin := coalesce(v_is_admin, false);

  select w.worker_type into v_worker_type from public.workers w where w.id = p_worker_id;

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

    -- One source of truth for the penalty split (see split_shift_hours above).
    select s.ordinary, s.rdo, s.ot15, s.ot2x
      into v_regular, v_rdo, v_ot15, v_ot2x
      from public.split_shift_hours(v_total, v_worker_type, v_date, v_shift, v_scenario) s;

    v_ot := v_ot15 + v_ot2x;

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
