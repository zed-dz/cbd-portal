create or replace function public.tg_timesheets_casual_travel()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_wt text;
begin
  select worker_type into v_wt from public.workers where id = new.worker_id;
  if coalesce(new.travel_allowance, 0) = 0 then
    new.travel_allowance := public.casual_travel_allowance(v_wt, new.scenario);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_timesheets_casual_travel on public.timesheets;
create trigger trg_timesheets_casual_travel
  before insert on public.timesheets
  for each row execute function public.tg_timesheets_casual_travel();