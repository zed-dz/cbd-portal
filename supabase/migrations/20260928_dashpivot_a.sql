-- Dashpivot parity, batch A (2026-09-28) — data-entry deltas.
--
-- ALREADY APPLIED LIVE (additive DDL, run 2026-09-28 via the Management API);
-- repeated here with IF NOT EXISTS so this file stands alone and is re-run-safe:
alter table public.timesheet_headers add column if not exists client_id uuid references public.clients(id) on delete set null;
alter table public.timesheet_headers add column if not exists site_id uuid references public.client_sites(id) on delete set null;
alter table public.timesheet_headers add column if not exists client_name_snapshot text;
alter table public.timesheet_headers add column if not exists site_name_snapshot text;
alter table public.timesheet_headers add column if not exists role_name_snapshot text;
alter table public.timesheets add column if not exists pay_worker boolean;
alter table public.timesheets add column if not exists bill_client boolean;
create index if not exists timesheet_headers_client_id_idx on public.timesheet_headers(client_id);
create index if not exists timesheet_headers_site_id_idx on public.timesheet_headers(site_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- NOT YET APPLIED — trigger below needs central review before running.
--
-- Prompt 1.3: the training rule enforced at the DB layer. Training stays a
-- SCENARIO (scenario = 'training_day'), matching the form's pseudo shift type
-- and payroll.js — deliberately NO separate is_training column.
--
-- Rule: on a training day, full-time (and any future part-time) workers are
-- PAID, casuals and subcontractors are NOT, and the client is NEVER billed.
-- The UI and payroll.js already apply this; the trigger closes the gap where a
-- direct insert/update (RLS is auth-wide today) could pay a casual for
-- training or bill a client for it.
--
-- SECURITY DEFINER: the workers-table lookup must succeed even for a caller
-- whose RLS view of workers is self-only (a worker inserting a row for
-- themselves passes anyway, but the definer keeps enforcement unconditional).
create or replace function public.apply_training_rule()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_type text;
begin
  if coalesce(new.scenario, 'standard') = 'training_day' then
    select w.worker_type into v_type from public.workers w where w.id = new.worker_id;
    -- Both hyphen and underscore spellings accepted: workers.worker_type uses
    -- 'full-time' today, but the Dashpivot data model spells it 'full_time'.
    new.pay_worker  := coalesce(v_type, '') in ('full-time', 'full_time', 'part-time', 'part_time');
    new.bill_client := false;
  else
    -- Non-training rows: default both flags to true when unset so every new
    -- row carries a meaningful value; an explicit value is never overridden.
    new.pay_worker  := coalesce(new.pay_worker, true);
    new.bill_client := coalesce(new.bill_client, true);
  end if;
  return new;
end;
$$;

-- Fires on EVERY insert/update (not a column list) so flipping bill_client to
-- true on a training row, or re-flagging a row as training, is always re-checked.
drop trigger if exists trg_timesheets_apply_training_rule on public.timesheets;
create trigger trg_timesheets_apply_training_rule
  before insert or update on public.timesheets
  for each row execute function public.apply_training_rule();

-- Backfill for existing rows (UPDATE — central review required, do not auto-run):
-- update public.timesheets t
--    set pay_worker = case when t.scenario = 'training_day'
--                          then (select w.worker_type in ('full-time','full_time','part-time','part_time')
--                                  from public.workers w where w.id = t.worker_id)
--                          else true end,
--        bill_client = (t.scenario is distinct from 'training_day')
--  where t.pay_worker is null or t.bill_client is null;
