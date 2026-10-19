-- Post-audit hardening (2026-10-19, after the 84/100 review).
-- 1. clock_events: the time is the server's, never the phone's. A worker can
--    insert (at := now()) and later only link header_id; nothing else changes.
-- 2. leave_requests: a worker may withdraw their own PENDING request (→ cancelled).
-- 3. Signature rows record ip + user agent (filled server-side by notify-admins-ops).

create or replace function public.clock_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_office_user() then
      new.at := now();
    end if;
    return new;
  end if;
  if not public.is_office_user() then
    if new.at is distinct from old.at
       or new.kind is distinct from old.kind
       or new.worker_id is distinct from old.worker_id
       or new.lat is distinct from old.lat
       or new.lng is distinct from old.lng
       or new.accuracy_m is distinct from old.accuracy_m
       or new.allocation_id is distinct from old.allocation_id
       or new.device is distinct from old.device
       or new.created_at is distinct from old.created_at then
      raise exception 'clock events are read-only once recorded (only the timesheet link may be set)';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists trg_clock_events_guard on public.clock_events;
create trigger trg_clock_events_guard
  before insert or update on public.clock_events
  for each row execute function public.clock_events_guard();

alter table public.leave_requests drop constraint if exists leave_requests_status_check;
alter table public.leave_requests
  add constraint leave_requests_status_check
  check (status in ('pending', 'approved', 'declined', 'cancelled'));

drop policy if exists "leave_requests worker cancel own" on public.leave_requests;
create policy "leave_requests worker cancel own" on public.leave_requests
  for update to authenticated
  using (worker_id = public.current_worker_id() and status = 'pending')
  with check (worker_id = public.current_worker_id() and status = 'cancelled');
grant update on public.leave_requests to authenticated;

alter table public.document_signatures add column if not exists user_agent text;
alter table public.site_induction_signatures add column if not exists ip text;
alter table public.site_induction_signatures add column if not exists user_agent text;
