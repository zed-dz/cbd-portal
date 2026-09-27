-- =====================================================================
-- CBD Portal — target data model (Supabase / Postgres)
-- ADDITIVE ONLY. Existing tables seen in the live portal:
--   workers, notifications, timesheets, timesheet_headers, certifications,
--   allocations, worker_applications, clients, client_jobs, client_sites,
--   client_site_contacts, job_roles, payroll_config
-- Claude Code: inspect the real columns first (list_tables), then map these
-- ideas onto what exists. Do NOT drop or rename live columns.
-- =====================================================================

-- ---------- 0. Roles ----------
-- app_role on the user profile. Used by RLS below.
-- 'admin'      : everything
-- 'accounts'   : rates, payroll, invoices, send logs
-- 'supervisor' : approve timesheets for their clients/sites (no rates)
-- 'allocator'  : create allocations (NO rates)
-- 'worker'     : own allocations + own timesheets
do $$ begin
  create type app_role as enum ('admin','accounts','supervisor','allocator','worker');
exception when duplicate_object then null; end $$;

-- ---------- 1. Master lists (the Dashpivot "List Library") ----------
alter table clients
  add column if not exists archived_at timestamptz,
  add column if not exists timesheet_email text,          -- where approved PDFs go (Phase 2)
  add column if not exists timesheet_cc text,
  add column if not exists award_profile text default 'B'; -- which hour rules: 'A' | 'B' | 'C' | 'PORTAL' (see 03-TIMESHEET-LOGIC.md)

