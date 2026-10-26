-- 20261026_docket_signing_v2.sql
-- Token approval records what the SUPERVISOR submitted (signature, name, email), never a
-- value that was already on the row. The on-site path (worker's phone) is by design the
-- worker's device, so its signer email is treated as unverified downstream: the PDF goes to
-- it only when it matches the client's email domains or a known site contact.
create or replace function public.approve_timesheet_via_token(p_token uuid, p_approver text, p_email text, p_signature text)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
  v_id uuid; v_worker text; v_client text;
begin
  select h.id, w.name, h.client into v_id, v_worker, v_client
  from public.timesheet_headers h left join public.workers w on w.id = h.worker_id
  where h.client_approval_token = p_token and h.status <> 'rejected' and h.client_approved is not true;
  if v_id is null then return false; end if;
  if p_signature is not null and (left(p_signature, 22) <> 'data:image/png;base64,' or char_length(p_signature) > 400000) then
    raise exception 'Draw your signature to accept.';
  end if;
  update public.timesheet_headers
  set client_approved = true,
      client_approved_at = now(),
      client_approved_by = nullif(btrim(coalesce(p_approver, '')), ''),
      client_signer_email = nullif(lower(btrim(coalesce(p_email, ''))), ''),
      client_signature = coalesce(p_signature, client_signature),
      client_signer_company = null,
      signed_on_site_at = null,   -- this was the link path, not the worker's phone
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
