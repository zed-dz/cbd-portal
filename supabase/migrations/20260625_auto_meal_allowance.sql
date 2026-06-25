-- 20260625_auto_meal_allowance.sql
-- Feature 1: AUTOMATIC meal allowance (authoritative compute-on-save).
--
-- Rule: for each worked timesheet line, if total_hours >= meal_allowance_trigger
-- (payroll_config, default 9.5h) the line's meal_allowance is set to
-- meal_allowance_amount (payroll_config, default 18.70); otherwise 0.
-- An admin may override a line by setting meal_allowance_override = true and
-- providing the desired meal_allowance — the trigger then leaves it untouched.
--
-- Persistence is enforced by triggers on the `timesheets` line table, so the
-- value is correct no matter how it is written (the save_daily_timesheet RPC,
-- direct inserts, or admin edits). An AFTER trigger keeps the parent
-- timesheet_headers totals (total_meal_allowance) and the allowance_lines JSONB
-- in sync with the child line rows.

-- 1. Per-line admin override flag (defaults to false = auto).
ALTER TABLE public.timesheets
  ADD COLUMN IF NOT EXISTS meal_allowance_override boolean NOT NULL DEFAULT false;

-- 2. Helper: read a numeric payroll_config value with a fallback default.
CREATE OR REPLACE FUNCTION public.payroll_config_num(p_key text, p_default numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(regexp_replace((SELECT config_value FROM public.payroll_config
                           WHERE config_key = p_key LIMIT 1), '[^0-9.]', '', 'g'), '')::numeric,
    p_default
  );
$$;

-- 3. BEFORE INSERT/UPDATE on a line: auto-compute meal_allowance from hours,
--    unless this row is flagged as an admin override.
CREATE OR REPLACE FUNCTION public.tg_timesheets_auto_meal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trigger numeric := public.payroll_config_num('meal_allowance_trigger', 9.5);
  v_amount  numeric := public.payroll_config_num('meal_allowance_amount', 18.70);
  v_hours   numeric := COALESCE(NEW.total_hours, 0);
BEGIN
  IF COALESCE(NEW.meal_allowance_override, false) THEN
    -- Admin override: keep whatever meal_allowance was supplied.
    NEW.meal_allowance := COALESCE(NEW.meal_allowance, 0);
  ELSE
    NEW.meal_allowance := CASE WHEN v_hours >= v_trigger THEN v_amount ELSE 0 END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS timesheets_auto_meal ON public.timesheets;
CREATE TRIGGER timesheets_auto_meal
  BEFORE INSERT OR UPDATE OF total_hours, meal_allowance, meal_allowance_override
  ON public.timesheets
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_timesheets_auto_meal();

-- 4. AFTER INSERT/UPDATE/DELETE on a line: resync the parent header's
--    total_meal_allowance and allowance_lines JSONB from the child line rows.
CREATE OR REPLACE FUNCTION public.tg_timesheets_sync_header_meal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_header uuid := COALESCE(NEW.header_id, OLD.header_id);
BEGIN
  IF v_header IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE public.timesheet_headers h
  SET
    total_meal_allowance = sub.total_meal,
    allowance_lines      = sub.lines,
    updated_at           = now()
  FROM (
    SELECT
      COALESCE(SUM(t.meal_allowance), 0) AS total_meal,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('date', t.date, 'meal_allowance', t.meal_allowance)
          ORDER BY t.date
        ) FILTER (WHERE COALESCE(t.meal_allowance, 0) > 0),
        '[]'::jsonb
      ) AS lines
    FROM public.timesheets t
    WHERE t.header_id = v_header
  ) sub
  WHERE h.id = v_header;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS timesheets_sync_header_meal ON public.timesheets;
CREATE TRIGGER timesheets_sync_header_meal
  AFTER INSERT OR UPDATE OR DELETE
  ON public.timesheets
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_timesheets_sync_header_meal();

-- 5. Backfill existing line rows so historical data reflects the auto rule.
--    (Override rows are left as-is.)
UPDATE public.timesheets t
SET meal_allowance = CASE
      WHEN COALESCE(t.total_hours, 0) >= public.payroll_config_num('meal_allowance_trigger', 9.5)
      THEN public.payroll_config_num('meal_allowance_amount', 18.70)
      ELSE 0 END
WHERE COALESCE(t.meal_allowance_override, false) = false;
