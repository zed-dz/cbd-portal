-- 2026-10-15 — Multi-worker allocations with positions ("first N to accept get
-- the job, the rest see Position filled"), an Allocation Board notes table,
-- and tighter RLS on allocations (workers read their own rows and respond only
-- through the respond_to_allocation RPC; office users keep full access).
-- Additive: no existing rows change.

-- Office user = anyone who lands in the admin portal (workers.role = 'admin'),
-- including managers/allocators who are not finance admins (access_level).
create or replace function public.is_office_user()
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.workers w
    where lower(w.email) = lower((select auth.jwt() ->> 'email'))
      and w.role = 'admin' and w.archived_at is null
  );
$$;
revoke all on function public.is_office_user() from public;
grant execute on function public.is_office_user() to authenticated;

-- One group per "send to many" allocation. positions = how many are needed.
create table if not exists public.allocation_groups (
  id          uuid primary key default gen_random_uuid(),
  positions   integer not null default 1 check (positions >= 1),
  client      text,
  site        text,
  role        text,
  start_date  date,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  filled_at   timestamptz
);
alter table public.allocation_groups enable row level security;

-- Link column first: the worker-read policy below refers to it.
alter table public.allocations add column if not exists group_id uuid references public.allocation_groups(id);
create index if not exists allocations_group_id_idx on public.allocations(group_id);

drop policy if exists "allocation_groups office all" on public.allocation_groups;
create policy "allocation_groups office all" on public.allocation_groups
  for all to authenticated
  using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "allocation_groups worker read own" on public.allocation_groups;
create policy "allocation_groups worker read own" on public.allocation_groups
  for select to authenticated
  using (exists (
    select 1 from public.allocations a
    where a.group_id = allocation_groups.id and a.worker_id = public.current_worker_id()
  ));
grant select, insert, update on public.allocation_groups to authenticated;

-- Allocations RLS: office users everything; workers read their own rows only.
-- Worker accept/decline goes through respond_to_allocation() below.
drop policy if exists "Auth users full access" on public.allocations;
drop policy if exists "allocations office all" on public.allocations;
create policy "allocations office all" on public.allocations
  for all to authenticated
  using (public.is_office_user()) with check (public.is_office_user());
drop policy if exists "allocations worker read own" on public.allocations;
create policy "allocations worker read own" on public.allocations
  for select to authenticated
  using (worker_id = public.current_worker_id());

-- Worker response. Atomic: the group row is locked so two workers tapping
-- Accept in the same second are served one after the other.
create or replace function public.respond_to_allocation(p_allocation_id uuid, p_decision text)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_me        uuid := public.current_worker_id();
  v_me_name   text;
  v_a         public.allocations%rowtype;
  v_g         public.allocation_groups%rowtype;
  v_confirmed integer;
begin
  if v_me is null then
    raise exception 'Not signed in as a worker';
  end if;
  if p_decision not in ('accept', 'decline') then
    raise exception 'Decision must be accept or decline';
  end if;
  select name into v_me_name from public.workers where id = v_me;

  select * into v_a from public.allocations where id = p_allocation_id for update;
  if not found or v_a.worker_id <> v_me then
    raise exception 'Allocation not found';
  end if;

  if v_a.status <> 'pending' then
    return jsonb_build_object(
      'result', case when v_a.status = 'filled' then 'position_filled' else 'already_' || v_a.status end,
      'status', v_a.status);
  end if;

  if p_decision = 'decline' then
    update public.allocations set status = 'declined' where id = v_a.id;
    insert into public.activity_events(actor_id, actor_name, verb, object_type, object_id, client_id, site_id, after)
      values (v_me, v_me_name, 'declined', 'allocation', v_a.id, v_a.client_id, v_a.site_id,
              jsonb_build_object('client', v_a.client, 'site', v_a.site, 'start_date', v_a.start_date));
    return jsonb_build_object('result', 'declined', 'status', 'declined');
  end if;

  -- accept
  if v_a.group_id is null then
    update public.allocations set status = 'confirmed' where id = v_a.id;
    insert into public.activity_events(actor_id, actor_name, verb, object_type, object_id, client_id, site_id, after)
      values (v_me, v_me_name, 'accepted', 'allocation', v_a.id, v_a.client_id, v_a.site_id,
              jsonb_build_object('client', v_a.client, 'site', v_a.site, 'start_date', v_a.start_date));
    return jsonb_build_object('result', 'confirmed', 'status', 'confirmed');
  end if;

  select * into v_g from public.allocation_groups where id = v_a.group_id for update;
  select count(*) into v_confirmed from public.allocations where group_id = v_g.id and status = 'confirmed';

  if v_confirmed >= v_g.positions then
    update public.allocations set status = 'filled' where id = v_a.id;
    return jsonb_build_object('result', 'position_filled', 'status', 'filled',
                              'positions', v_g.positions, 'filled', v_confirmed);
  end if;

  update public.allocations set status = 'confirmed' where id = v_a.id;
  v_confirmed := v_confirmed + 1;
  insert into public.activity_events(actor_id, actor_name, verb, object_type, object_id, client_id, site_id, after)
    values (v_me, v_me_name, 'accepted', 'allocation', v_a.id, v_a.client_id, v_a.site_id,
            jsonb_build_object('client', v_a.client, 'site', v_a.site, 'start_date', v_a.start_date,
                               'positions', v_g.positions, 'filled', v_confirmed));

  if v_confirmed >= v_g.positions then
    update public.allocations set status = 'filled' where group_id = v_g.id and status = 'pending';
    update public.allocation_groups set filled_at = now() where id = v_g.id;
    insert into public.notifications(type, title, body, allocation_id, worker_id)
      values ('allocation_filled',
              'Position filled: ' || coalesce(v_g.client, v_g.site, 'job'),
              v_g.positions || ' of ' || v_g.positions || ' accepted'
                || coalesce(' · ' || v_g.role, '')
                || coalesce(' — ' || to_char(v_g.start_date, 'DD Mon'), ''),
              v_a.id, v_me);
  end if;

  return jsonb_build_object('result', 'confirmed', 'status', 'confirmed',
                            'positions', v_g.positions, 'filled', v_confirmed);
end;
$$;
revoke all on function public.respond_to_allocation(uuid, text) from public;
grant execute on function public.respond_to_allocation(uuid, text) to authenticated;

-- "Notes for the week" box on the Allocation Board.
create table if not exists public.allocation_board_notes (
  week_start  date primary key,
  notes       text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.allocation_board_notes enable row level security;
drop policy if exists "allocation_board_notes office all" on public.allocation_board_notes;
create policy "allocation_board_notes office all" on public.allocation_board_notes
  for all to authenticated
  using (public.is_office_user()) with check (public.is_office_user());
grant select, insert, update on public.allocation_board_notes to authenticated;
