-- URGENT correction to 20260806_penalty_rates_and_approver.sql.
--
-- That migration made ot15_hours / ot2x_hours NOT NULL DEFAULT 0 and backfilled
-- ot15_hours from the legacy overtime_hours column. Both were wrong:
--
--  1. NOT NULL DEFAULT 0 means "has a stored split" cannot be distinguished from
--     "no split recorded". payroll.js tested `ot15_hours != null`, which is true
--     for EVERY row, so the Saturday / Sunday / public-holiday / night branches
--     became unreachable for all historical rows.
--  2. The backfill copied legacy overtime into the 1.5x bucket. On a Sunday that
--     is simply wrong — Sunday is 2x for every hour — so an already-approved
--     Sunday sheet would have been re-rated DOWN by about 45%.
--
-- The owner's decision was "new timesheets only". So: make the columns nullable,
-- and clear them everywhere. Existing rows then have no stored split, fall back
-- to the original pay logic, and are paid exactly as they were before. Only
-- timesheets saved from now on (written by save_daily_timesheet, which always
-- sets both buckets) use the new split.

alter table public.timesheets
  alter column ot15_hours drop default,
  alter column ot15_hours drop not null,
  alter column ot2x_hours drop default,
  alter column ot2x_hours drop not null;

-- Undo the bad backfill: no historical row carries a stored split.
update public.timesheets
   set ot15_hours = null,
       ot2x_hours = null;

comment on column public.timesheets.ot15_hours is
  'Overtime hours at band B (1.5x). NULL means no split was recorded (pre-2026-08-06 row) - pay falls back to the legacy day-type rules.';
comment on column public.timesheets.ot2x_hours is
  'Overtime hours at band C (2x). NULL means no split was recorded (pre-2026-08-06 row).';
