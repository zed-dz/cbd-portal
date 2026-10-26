-- 20261026_approve_on_site_rpc.sql
-- Approve-on-the-spot, server side. The worker's phone may not flip its own sheet to
-- approved (RLS, by design). This function does it ONLY when the sheet carries a
-- supervisor signature and name, for the caller's own sheet (or any sheet for the office),
-- and tells the office. The signer email stays "unverified" for the PDF function.
create or replace function public.approve_timesheet_on_site(p_header_id uuid, p_signer text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  v_me uuid := public.current_worker_id();
  v_office boolean := public.is_office_user();
  h record; v_worker text;
begin
  select id, worker_id, status, client, client_signature, client_approved, client_signer_email, client_signer_company
    into h from public.timesheet_headers where id = p_header_id;
  if h.id is null then return jsonb_build_object('ok', false, 'error', 'timesheet not found'); end if;
  if not v_office and (v_me is null or h.worker_id <> v_me) then return jsonb_build_object('ok', false, 'error', 'not your timesheet'); end if;
  if h.client_approved then return jsonb_build_object('ok', true, 'already', true); end if;
  if h.status in ('rejected', 'approved') then return jsonb_build_object('ok', false, 'error', 'timesheet is ' || h.status); end if;
  if coalesce(left(h.client_signature, 22), '') <> 'data:image/png;base64,' then return jsonb_build_object('ok', false, 'error', 'no supervisor signature on the sheet'); end if;
  if coalesce(char_length(btrim(p_signer)), 0) < 2 then return jsonb_build_object('ok', false, 'error', 'supervisor name missing'); end if;

  update public.timesheet_headers
  set client_approved = true, client_approved_at = now(), client_approved_by = left(btrim(p_signer), 160),
      signed_on_site_at = coalesce(signed_on_site_at, now()),
      status = 'approved', locked = true, approved_at = now(), updated_at = now()
  where id = h.id;
  update public.timesheets set client_approved = true, status = 'approved' where header_id = h.id;

  select w.name into v_worker from public.workers w where w.id = h.worker_id;
  insert into public.notifications (type, title, body, worker_id)
  values ('timesheet_signed_on_site',
          'Docket signed on site: ' || coalesce(v_worker, 'worker') || ' - ' || coalesce(h.client, 'client'),
          'Signed by ' || left(btrim(p_signer), 160) || ' on the worker''s phone' || case when h.client_signer_email is not null then ' (' || h.client_signer_email || ')' else '' end || '. Approved, locked and billable; the PDF is on its way.',
          h.worker_id);
  return jsonb_build_object('ok', true);
end;
$function$;
grant execute on function public.approve_timesheet_on_site(uuid, text) to authenticated;
