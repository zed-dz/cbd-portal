-- Admin notification roster RPC (2026-07-07 audit).
-- The worker accept/decline flow calls broadcastAdminSms/sendAdminEmail, which need the admin
-- roster. The workers RLS lockbox (workers_select_self_or_staff) lets a worker read only their own
-- row, so that client-side roster came back EMPTY for the worker path — the temporary SMS_ALLOWLIST
-- was the only thing making worker-triggered admin SMS work. This SECURITY DEFINER RPC returns the
-- admin notification roster (safe subset) regardless of the caller's RLS, so it works for both
-- admin- and worker-triggered events and the allowlist can be removed. Authenticated-only.
create or replace function public.get_admin_notification_recipients()
returns table (name text, mobile text, email text, notify_mode text, notify_sms boolean, notify_email boolean)
language sql
security definer
set search_path = public, pg_temp
as $$
  select w.name::text, w.mobile::text, w.email::text,
         coalesce(w.notify_mode, 'per_event')::text,
         w.notify_sms::boolean, w.notify_email::boolean
  from public.workers w
  where w.access_level = 'admin';
$$;

revoke all on function public.get_admin_notification_recipients() from public, anon;
grant execute on function public.get_admin_notification_recipients() to authenticated;
