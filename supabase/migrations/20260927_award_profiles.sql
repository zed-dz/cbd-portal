-- Per-client hour rules (owner decision 2026-09-27):
--   clients.award_profile = 'A' | 'B' | 'C'  -> Dashpivot rules (docs/dashpivot/03 + code/hoursCalc.ts)
--                         = 'PORTAL'         -> the legacy 7.6h + RDO model, kept intact and
--                                               restorable per client by flipping this one value.
-- CBD backfills to 'B' (clients signed ~4,700 Dashpivot timesheets on these rules);
-- MRA/Hecate backfill to 'PORTAL' so nothing changes there until their owners say so.

alter table public.clients add column if not exists award_profile text default 'B';
do $$ begin
  alter table public.clients
    add constraint clients_award_profile_ck check (award_profile in ('A','B','C','PORTAL'));
exception when duplicate_object then null; end $$;

-- split_shift_hours_v2: the per-profile penalty split. The legacy function
-- split_shift_hours is UNTOUCHED — 'PORTAL' (and any null/unknown profile)
-- delegates straight to it, which is the restore path.
create or replace function public.split_shift_hours_v2(
  p_total numeric, p_worker_type text, p_date date, p_shift_type text,
  p_scenario text, p_profile text, p_start timestamptz, p_end timestamptz, p_break numeric
) returns table(ordinary numeric, rdo numeric, ot15 numeric, ot2x numeric)
language plpgsql immutable as $fn$
declare
  v_profile text := upper(coalesce(nullif(p_profile, ''), 'PORTAL'));
  v_dow int; v_wk boolean;
  v_shift text := coalesce(nullif(p_shift_type, ''), 'Day');
  v_is_night boolean; v_is_day boolean; v_ph boolean;
  e numeric; f numeric; g numeric := coalesce(p_break, 0);
  h numeric; i numeric := 0; j numeric := 0; k numeric;
  v_worked numeric; v_dur numeric; v_ph_factor numeric;
begin
  ordinary := 0; rdo := 0; ot15 := 0; ot2x := 0;

  -- Legacy portal rules, byte-identical, via the original function.
  if v_profile not in ('A', 'B', 'C') or p_start is null or p_end is null or p_date is null then
    select s.ordinary, s.rdo, s.ot15, s.ot2x into ordinary, rdo, ot15, ot2x
      from public.split_shift_hours(p_total, p_worker_type, p_date, p_shift_type, p_scenario) s;
    return next; return;
  end if;

  -- Leave / rain-off / training etc: flat ordinary under every profile
  -- (payroll zeroes unpaid cases; charge rules live elsewhere).
  if coalesce(p_scenario, 'standard') not in ('standard', 'emergency_callout', 'public_holiday') then
    ordinary := greatest(coalesce(p_total, 0), 0);
    return next; return;
  end if;

  v_dow := extract(dow from p_date)::int;          -- 0 Sun .. 6 Sat
  v_wk := v_dow between 1 and 5;
  v_is_night := v_shift = 'Night';
  v_is_day := not v_is_night;                       -- 'Weekend'/'Public Holiday' shift types count as day
  v_ph := coalesce(p_scenario, '') = 'public_holiday' or v_shift = 'Public Holiday';

  -- Wall-clock hours as the worker typed them (times are stored as instants).
  e := extract(hour from (p_start at time zone 'Australia/Sydney'))::numeric
     + extract(minute from (p_start at time zone 'Australia/Sydney'))::numeric / 60;
  f := extract(hour from (p_end   at time zone 'Australia/Sydney'))::numeric
     + extract(minute from (p_end   at time zone 'Australia/Sydney'))::numeric / 60;

  -- Dashpivot: a DAY shift starting at/after 17:00 is invalid -> all zeros
  -- (the form blocks this before submit; this is the server-side backstop).
  if v_is_day and e >= 17 then return next; return; end if;

  v_dur := case when f - e < 0 then f - e + 24 else f - e end;

  if v_profile = 'A' then
    h := round((v_dur - g) / 0.25) * 0.25;
  else
    v_worked := case when v_ph then 0 else v_dur - g end;
    h := round((v_worked + case when v_ph then 8 else 0 end) / 0.25) * 0.25;
  end if;

  -- Regular (1.0x): weekday day shifts only, capped at 8, inside the
  -- 05:00-17:00 window. The window cases deliberately ignore the break —
  -- that is how Dashpivot behaves and what clients signed.
  if v_is_day and v_wk then
    if e >= 5 and f <= 17 then i := least(h, 8);
    elsif e >= 5 and f > 17 then i := least(17 - e, 8);
    elsif e < 5 and f <= 17 then i := least(f - 5, 8);
    else i := 8;
    end if;
  end if;
  i := round(i / 0.25) * 0.25;

  v_ph_factor := case when v_profile = 'A' then 1 when v_ph then 0 else 1 end;

  if v_is_day and v_wk then
    if e >= 5 and f <= 17 then
      j := j + greatest(least(h - 8, 2), 0);
    elsif e < 5 and f > 17 then
      j := j + 2;
    else
      j := j + least(h - i, 2);   -- can go negative on tiny shifts: faithful to Dashpivot
    end if;
  end if;
  if v_is_night and v_wk then
    if e >= 17 then j := j + least(h, 8);
    elsif v_profile = 'C' and e < 5 then
      if h <= 8 then j := j + h;
      elsif f > 5 then j := j + 8;
      end if;
    end if;
  end if;
  if v_dow = 6 and v_is_day and i = 0 then j := j + least(h, 2); end if;
  j := round((j * v_ph_factor) / 0.25) * 0.25;

  k := round((h - i - j) / 0.25) * 0.25;

  ordinary := i; rdo := 0; ot15 := j; ot2x := k;
  return next;
end;
$fn$;
