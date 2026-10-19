-- 2026-10-19 — "Did you finish work early?" on the daily timesheet (owner ask).
-- Additive. Answered by the worker before the hours; a Yes carries a short
-- reason ("Rained off", "Sick", "Sent home"…, max 40 chars in the form).
alter table public.timesheet_headers add column if not exists finished_early boolean;
alter table public.timesheet_headers add column if not exists finished_early_reason text;
