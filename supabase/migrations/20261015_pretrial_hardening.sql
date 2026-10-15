-- 2026-10-15 — Pre-trial hardening (from the Track B security audit).
-- Additive: policies/grants only; no data changes. Requires is_office_user()
-- and current_worker_id() (both exist). Run after 20261015_allocation_positions.sql.

-- ─── P0: v_workers_admin was writable by anon + authenticated (definer view) ──
revoke insert, update, delete, truncate, references, trigger on public.v_workers_admin from anon, authenticated;
revoke select on public.v_workers_admin from anon;

-- ─── P1: timesheets + headers — workers see/edit ONLY their own, never approve/unlock
drop policy if exists "Auth users full access" on public.timesheet_headers;
drop policy if exists "timesheet_headers office all" on public.timesheet_headers;
create policy "timesheet_headers office all" on public.timesheet_headers
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "timesheet_headers worker select own" on public.timesheet_headers;
create policy "timesheet_headers worker select own" on public.timesheet_headers
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "timesheet_headers worker insert own" on public.timesheet_headers;
create policy "timesheet_headers worker insert own" on public.timesheet_headers
  for insert to authenticated
  with check (worker_id = public.current_worker_id()
              and coalesce(status, 'pending') <> 'approved' and coalesce(locked, false) = false);
drop policy if exists "timesheet_headers worker update own" on public.timesheet_headers;
create policy "timesheet_headers worker update own" on public.timesheet_headers
  for update to authenticated
  using (worker_id = public.current_worker_id() and coalesce(locked, false) = false and coalesce(status, 'pending') <> 'approved')
  with check (worker_id = public.current_worker_id()
              and coalesce(status, 'pending') <> 'approved' and coalesce(locked, false) = false);

drop policy if exists "Auth users full access" on public.timesheets;
drop policy if exists "timesheets office all" on public.timesheets;
create policy "timesheets office all" on public.timesheets
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "timesheets worker select own" on public.timesheets;
create policy "timesheets worker select own" on public.timesheets
  for select to authenticated using (worker_id = public.current_worker_id());
drop policy if exists "timesheets worker insert own" on public.timesheets;
create policy "timesheets worker insert own" on public.timesheets
  for insert to authenticated
  with check (worker_id = public.current_worker_id() and coalesce(status, 'pending') <> 'approved');
drop policy if exists "timesheets worker update own" on public.timesheets;
create policy "timesheets worker update own" on public.timesheets
  for update to authenticated
  using (worker_id = public.current_worker_id() and coalesce(status, 'pending') <> 'approved')
  with check (worker_id = public.current_worker_id() and coalesce(status, 'pending') <> 'approved');
drop policy if exists "timesheets worker delete own pending" on public.timesheets;
create policy "timesheets worker delete own pending" on public.timesheets
  for delete to authenticated
  using (worker_id = public.current_worker_id() and coalesce(status, 'pending') = 'pending');

-- Lock trigger: only an admin (Reset workflow) may flip locked true→false.
-- Service-role/cron calls (auth.uid() null) are unaffected.
create or replace function public.block_locked_edits()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
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
    if coalesce(old.locked, false) and not coalesce(new.locked, false)
       and auth.uid() is not null and not public.is_portal_admin() then
      raise exception 'Only an admin can unlock an approved timesheet (Reset workflow).';
    end if;
    if coalesce(old.locked, false) and coalesce(new.locked, false)
       and (to_jsonb(new) - 'locked' - 'status' - 'version' - 'pdf_emailed_at' - 'pdf_emailed_to' - 'updated_at'
                          - 'client_approved' - 'client_approved_at' - 'client_approved_by'
                          - 'client_approval_sent_at' - 'client_approval_sent_to'
                          - 'approved_by' - 'approved_at' - 'disputed_at' - 'disputed_note')
        <> (to_jsonb(old) - 'locked' - 'status' - 'version' - 'pdf_emailed_at' - 'pdf_emailed_to' - 'updated_at'
                          - 'client_approved' - 'client_approved_at' - 'client_approved_by'
                          - 'client_approval_sent_at' - 'client_approval_sent_to'
                          - 'approved_by' - 'approved_at' - 'disputed_at' - 'disputed_note') then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  end if;

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
       and (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'client_approved' - 'xero_exported'
                          - 'processed_at' - 'processed_by')
        <> (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'client_approved' - 'xero_exported'
                          - 'processed_at' - 'processed_by') then
      raise exception 'Timesheet is approved and locked. Use Reset workflow to edit.';
    end if;
    return new;
  end if;
