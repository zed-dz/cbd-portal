-- F12 (part 2): casuals get ONE travel allowance per shift.
--
-- The owner's note says the dollar value is configured in Xero/MYOB and doesn't
-- need to show on the timesheet, so this deliberately does NOT invent an amount.
-- The rate lives in payroll_config and starts EMPTY, which means the behaviour is
-- inert until the office fills it in — no silent change to anyone's pay.
--
-- Once set, save_daily_timesheet stamps it once per casual shift line (one line
-- = one shift), so the Xero export carries the right number of allowances.

insert into public.payroll_config (config_key, config_value, description)
values ('travel_allowance_casual', '',
        'Travel allowance paid to a CASUAL worker, once per shift. Leave blank if the allowance is applied in Xero/MYOB instead.')
on conflict (config_key) do nothing;

create or replace function public.casual_travel_allowance(p_worker_type text, p_scenario text)
returns numeric
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select case
    when p_worker_type <> 'casual' then 0
    when coalesce(p_scenario, 'standard') not in ('standard', 'emergency_callout') then 0
    else coalesce(
      (select nullif(trim(config_value), '')::numeric
         from payroll_config where config_key = 'travel_allowance_casual'), 0)
  end;
$$;

grant execute on function public.casual_travel_allowance(text, text) to authenticated, anon;
