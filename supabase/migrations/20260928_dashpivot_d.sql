-- 20260928_dashpivot_d — supervisor dispute path + disputed sheets never auto-approve.
--
-- ⚠️ CENTRAL RUNS THIS, per project, after substituting two placeholders that
-- are inlined in the LIVE function this file replaces (they differ per project):
--   __REF__   → the Supabase project ref            (CBD: tsizneslellcqusjwtub)
--   __ANON__  → that project's anon key JWT          (copy it out of the live
--               auto_approve_stale_timesheets before replacing — it is inline
--               in the pg_net Authorization header)
--
-- No DDL: timesheet_headers.disputed_at / disputed_note already exist, and the
-- notifications insert uses the existing columns only.

-- ── 1. dispute_timesheet_via_token ──────────────────────────────────────────
-- Called by the PUBLIC ClientApprovePage on the anon key when the supervisor
-- taps "Something's wrong". The client_approval_token is the trust boundary,
-- same contract as approve_timesheet_via_token. Stamps disputed_at /
-- disputed_note on the matching header, lights the admin bell, returns true
-- when a header matched (false otherwise — the page shows a retry message).
-- A second dispute updates the note (keeping the old one if the new note is
-- empty) and re-rings the bell; disputed_at keeps its first value.
create or replace function public.dispute_timesheet_via_token(p_token uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_h record;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select h.id, h.client, h.project, w.name as worker_name
    into v_h
  from public.timesheet_headers h
  left join public.workers w on w.id = h.worker_id
  where h.client_approval_token = p_token
  limit 1;

  if v_h.id is null then
    return false;
  end if;

  update public.timesheet_headers
  set disputed_at   = coalesce(disputed_at, now()),
      disputed_note = coalesce(v_note, disputed_note),
      updated_at    = now()
  where id = v_h.id;

  insert into public.notifications (type, title, body)
  values ('timesheet_disputed',
          'Timesheet DISPUTED by supervisor: ' || coalesce(v_h.worker_name, 'worker') || ' - ' || coalesce(v_h.client, 'client'),
          coalesce(v_note, 'No note left.') || ' — the sheet is on hold (it will never auto-approve). Call the supervisor, fix it, then resend for approval.');

  return true;
end;
$$;

grant execute on function public.dispute_timesheet_via_token(uuid, text) to anon, authenticated;

-- ── 2. auto_approve_stale_timesheets — disputed sheets must NEVER auto-approve.
-- This is the CURRENT LIVE definition (fetched via pg_get_functiondef on
-- 2026-09-28), byte-identical except for:
--   * one added WHERE condition:  and h.disputed_at is null
--   * the per-project inline values replaced by __REF__ / __ANON__
CREATE OR REPLACE FUNCTION public.auto_approve_stale_timesheets()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select h.id, h.client, w.name as worker_name
    from public.timesheet_headers h
    left join public.workers w on w.id = h.worker_id
    where h.client_approved = false
      and h.status <> 'rejected'
      and h.disputed_at is null
      and coalesce(h.client_approval_sent_at, h.created_at) <= now() - interval '7 days'
  loop
    begin
      update public.timesheet_headers
      set client_approved = true,
          client_approved_at = now(),
          client_approved_by = 'Auto-approved - no supervisor response within 7 days',
          status = 'approved',
          locked = true,
          updated_at = now()
      where id = r.id;

      update public.timesheets
      set client_approved = true, status = 'approved'
      where header_id = r.id;

      insert into public.notifications (type, title, body)
      values ('timesheet_auto_approved',
              'Auto-approved after 7 days: ' || coalesce(r.worker_name, 'worker') || ' - ' || coalesce(r.client, 'client'),
              'No supervisor response within 7 days - approved automatically, locked, and now billable in Payroll. The client has been emailed the PDF copy.');

      begin
        perform net.http_post(
          url := 'https://__REF__.supabase.co/functions/v1/send-timesheet-pdf',
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer __ANON__'),
          body := jsonb_build_object('header_id', r.id, 'reason', 'auto')
        );
      exception when others then null;
      end;

      v_count := v_count + 1;
    exception when others then
      insert into public.notifications (type, title, body)
      values ('timesheet_auto_approve_failed',
              'Auto-approve FAILED: ' || coalesce(r.worker_name, 'worker') || ' - ' || coalesce(r.client, 'client'),
              left(sqlerrm, 200));
    end;
  end loop;
  return v_count;
end;
$function$;

-- ── Record of additive columns applied live 2026-09-28 (central, all 3 projects) ──
alter table public.timesheet_headers add column if not exists rejection_reason text;
alter table public.timesheet_headers add column if not exists disputed_at timestamptz;
alter table public.timesheet_headers add column if not exists disputed_note text;
alter table public.timesheets add column if not exists processed_at timestamptz;
alter table public.timesheets add column if not exists processed_by text;
