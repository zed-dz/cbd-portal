-- Start date on the worker record (2026-11-09). Every contract template has a
-- {{start_date}} placeholder, so without it "Add Worker" could never send the
-- contract by itself: it always stopped at "type the contract details". Chris's
-- flow is "casual, $34, starting tomorrow" — the start date is typed on the
-- Add Worker form now and the contract fills itself. Additive; nullable.
alter table public.workers add column if not exists start_date date;
-- SELECT on workers is column-level for authenticated (money columns stay
-- hidden); INSERT/UPDATE are table-level already.
grant select (start_date) on public.workers to authenticated;
-- v_workers_admin was created with "select *", which Postgres expands at
-- creation time: the new column is invisible to admin screens until the view
-- is re-created. Adding a column at the end keeps "create or replace" legal.
create or replace view public.v_workers_admin as
  select * from public.workers where public.is_portal_admin();
revoke all on public.v_workers_admin from anon;
grant select on public.v_workers_admin to authenticated;
