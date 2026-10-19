-- 2026-10-19 — Allocation sprint (agent `allocation`). Additive only.
--   1. role_required_tickets  — which tickets a role needs (office read, admin write)
--   2. allocations.series_id  — repeating allocations ("repeats · 1 of 6")
--   3. shift_swap_requests    — worker "can't make it" → office approves / declines
--   4. list_swap_candidates() — names-only list of active workers a worker can suggest

-- ── 1. Required tickets per role ───────────────────────────────────────────
create table if not exists public.role_required_tickets (
  id          uuid primary key default gen_random_uuid(),
  role_name   text not null,          -- a role from src/constants/roles.js, or '*' = every role
  ticket_name text not null,
  required    boolean not null default true,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists role_required_tickets_live_uq
  on public.role_required_tickets (lower(role_name), lower(ticket_name))
  where archived_at is null;

alter table public.role_required_tickets enable row level security;
drop policy if exists "role_required_tickets office read" on public.role_required_tickets;
create policy "role_required_tickets office read" on public.role_required_tickets
  for select to authenticated using (public.is_office_user());
drop policy if exists "role_required_tickets admin write" on public.role_required_tickets;
create policy "role_required_tickets admin write" on public.role_required_tickets
  for all to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());
grant select, insert, update, delete on public.role_required_tickets to authenticated;

-- NSW defaults. '*' = every role. Names are matched case-insensitively against
-- the worker's certifications / worker_certificates rows ("contains" + keyword).
insert into public.role_required_tickets (role_name, ticket_name) values
  ('*', 'White Card'),
  ('Operator - Excavator',      'Excavator ticket'),
  ('Operator - Dozer',          'Dozer ticket'),
  ('Operator - Backhoe',        'Backhoe ticket'),
  ('Operator - Grader',         'Grader ticket'),
  ('Operator - Compactor',      'Roller ticket'),
  ('Operator - Wheeled Loader', 'Loader ticket'),
  ('Operator - Scrapper',       'Scraper ticket'),
  ('Dogman',                    'Dogging ticket'),
  ('Boomlift Operator (EWP - Over 11m)',           'EWP ticket'),
  ('Skilled Labourer - Boomlift (BL - Under 11m)', 'EWP ticket'),
  ('Skilled Labourer - Scissorlift',               'EWP ticket'),
  ('Skilled Labourer - Roller',                    'Roller ticket'),
  ('Skilled Labourer - Articulated Haul Truck',    'Haul truck ticket'),
  ('Skilled Labourer - Front Tipping Dumper',      'Dumper ticket'),
  ('Skilled Labourer - Asbestos Awareness (High Risk)', 'Asbestos awareness'),
  ('Skilled Labourer - Confined Spaces (High Risk)',    'Confined space'),
  ('Traffic Controller',        'Traffic control ticket')
on conflict do nothing;

-- ── 2. Repeating allocations ───────────────────────────────────────────────
alter table public.allocations add column if not exists series_id uuid;
create index if not exists allocations_series_id_idx on public.allocations (series_id) where series_id is not null;

-- ── 3. Shift swap / replacement requests ──────────────────────────────────
create table if not exists public.shift_swap_requests (
  id              uuid primary key default gen_random_uuid(),
  allocation_id   uuid not null references public.allocations(id) on delete cascade,
  from_worker_id  uuid not null references public.workers(id) on delete cascade,
  to_worker_id    uuid references public.workers(id) on delete set null,   -- "suggest a mate", optional
  reason          text,
  status          text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  decision_note   text,
  decided_by      uuid references public.workers(id) on delete set null,
  decided_by_name text,
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists shift_swap_requests_status_idx on public.shift_swap_requests (status, created_at desc);
create index if not exists shift_swap_requests_alloc_idx  on public.shift_swap_requests (allocation_id);

alter table public.shift_swap_requests enable row level security;
-- worker: own rows; office: everything
drop policy if exists "swap select own or office" on public.shift_swap_requests;
create policy "swap select own or office" on public.shift_swap_requests
  for select to authenticated
  using (public.is_office_user() or from_worker_id = public.current_worker_id());
-- worker may only open a request for an allocation that is theirs
drop policy if exists "swap insert own allocation" on public.shift_swap_requests;
create policy "swap insert own allocation" on public.shift_swap_requests
  for insert to authenticated
  with check (
    public.is_office_user()
    or (
      from_worker_id = public.current_worker_id()
      and exists (select 1 from public.allocations a
                  where a.id = allocation_id and a.worker_id = public.current_worker_id())
    )
  );
-- office decides; a worker may only withdraw their own pending request
drop policy if exists "swap update office or withdraw own" on public.shift_swap_requests;
create policy "swap update office or withdraw own" on public.shift_swap_requests
  for update to authenticated
  using (public.is_office_user() or (from_worker_id = public.current_worker_id() and status = 'pending'))
  with check (public.is_office_user() or (from_worker_id = public.current_worker_id() and status = 'cancelled'));
grant select, insert, update on public.shift_swap_requests to authenticated;

-- ── 4. Names-only candidate list for "suggest a mate" ─────────────────────
-- Workers cannot read other workers' rows (RLS lockdown), so the picker goes
-- through this definer function: id + name of active workers, nothing else.
create or replace function public.list_swap_candidates()
returns table (id uuid, name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.id, w.name
  from public.workers w
  where w.archived_at is null
    and w.role = 'worker'
    and coalesce(w.app_status, '') = 'Active'
    and w.id <> coalesce(public.current_worker_id(), '00000000-0000-0000-0000-000000000000'::uuid)
    and public.current_worker_id() is not null
  order by w.name;
$$;
revoke all on function public.list_swap_candidates() from public;
grant execute on function public.list_swap_candidates() to authenticated;
