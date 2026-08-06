-- Fixes from the 2026-08-06 page-by-page audit.
--
-- (a) timesheet_headers.total_regular_hours was summed from the value the FORM
--     sent (old 7.6-cap rule) while the line rows are now written from
--     split_shift_hours. For a casual 9.5h weekday the header said 7.6 and its
--     own lines said 8. The header must be derived from the same split.
--
-- (b) split_shift_hours ignored shift_type = 'Public Holiday'. The daily form
--     always sends scenario 'standard' (it has no scenario picker), so a public
--     holiday was paid as ordinary time even though the UI shows it as a
--     holiday. Now either signal triggers the 2x branch.
--
-- (c) get_timesheet_for_client_approval didn't return rdo_hours/overtime_hours,
--     so the supervisor's approval page rendered a full-timer's 0.4h RDO as
--     overtime.
--
-- (d) approved_by / approved_at were added to `timesheets` but the printed sheet
--     reads them off the HEADER, where they didn't exist — so the audit line
--     silently always fell back to the client-approval fields. Added to
--     timesheet_headers and populated by both approval paths.

-- ── (d) approver columns where the print actually reads them ────────────────
alter table public.timesheet_headers
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

comment on column public.timesheet_headers.approved_by is
  'Who approved this timesheet (site supervisor, admin, or "System" for the 7-day auto-approval). Shown on the printed sheet.';

-- Backfill from the supervisor sign-off we already recorded.
update public.timesheet_headers
   set approved_by = coalesce(approved_by, client_approved_by),
       approved_at = coalesce(approved_at, client_approved_at)
 where client_approved_by is not null;

-- ── (b) public holidays by shift_type as well as scenario ──────────────────
create or replace function public.split_shift_hours(
  p_total numeric, p_worker_type text, p_date date, p_shift_type text, p_scenario text
)
returns table (ordinary numeric, rdo numeric, ot15 numeric, ot2x numeric)
language plpgsql
immutable
as $$
declare
  v_total numeric := greatest(coalesce(p_total, 0), 0);
  v_dow   int     := extract(dow from p_date)::int;   -- 0 = Sunday, 6 = Saturday
  v_shift text    := coalesce(nullif(p_shift_type, ''), 'Day');
  v_night boolean := v_shift = 'Night';
  v_ph    boolean := coalesce(p_scenario, '') = 'public_holiday' or v_shift = 'Public Holiday';
  v_ft    boolean := p_worker_type = 'full-time';
begin
  ordinary := 0; rdo := 0; ot15 := 0; ot2x := 0;
  if v_total <= 0 then return next; return; end if;

  -- Leave and other non-worked scenarios are a flat ordinary day.
  if coalesce(p_scenario, 'standard') not in ('standard', 'emergency_callout', 'public_holiday') then
    ordinary := v_total;
    return next; return;
  end if;

  -- Everything at 2x: Sunday, public holidays, Saturday nights.
  if v_dow = 0 or v_ph or (v_dow = 6 and v_night) then
    ot2x := v_total;
    return next; return;
  end if;

  -- Saturday day: first 2 hours at 1.5x, the rest at 2x.
  if v_dow = 6 then
    ot15 := least(2, v_total);
    ot2x := v_total - ot15;
    return next; return;
  end if;

  -- Weekday night: whole shift is overtime, 1.5x for 8h then 2x.
  if v_night then
    ot15 := least(8, v_total);
    ot2x := v_total - ot15;
    return next; return;
  end if;

  -- Weekday day.
  if v_ft then
    ordinary := least(7.6, v_total);
    rdo      := least(0.4, v_total - ordinary);
  else
    ordinary := least(8, v_total);
  end if;
  ot15 := greatest(0, least(v_total, 10) - ordinary - rdo);
  ot2x := greatest(0, v_total - 10);
  return next;
end;
$$;

-- ── (a) header totals derived from the same split as the lines ─────────────
do $fix$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'save_daily_timesheet';
  if src is null then raise exception 'save_daily_timesheet not found'; end if;

  -- Stop trusting the form's regular_hours for the header total...
  src := replace(src,
    'v_total_regular := v_total_regular + coalesce((v_line->>''regular_hours'')::numeric, 0);',
    '-- header regular total is accumulated from split_shift_hours in the write loop below');

  -- ...and accumulate the authoritative value as each line is split.
  src := replace(src,
    'v_ot := v_ot15 + v_ot2x;',
    'v_ot := v_ot15 + v_ot2x;' || chr(10) ||
    '    v_total_regular := v_total_regular + coalesce(v_regular, 0);');

  execute src;
end
$fix$;

-- Recompute the header totals so the header agrees with its own lines.
update public.timesheet_headers h
   set total_regular_hours = s.reg
  from (select header_id, sum(coalesce(regular_hours,0)) as reg
          from public.timesheets group by header_id) s
 where s.header_id = h.id
   and h.total_regular_hours is distinct from s.reg;

-- ── (c) supervisor approval page gets the real split ───────────────────────
do $fix2$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_timesheet_for_client_approval';
  if src is null then raise notice 'get_timesheet_for_client_approval not found'; return; end if;
  if position('rdo_hours' in src) > 0 then raise notice 'already exposes rdo_hours'; return; end if;

  src := replace(src,
    '''total_hours'', t.total_hours',
    '''total_hours'', t.total_hours, ''rdo_hours'', t.rdo_hours, ''overtime_hours'', t.overtime_hours, ''ot15_hours'', t.ot15_hours, ''ot2x_hours'', t.ot2x_hours');
  execute src;
end
$fix2$;