end $$;

-- save_daily_timesheet: a worker may only save their OWN sheet, never as approved,
-- and only a header that is theirs. Office users unchanged.
create or replace function public.save_daily_timesheet(p_header_id uuid, p_worker_id uuid, p_client text, p_project text, p_role text, p_wet_hire boolean, p_comments text, p_client_signature text, p_allowance_lines jsonb, p_status text, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_header_id uuid;
  v_line jsonb;
  v_total_hours numeric := 0;
  v_total_regular numeric := 0;
  v_total_meal numeric := 0;
  v_alw jsonb;
  v_is_admin boolean := false;
  v_is_office boolean := false;
  v_admin_name text;
  v_worker_type text;
  v_profile text;
  v_old jsonb := '{}'::jsonb;
  v_snap jsonb;
  v_total numeric; v_regular numeric; v_ot numeric; v_rdo numeric;
  v_ot15 numeric; v_ot2x numeric;
  v_scenario text;
  v_start timestamptz; v_end timestamptz; v_break int;
  v_orig_start timestamptz; v_orig_end timestamptz; v_orig_break int;
  v_adj_by text; v_adj_at timestamptz;
  v_date date; v_shift text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select (w.access_level = 'admin'), (w.role = 'admin'), w.name into v_is_admin, v_is_office, v_admin_name
  from public.workers w where lower(w.email) = lower((select u.email from auth.users u where u.id = auth.uid())) and w.archived_at is null;
  v_is_admin := coalesce(v_is_admin, false);
  v_is_office := coalesce(v_is_office, false);

  if not v_is_office then
    if p_worker_id is distinct from public.current_worker_id() then
      raise exception 'You can only save your own timesheet';
    end if;
    if coalesce(p_status, 'pending') = 'approved' then
      raise exception 'Only the office can approve a timesheet';
    end if;
    if p_header_id is not null and not exists (
      select 1 from public.timesheet_headers h where h.id = p_header_id and h.worker_id = p_worker_id
    ) then
      raise exception 'Timesheet not found';
    end if;
  end if;

  select w.worker_type into v_worker_type from public.workers w where w.id = p_worker_id;

  select c.award_profile into v_profile
  from public.clients c where lower(c.name) = lower(coalesce(p_client, ''))
  order by c.created_at limit 1;

  for v_alw in select * from jsonb_array_elements(coalesce(p_allowance_lines, '[]'::jsonb))
  loop
    v_total_meal := v_total_meal + coalesce((v_alw->>'meal_allowance')::numeric, 0);
  end loop;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_total_hours := v_total_hours + coalesce((v_line->>'total_hours')::numeric, 0);
  end loop;

  if p_header_id is null then
    insert into public.timesheet_headers
      (worker_id, client, project, role, wet_hire, comments, client_signature,
       allowance_lines, total_hours, total_regular_hours, total_meal_allowance, status)
    values
      (p_worker_id, p_client, p_project, p_role, coalesce(p_wet_hire,false), p_comments, p_client_signature,
       coalesce(p_allowance_lines,'[]'::jsonb), v_total_hours, v_total_regular, v_total_meal, coalesce(p_status,'pending'))
    returning id into v_header_id;
  else
    v_header_id := p_header_id;
    update public.timesheet_headers set
      worker_id = p_worker_id, client = p_client, project = p_project, role = p_role,
      wet_hire = coalesce(p_wet_hire,false), comments = p_comments, client_signature = p_client_signature,
      allowance_lines = coalesce(p_allowance_lines,'[]'::jsonb),
      total_hours = v_total_hours, total_regular_hours = v_total_regular,
      total_meal_allowance = v_total_meal, status = coalesce(p_status,status),
      updated_at = now()
    where id = v_header_id;

    select coalesce(jsonb_object_agg(t.date::text, jsonb_build_object(
      'orig_start', coalesce(t.original_start_time,    t.start_time),
      'orig_end',   coalesce(t.original_end_time,      t.end_time),
      'orig_break', coalesce(t.original_break_minutes, t.break_minutes),
      'adj_by', t.adjusted_by, 'adj_at', t.adjusted_at
    )), '{}'::jsonb) into v_old
    from public.timesheets t where t.header_id = v_header_id;
  end if;

  delete from public.timesheets where header_id = v_header_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_total    := coalesce((v_line->>'total_hours')::numeric, 0);
    v_scenario := coalesce(nullif(v_line->>'scenario',''),'standard');
    v_date     := nullif(v_line->>'date','')::date;
    v_shift    := nullif(v_line->>'shift_type','');
    v_start    := nullif(v_line->>'start_time','')::timestamptz;
    v_end      := nullif(v_line->>'end_time','')::timestamptz;
    v_break    := round(coalesce((v_line->>'total_break_hours')::numeric,0) * 60)::int;

    select s.ordinary, s.rdo, s.ot15, s.ot2x
      into v_regular, v_rdo, v_ot15, v_ot2x
      from public.split_shift_hours_v2(
        v_total, v_worker_type, v_date, v_shift, v_scenario,
        v_profile, v_start, v_end,
        coalesce((v_line->>'total_break_hours')::numeric, 0)) s;

    v_ot := v_ot15 + v_ot2x;
    v_total_regular := v_total_regular + coalesce(v_regular, 0);

    v_snap := v_old->(v_line->>'date');

    if v_snap is not null then
      v_orig_start := (v_snap->>'orig_start')::timestamptz;
      v_orig_end   := (v_snap->>'orig_end')::timestamptz;
      v_orig_break := (v_snap->>'orig_break')::int;
      v_adj_by     := v_snap->>'adj_by';
      v_adj_at     := (v_snap->>'adj_at')::timestamptz;
      if v_is_admin and (v_start is distinct from v_orig_start
                      or v_end   is distinct from v_orig_end
                      or v_break is distinct from v_orig_break) then
        v_adj_by := coalesce(v_admin_name, 'Admin');
        v_adj_at := now();
      end if;
    else
      v_orig_start := v_start; v_orig_end := v_end; v_orig_break := v_break;
      v_adj_by := null; v_adj_at := null;
    end if;

    insert into public.timesheets
      (header_id, worker_id, client, project, role, date, scenario,
       start_time, end_time, break_minutes, total_break_hours, shift_type,
       total_hours, regular_hours, hours, pay_hours, charge_hours,
       overtime_hours, ot15_hours, ot2x_hours, rdo_hours, is_night_shift,
       meal_allowance, status, notes,
       original_start_time, original_end_time, original_break_minutes,
       adjusted_by, adjusted_at)
    values
      (v_header_id, p_worker_id, p_client, p_project, p_role,
       v_date, v_scenario,
       v_start, v_end, v_break,
       coalesce((v_line->>'total_break_hours')::numeric,0),
       v_shift,
       v_total, v_regular,
       v_total, v_total, v_total,
       v_ot, v_ot15, v_ot2x, v_rdo,
       (coalesce(v_shift,'Day') = 'Night'),
       coalesce((v_line->>'meal_allowance')::numeric,0),
       coalesce(p_status,'pending'),
       nullif(v_line->>'notes',''),
       v_orig_start, v_orig_end, v_orig_break, v_adj_by, v_adj_at);
  end loop;

  update public.timesheet_headers
     set total_regular_hours = v_total_regular
   where id = v_header_id;

  return v_header_id;
end;
$$;
revoke execute on function public.save_daily_timesheet(uuid, uuid, text, text, text, boolean, text, text, jsonb, text, jsonb) from anon, public;
grant execute on function public.save_daily_timesheet(uuid, uuid, text, text, text, boolean, text, text, jsonb, text, jsonb) to authenticated;

-- ─── P1: activity_events — append-only; workers see their own rows, office sees all
drop policy if exists "activity_events_auth" on public.activity_events;
drop policy if exists "activity_events select" on public.activity_events;
create policy "activity_events select" on public.activity_events
  for select to authenticated
  using (public.is_office_user() or actor_id = auth.uid() or actor_id = public.current_worker_id());
drop policy if exists "activity_events insert" on public.activity_events;
create policy "activity_events insert" on public.activity_events
  for insert to authenticated
  with check (public.is_office_user() or actor_id = auth.uid() or actor_id = public.current_worker_id());
-- (no update / delete policy on purpose)

-- ─── P1: money tables → admin only
drop policy if exists "Auth users full access" on public.default_rate_card;
drop policy if exists "default_rate_card admin all" on public.default_rate_card;
create policy "default_rate_card admin all" on public.default_rate_card
  for all to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());

