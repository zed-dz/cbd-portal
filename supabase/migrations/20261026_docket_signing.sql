-- 20261026_docket_signing.sql
-- Dockets signed on site (Chris + Zeff chat, 2026-10-26):
--   * the worker signs their own sheet (worker_signature) and the foreman signs on the
--     worker's phone with name + email (client_signer_email) → approved on the spot,
--     the foreman and the client's assigned inbox get the PDF, the office gets a bell;
--   * the text-a-link page now takes a drawn signature + name + email too;
--   * every client (and optionally a site) has "send approved timesheets to" addresses.
-- Additive only.
alter table public.timesheet_headers add column if not exists worker_signature     text;
alter table public.timesheet_headers add column if not exists client_signer_email  text check (client_signer_email is null or char_length(client_signer_email) <= 160);
alter table public.timesheet_headers add column if not exists client_signer_company text check (client_signer_company is null or char_length(client_signer_company) <= 120);
alter table public.timesheet_headers add column if not exists signed_on_site_at    timestamptz;
alter table public.clients      add column if not exists timesheet_emails text[] not null default '{}';
alter table public.client_sites add column if not exists timesheet_emails text[] not null default '{}';
comment on column public.clients.timesheet_emails      is 'Every approved timesheet PDF for this client is emailed here (accounts / engineers).';
comment on column public.client_sites.timesheet_emails is 'Overrides the client list for this site when set.';

-- Office + the sheet's own worker may read these through the existing policies; the
-- client's assigned emails are office-managed columns on clients/client_sites (already
-- office-only for writes). Nothing money-related is added.

-- Token approval, v2: records the supervisor's drawn signature and email as well.
create or replace function public.approve_timesheet_via_token(p_token uuid, p_approver text, p_email text, p_signature text)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  v_id uuid; v_worker text; v_client text;
begin
  select h.id, w.name, h.client into v_id, v_worker, v_client
  from public.timesheet_headers h left join public.workers w on w.id = h.worker_id
  where h.client_approval_token = p_token and h.status <> 'rejected';
  if v_id is null then return false; end if;
  if p_signature is not null and (left(p_signature, 22) <> 'data:image/png;base64,' or char_length(p_signature) > 400000) then
    raise exception 'Draw your signature to accept.';
  end if;
  update public.timesheet_headers
  set client_approved = true,
      client_approved_at = coalesce(client_approved_at, now()),
      client_approved_by = coalesce(client_approved_by, nullif(btrim(coalesce(p_approver, '')), '')),
      client_signer_email = coalesce(client_signer_email, nullif(lower(btrim(coalesce(p_email, ''))), '')),
      client_signature = coalesce(client_signature, p_signature),
      status = 'approved', locked = true, updated_at = now()
  where id = v_id;
  update public.timesheets set client_approved = true, status = 'approved' where header_id = v_id;
  insert into public.notifications (type, title, body)
  values ('timesheet_client_approved',
          'Supervisor signed off: ' || coalesce(v_worker, 'worker') || ' - ' || coalesce(v_client, 'client'),
          'Accepted by ' || coalesce(nullif(btrim(coalesce(p_approver, '')), ''), 'the site supervisor') || ' with a signature. Approved, locked and billable in Payroll.');
  return true;
end;
$function$;
grant execute on function public.approve_timesheet_via_token(uuid, text, text, text) to anon, authenticated;

-- The public approve page may read the two signature fields and the signer email.
create or replace function public.get_timesheet_for_client_approval(p_token uuid)
returns jsonb language sql security definer set search_path to 'public', 'pg_temp' as $function$
  select jsonb_build_object(
    'header', jsonb_build_object(
      'client', h.client, 'project', h.project, 'role', h.role,
      'wet_hire', h.wet_hire, 'comments', h.comments,
      'client_signature', h.client_signature, 'worker_signature', h.worker_signature,
      'status', h.status, 'created_at', h.created_at,
      'client_approved', h.client_approved, 'client_approved_at', h.client_approved_at,
      'client_approved_by', h.client_approved_by, 'client_signer_email', h.client_signer_email,
      'worker_name', w.name
    ),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'date', t.date, 'shift_type', t.shift_type,
        'start_time', t.start_time, 'end_time', t.end_time,
        'total_break_hours', t.total_break_hours, 'break_minutes', t.break_minutes,
        'total_hours', t.total_hours, 'rdo_hours', t.rdo_hours, 'overtime_hours', t.overtime_hours, 'ot15_hours', t.ot15_hours, 'ot2x_hours', t.ot2x_hours, 'regular_hours', t.regular_hours,
        'meal_allowance', t.meal_allowance,
        'original_start_time', t.original_start_time, 'original_end_time', t.original_end_time,
        'original_break_minutes', t.original_break_minutes,
        'adjusted_by', t.adjusted_by, 'adjusted_at', t.adjusted_at
      ) order by t.date)
      from public.timesheets t where t.header_id = h.id), '[]'::jsonb)
  )
  from public.timesheet_headers h left join public.workers w on w.id = h.worker_id
  where h.client_approval_token = p_token and h.status <> 'rejected';
$function$;
