-- =====================================================================
-- Dashpivot parity — Phase 2.1 approval pipeline (lock + version + reset)
-- FOR CENTRAL REVIEW — NOT YET RUN. The additive column/index DDL in §1
-- was already applied to tsizneslellcqusjwtub on 2026-09-28 (idempotent
-- here for other environments / MRA-Hecate porting later). Everything
-- from §2 down (trigger function, triggers, RPC, storage policy) is NEW
-- and must be reviewed + run by central.
-- =====================================================================

-- ---------- 1. Additive columns + indexes (ALREADY APPLIED LIVE) ----------
alter table public.timesheet_headers
  add column if not exists locked boolean default false,
  add column if not exists version int default 1,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;
create index if not exists timesheet_sends_created_idx on public.timesheet_sends (created_at desc);
create index if not exists timesheet_sends_header_idx  on public.timesheet_sends (header_id, created_at desc);

-- ---------- 2. Lock rule (mirrors docs/dashpivot/04-DATA-MODEL.sql §4) ----------
-- One function serves both tables. Headers: while locked stays true, only the
-- workflow/pdf columns may change (status, locked, version, pdf_emailed_at/_to,
-- updated_at); flipping locked -> false is the sanctioned unlock path and only
-- reset_timesheet_workflow() should do it. Line rows carry no locked column —
-- the lock lives on the parent header — and because save_daily_timesheet edits
-- via delete+reinsert, INSERT and DELETE under a locked header must be blocked
-- too, or the lock is meaningless. Post-approval flows still need to flip
-- status/approved_*/client_approved/xero_exported on lines, so those stay open.
create or replace function public.block_locked_edits() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_locked boolean;
begin
  if tg_table_name = 'timesheet_headers' then
    if tg_op = 'DELETE' then
      if coalesce(old.locked, false) then
        raise exception 'Timesheet is approved and locked. Use Reset workflow first.';
      end if;
      return old;
    end if;
    if coalesce(old.locked, false) and coalesce(new.locked, false)
       and (to_jsonb(new) - 'locked' - 'status' - 'version' - 'pdf_emailed_at' - 'pdf_emailed_to' - 'updated_at')
        <> (to_jsonb(old) - 'locked' - 'status' - 'version' - 'pdf_emailed_at' - 'pdf_emailed_to' - 'updated_at') then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  end if;

  -- timesheets line rows
  if tg_op = 'INSERT' then
    select h.locked into v_locked from public.timesheet_headers h where h.id = new.header_id;
    if coalesce(v_locked, false) then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    select h.locked into v_locked from public.timesheet_headers h where h.id = old.header_id;
    if coalesce(v_locked, false) then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return old;
  else
    select h.locked into v_locked from public.timesheet_headers h where h.id = old.header_id;
    if coalesce(v_locked, false)
       and (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'client_approved' - 'xero_exported')
        <> (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'client_approved' - 'xero_exported') then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  end if;
end $$;

drop trigger if exists trg_block_locked_header on public.timesheet_headers;
create trigger trg_block_locked_header
  before update or delete on public.timesheet_headers
  for each row execute function public.block_locked_edits();

drop trigger if exists trg_block_locked_lines on public.timesheets;
create trigger trg_block_locked_lines
  before insert or update or delete on public.timesheets
  for each row execute function public.block_locked_edits();

-- ---------- 3. Admin-only Reset workflow ----------
-- Unlocks, clears both approval chains, sets status pending, bumps version,
-- logs verb 'reset' with the reason. pdf_emailed_at is cleared deliberately so
-- a corrected sheet emails again after re-approval — the timesheet_sends
-- ledger keeps the full history of what was actually sent.
create or replace function public.reset_timesheet_workflow(p_header_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid;
  v_admin_name text;
  v_before jsonb;
  v_client_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select w.id, w.name into v_admin_id, v_admin_name
    from public.workers w
   where lower(w.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
     and w.archived_at is null
     and w.access_level = 'admin';
  if v_admin_id is null then
    raise exception 'Admins only';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to reset a timesheet workflow';
  end if;

  select jsonb_build_object(
           'status', h.status, 'locked', h.locked, 'version', h.version,
           'approved_by', h.approved_by, 'approved_at', h.approved_at,
           'client_approved', h.client_approved, 'client_approved_by', h.client_approved_by,
           'client_approved_at', h.client_approved_at, 'pdf_emailed_at', h.pdf_emailed_at)
    into v_before
    from public.timesheet_headers h where h.id = p_header_id;
  if v_before is null then
    raise exception 'Timesheet not found';
  end if;

  select c.id into v_client_id
    from public.clients c, public.timesheet_headers h
   where h.id = p_header_id and lower(c.name) = lower(coalesce(h.client, ''))
   order by c.created_at limit 1;

  -- One statement: locked flips to false in the same row image, so
  -- block_locked_edits lets the whole clear-down through.
  update public.timesheet_headers set
    locked = false,
    status = 'pending',
    version = coalesce(version, 1) + 1,
    approved_by = null, approved_at = null,
    client_approved = false, client_approved_by = null, client_approved_at = null,
    pdf_emailed_at = null
  where id = p_header_id;

  -- Lines follow (the header is already unlocked by now).
  update public.timesheets set
    status = 'pending', approved_by = null, approved_at = null, client_approved = false
  where header_id = p_header_id;

  insert into public.activity_events (actor_id, actor_name, verb, object_type, object_id, client_id, before, after)
  values (v_admin_id, v_admin_name, 'reset', 'timesheet_header', p_header_id, v_client_id, v_before,
          jsonb_build_object('status', 'pending', 'locked', false, 'reason', btrim(p_reason)));
end $$;

revoke all on function public.reset_timesheet_workflow(uuid, text) from public;
revoke all on function public.reset_timesheet_workflow(uuid, text) from anon;
grant execute on function public.reset_timesheet_workflow(uuid, text) to authenticated;

-- ---------- 4. Storage read policy for the Sent Timesheets screen ----------
-- The bucket is private; the admin screen mints signed URLs client-side, which
-- needs SELECT on storage.objects for staff. Without this, "Open PDF" fails.
do $$ begin
  create policy "staff read timesheet pdfs" on storage.objects
    for select to authenticated
    using (bucket_id = 'timesheet-pdfs' and public.is_cbd_staff());
exception when duplicate_object then null; end $$;

-- ---------- 5. NOTE FOR CENTRAL (cannot be done from this lane) ----------
-- Locking must happen WHERE APPROVAL HAPPENS. The new approve-timesheet edge
-- function sets locked=true on its path, and send-timesheet-pdf now locks any
-- approved header it touches as a backstop — but the token path itself should
-- lock atomically. Please add to approve_timesheet_via_token(p_token, p_approver)
-- and to auto_approve_stale_timesheets():
--     update public.timesheet_headers set ..., locked = true where ...;
-- (both run before this migration's trigger can interfere: flipping locked
-- true alongside status is in the allowed column set).