-- ─── P1: office-only tables (inbox, SMS log, applicants, client contacts, templates)
drop policy if exists "Auth users email messages" on public.email_messages;
create policy "email_messages office all" on public.email_messages
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "Auth users email threads" on public.email_threads;
create policy "email_threads office all" on public.email_threads
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "Auth users email templates" on public.email_templates;
create policy "email_templates office all" on public.email_templates
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "Auth users insert message log" on public.message_log;
drop policy if exists "Auth users read message log" on public.message_log;
create policy "message_log office all" on public.message_log
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "Auth users full access" on public.worker_applications;
create policy "worker_applications office all" on public.worker_applications
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
-- Site contacts: everyone may read (the worker's own timesheet needs the
-- supervisor to send the sign-off link); only the office writes.
drop policy if exists "Auth users full access" on public.client_site_contacts;
create policy "client_site_contacts read" on public.client_site_contacts
  for select to authenticated using (true);
create policy "client_site_contacts office write" on public.client_site_contacts
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());

-- own-or-office tables
drop policy if exists "Auth users full access" on public.take5;
create policy "take5 own or office" on public.take5
  for all to authenticated
  using (public.is_office_user() or worker_id = public.current_worker_id())
  with check (public.is_office_user() or worker_id = public.current_worker_id());
