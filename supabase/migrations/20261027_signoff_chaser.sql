-- 20261027_signoff_chaser.sql
-- Zeff / Chris (2026-10-27): the office should only handle exceptions. A sign-off link that
-- sits unanswered for 2 days becomes one: a single office bell per sheet, so someone can
-- call the supervisor or press "Resend link". No extra texts to the client (noise), and the
-- 7-day auto-approve still closes it if nobody acts. Additive: one column + one function.
alter table public.timesheet_headers add column if not exists signoff_chased_at timestamptz;

create or replace function public.chase_unanswered_signoffs()
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare n integer := 0; r record;
begin
  for r in
    select h.id, h.client, h.project, h.client_approval_sent_at, w.name as worker_name
    from public.timesheet_headers h left join public.workers w on w.id = h.worker_id
    where h.status = 'pending' and h.client_approved is not true
      and h.client_approval_sent_at is not null
      and h.client_approval_sent_at < now() - interval '2 days'
      and h.client_approval_sent_at > now() - interval '7 days'
      and h.signoff_chased_at is null
  loop
    insert into public.notifications (type, title, body)
    values ('timesheet_signoff_unanswered',
            'Sign-off not answered for 2 days: ' || coalesce(r.worker_name, 'worker') || ' - ' || coalesce(r.project, r.client, 'site'),
            'The supervisor link went out on ' || to_char(r.client_approval_sent_at at time zone 'Australia/Sydney', 'DD/MM HH24:MI')
            || ' and nobody has accepted it. Call the supervisor or press Resend link in Timesheets. It finalises automatically after 7 days.');
    update public.timesheet_headers set signoff_chased_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$function$;
revoke all on function public.chase_unanswered_signoffs() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('chase-unanswered-signoffs');
exception when others then null; end $$;
select cron.schedule('chase-unanswered-signoffs', '30 22 * * *',   -- 22:30 UTC = 08:30/09:30 Sydney
  $$select public.chase_unanswered_signoffs()$$);