-- Sites = Dashpivot "Project" list, but LINKED to the client (Dashpivot's weak spot)
alter table client_sites
  add column if not exists client_id uuid references clients(id),
  add column if not exists name text,
  add column if not exists address text,
  add column if not exists map_url text,                   -- pasted Google/Apple maps link (Phase 1)
  add column if not exists lat numeric, add column if not exists lng numeric,
  add column if not exists po_number text,
  add column if not exists archived_at timestamptz,
  add column if not exists created_by uuid;
create unique index if not exists client_sites_client_name_uq
  on client_sites (client_id, lower(name)) where archived_at is null;

alter table job_roles
  add column if not exists archived_at timestamptz,
  add column if not exists sort_order int default 0;

-- ---------- 2. Workers ----------
alter table workers
  add column if not exists employment_type text check (employment_type in ('full_time','part_time','casual')) default 'casual';

-- ---------- 3. Allocations ----------
alter table allocations
  add column if not exists client_id uuid references clients(id),
  add column if not exists site_id uuid references client_sites(id),
  add column if not exists role_id uuid references job_roles(id),
  add column if not exists is_training boolean default false,
  add column if not exists map_url_override text;          -- if this job's pin differs from the site's

-- ---------- 4. Timesheets (one row per shift) ----------
alter table timesheets
  add column if not exists client_id uuid references clients(id),
  add column if not exists site_id uuid references client_sites(id),
  add column if not exists role_id uuid references job_roles(id),
  add column if not exists allocation_id uuid references allocations(id),
  add column if not exists client_name_snapshot text,     -- keep what was true on the day
  add column if not exists site_name_snapshot text,
  add column if not exists role_name_snapshot text,
  add column if not exists day_type text default 'Regular Work',
  add column if not exists shift_type text,
  add column if not exists break_hours numeric(4,2),
  add column if not exists total_hours numeric(5,2),
  add column if not exists regular_hours numeric(5,2),
  add column if not exists ot15_hours numeric(5,2),
  add column if not exists ot20_hours numeric(5,2),
  add column if not exists meal_allowance smallint default 0,
  add column if not exists travel_allowance smallint default 0,
  add column if not exists is_training boolean default false,
  add column if not exists pay_worker boolean,             -- training rule result
  add column if not exists bill_client boolean,            -- training rule result (always false for training)
  add column if not exists client_signer_name text,
  add column if not exists client_signer_company text,
  add column if not exists client_signature_path text,
  add column if not exists client_signed_at timestamptz,
  add column if not exists worker_signed_at timestamptz,
  add column if not exists workflow_step text default 'submitted'
      check (workflow_step in ('draft','submitted','approved','sent','rejected')),
  add column if not exists approved_by uuid,
  add column if not exists approved_at timestamptz,
  add column if not exists locked boolean default false,   -- true after approve; only 'reset' unlocks
  add column if not exists version int default 1,
  add column if not exists pdf_path text;

-- Training rule (Phase 1): full-timers paid, casuals unpaid, client never charged
create or replace function apply_training_rule() returns trigger language plpgsql as $$
begin
  if new.is_training then
    new.bill_client := false;
    new.pay_worker := coalesce((select employment_type in ('full_time','part_time') from workers w where w.id = new.worker_id), false);
  else
    new.bill_client := coalesce(new.bill_client, true);
    new.pay_worker := coalesce(new.pay_worker, true);
  end if;
  return new;
end $$;
drop trigger if exists trg_training_rule on timesheets;
create trigger trg_training_rule before insert or update on timesheets
  for each row execute function apply_training_rule();

-- Lock rule: an approved timesheet cannot change unless it is reset first
create or replace function block_locked_edits() returns trigger language plpgsql as $$
begin
  if old.locked and new.locked and (to_jsonb(new) - 'updated_at' - 'workflow_step' - 'pdf_path') <> (to_jsonb(old) - 'updated_at' - 'workflow_step' - 'pdf_path') then
    raise exception 'Timesheet is approved and locked. Use Reset Workflow to edit.';
  end if;
  return new;
end $$;
drop trigger if exists trg_block_locked on timesheets;
create trigger trg_block_locked before update on timesheets
  for each row execute function block_locked_edits();

-- ---------- 5. Audit + activity (Dashpivot activity feed + form history) ----------
create table if not exists activity_events (
  id bigserial primary key,
  actor_id uuid,
  actor_name text,
  verb text not null,           -- created | edited | signed_client | submitted | approved | rejected | reset | sent | send_failed | notified_accounts
  object_type text not null,    -- timesheet | allocation | client | site | rate_set ...
  object_id uuid not null,
  client_id uuid, site_id uuid,
  before jsonb, after jsonb,
  created_at timestamptz default now()
);
create index if not exists activity_events_obj on activity_events (object_type, object_id, created_at desc);
create index if not exists activity_events_client on activity_events (client_id, created_at desc);

-- ---------- 6. Phase 2: email send log ----------
create table if not exists timesheet_sends (
  id uuid primary key default gen_random_uuid(),
  timesheet_ids uuid[] not null,
  client_id uuid references clients(id),
  to_emails text[] not null,
  cc_emails text[],
  from_email text not null,      -- e.g. timesheets@cbdpnl.com.au
  subject text not null,
  pdf_path text not null,        -- storage path of the exact PDF sent
  pdf_sha256 text,
  provider text default 'resend',
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  error text,
  idempotency_key text unique,   -- e.g. 'approve:<timesheet_id>:v<version>'
  sent_by uuid,
  created_at timestamptz default now(),
  sent_at timestamptz
);

-- ---------- 7. Phase 3: Clients → Projects → Rates ----------
create table if not exists rate_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,            -- e.g. "Civil 2026 Standard"
  notes text,
  archived_at timestamptz,
  created_at timestamptz default now()
);
create table if not exists rate_set_lines (
  id uuid primary key default gen_random_uuid(),
  rate_set_id uuid not null references rate_sets(id) on delete cascade,
  role_id uuid not null references job_roles(id),
  charge_normal numeric(8,2), charge_ot15 numeric(8,2), charge_ot20 numeric(8,2),
  pay_normal numeric(8,2),    pay_ot15 numeric(8,2),    pay_ot20 numeric(8,2),
  unique (rate_set_id, role_id)
);
create table if not exists client_rate_assignments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  site_id uuid references client_sites(id),     -- null = whole client; set = override for one project/site
  rate_set_id uuid not null references rate_sets(id),
  effective_from date not null default current_date,
  effective_to date,
  created_by uuid, created_at timestamptz default now()
);
-- Rate lookup for a shift: most specific (site) first, then client, by date.
create or replace view v_effective_rates as
select a.client_id, a.site_id, a.effective_from, a.effective_to, l.*
from client_rate_assignments a join rate_set_lines l on l.rate_set_id = a.rate_set_id;

-- ---------- 8. "Notify accounts" (allocators never see rates) ----------
create table if not exists accounts_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'rate_check', -- rate_check | new_client | new_site | other
  allocation_id uuid references allocations(id),
  client_id uuid, site_id uuid, role_id uuid,
  message text,
  created_by uuid, created_at timestamptz default now(),
  resolved_by uuid, resolved_at timestamptz
);

-- ---------- 9. RLS sketch ----------
-- helper: current user's role (adapt to where the portal stores roles today)
-- create or replace function current_app_role() returns app_role language sql stable as
--   $$ select role from profiles where id = auth.uid() $$;
alter table rate_sets enable row level security;
alter table rate_set_lines enable row level security;
alter table client_rate_assignments enable row level security;
alter table timesheet_sends enable row level security;
-- create policy rates_read on rate_set_lines for select using (current_app_role() in ('admin','accounts'));
-- create policy rates_write on rate_set_lines for all using (current_app_role() in ('admin','accounts'));
-- (same for rate_sets, client_rate_assignments, timesheet_sends)
-- IMPORTANT: also stop leaking rates through existing tables/views (clients.default_rate_*, client_jobs rates, payroll views).
-- Expose to allocators only a view WITHOUT money columns.