drop policy if exists "Auth users full access" on public.certifications;
create policy "certifications office all" on public.certifications
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
create policy "certifications worker read own" on public.certifications
  for select to authenticated using (worker_id = public.current_worker_id());

-- reference tables: everyone reads, office writes
drop policy if exists "Auth users full access" on public.client_sites;
create policy "client_sites read" on public.client_sites for select to authenticated using (true);
create policy "client_sites office write" on public.client_sites
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "Auth users full access" on public.client_jobs;
create policy "client_jobs read" on public.client_jobs for select to authenticated using (true);
create policy "client_jobs office write" on public.client_jobs
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "Auth users full access" on public.job_roles;
create policy "job_roles read" on public.job_roles for select to authenticated using (true);
create policy "job_roles office write" on public.job_roles
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());

-- ─── P1/P2: definer functions callable by anyone
revoke execute on function public.apply_default_rate_card_to_client(uuid, boolean) from anon, public;
create or replace function public.apply_default_rate_card_to_client(p_client_id uuid, p_replace boolean default false)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_inserted integer := 0;
begin
  if not public.is_portal_admin() then
    raise exception 'Admins only';
  end if;
  if p_client_id is null then return 0; end if;

  if p_replace then
    delete from client_rate_cards where client_id = p_client_id;
  end if;

  insert into client_rate_cards (client_id, role_name, rate_a, rate_b, rate_c, notes, uom, category, sort_order)
  select p_client_id, d.role_name, d.rate_a, d.rate_b, d.rate_c, d.notes, d.uom, d.category, d.sort_order
  from default_rate_card d
  where not exists (
    select 1 from client_rate_cards c
    where c.client_id = p_client_id
      and lower(c.role_name) = lower(d.role_name)
  );

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke execute on function public.approve_application_to_worker(uuid, text) from anon, public;
create or replace function public.approve_application_to_worker(p_application_id uuid, p_reviewer text default null::text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_app    worker_applications%rowtype;
  v_worker_id uuid;
begin
  if auth.uid() is null then raise exception 'Must be signed in to approve applications'; end if;
  if not public.is_office_user() then raise exception 'Office staff only'; end if;
  select * into v_app from worker_applications where id = p_application_id;
  if not found then raise exception 'Application % not found', p_application_id; end if;
  if v_app.status = 'converted' then return v_app.converted_worker_id; end if;
  if v_app.type <> 'worker' then
    raise exception 'Only worker-type applications can be converted to workers (got %)', v_app.type;
  end if;
  select id into v_worker_id from workers where lower(email) = lower(v_app.email) limit 1;
  if v_worker_id is null then
    insert into workers (name, email, mobile, app_status, status)
    values (v_app.full_name, v_app.email, v_app.phone, 'Profile Incomplete', 'available')
    returning id into v_worker_id;
  end if;
  update worker_applications
  set status = 'converted', reviewed_at = now(),
      reviewed_by = coalesce(p_reviewer, reviewed_by), converted_worker_id = v_worker_id
  where id = p_application_id;
  return v_worker_id;
end $$;

-- Admin contact details: office only (workers notify admins through the
-- notify-admins edge function instead, so phones never see admin numbers).
create or replace function public.get_admin_notification_recipients()
returns table(name text, mobile text, email text, notify_mode text, notify_sms boolean, notify_email boolean, is_allocator boolean)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select w.name::text, w.mobile::text, w.email::text,
         coalesce(w.notify_mode, 'per_event')::text,
         w.notify_sms::boolean, w.notify_email::boolean,
         coalesce(w.is_allocator, false)::boolean
  from public.workers w
  where w.access_level = 'admin'
    and w.archived_at is null
    and public.is_office_user();
$$;

-- ─── P2: notifications — a worker may only insert rows about themselves
drop policy if exists "notifications_insert_authed" on public.notifications;
create policy "notifications insert" on public.notifications
  for insert to authenticated
  with check (public.is_office_user() or worker_id = public.current_worker_id());

-- ─── P2: never delete workers (archive instead)
drop policy if exists "workers_delete_staff" on public.workers;

-- ─── P2: Xero tokens — the UI only needs to know "connected until when"
do $$
declare c text;
begin
  for c in select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'xero_tokens'
             and column_name in ('access_token', 'refresh_token', 'id_token', 'token')
  loop
    execute format('revoke select (%I) on public.xero_tokens from authenticated', c);
  end loop;
end $$;

-- ─── P3: over-broad default grants
revoke execute on function public.auto_approve_stale_timesheets() from anon, public;
revoke execute on function public.current_worker_is_admin() from anon, public;
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net') then
    execute 'revoke execute on all functions in schema net from anon, authenticated';
  end if;
end $$;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- ─── Safety: client-side error reports (React error boundary + window.onerror)
create table if not exists public.client_errors (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  user_email  text,
  page        text,
  message     text,
  stack       text,
  url         text,
  user_agent  text,
  extra       jsonb
);
alter table public.client_errors enable row level security;
drop policy if exists "client_errors insert" on public.client_errors;
create policy "client_errors insert" on public.client_errors
  for insert to authenticated with check (true);
drop policy if exists "client_errors office read" on public.client_errors;
create policy "client_errors office read" on public.client_errors
  for select to authenticated using (public.is_office_user());
grant insert on public.client_errors to authenticated;
grant select on public.client_errors to authenticated;
grant usage, select on sequence public.client_errors_id_seq to authenticated;

-- ─── P3: FK indexes
create index if not exists clients_rate_set_id_idx on public.clients(rate_set_id);
create index if not exists rate_set_items_set_id_idx on public.rate_set_items(set_id);
create index if not exists worker_payments_worker_id_idx on public.worker_payments(worker_id);
create index if not exists timesheets_worker_date_idx on public.timesheets(worker_id, date);
create index if not exists allocations_worker_start_idx on public.allocations(worker_id, start_date);
