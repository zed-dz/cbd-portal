-- Post-audit hardening, part 2 (2026-10-19).
-- 1. workers.xero_employee_id may only be changed by a portal admin (the
--    column is hidden from reads but UPDATE on workers is granted broadly).
-- 2. plant_hours rows can never be moved to another timesheet (a move could
--    slip hours out of a locked sheet or into one).

create or replace function public.guard_xero_employee_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.xero_employee_id is distinct from old.xero_employee_id
     and not public.is_portal_admin() then
    raise exception 'only an admin can link a worker to Xero';
  end if;
  return new;
end
$$;

drop trigger if exists trg_guard_xero_employee_id on public.workers;
create trigger trg_guard_xero_employee_id
  before update of xero_employee_id on public.workers
  for each row execute function public.guard_xero_employee_id();

create or replace function public.plant_hours_no_move()
returns trigger
language plpgsql
as $$
begin
  if new.header_id is distinct from old.header_id then
    raise exception 'plant hours cannot be moved to another timesheet';
  end if;
  return new;
end
$$;

drop trigger if exists trg_plant_hours_no_move on public.plant_hours;
create trigger trg_plant_hours_no_move
  before update on public.plant_hours
  for each row execute function public.plant_hours_no_move();
