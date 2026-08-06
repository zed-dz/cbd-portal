-- save_daily_timesheet identified the caller with `where w.id = auth.uid()`, but
-- workers.id is NOT the auth user id in this database — workers are matched to
-- logins by EMAIL. Verified on CBD 2026-08-06:
--   workers whose id matches an auth user : 0   (out of 10 workers, 7 auth users)
--   workers matched by email              : 5
--
-- So the lookup always returned no row, v_is_admin was permanently false, and
-- the admin adjustment audit trail (adjusted_by / adjusted_at) was never
-- stamped — the "who changed these hours, and when" feature added in July has
-- silently never recorded anything.
--
-- Fixed by resolving the caller through auth.users.email. Everything else in the
-- function is unchanged.

create or replace function public.current_worker_is_admin()
returns table (is_admin boolean, worker_name text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(w.access_level = 'admin', false), w.name::text
  from public.workers w
  where lower(w.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
    and w.archived_at is null
  order by w.created_at desc
  limit 1;
$$;

grant execute on function public.current_worker_is_admin() to authenticated;
