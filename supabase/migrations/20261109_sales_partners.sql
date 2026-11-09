-- Sales Partner module (2026-11-09).
-- External commission-only sales partners refer work, follow each referral's
-- status and see the commission they earned. Additive only: new tables, one
-- private bucket, helper functions, RLS, one weekly cron. Nothing existing
-- changes. Archive, never delete.
--
-- Roles
--   partner  = a signed-in auth user whose e-mail matches sales_partners.email
--              (status active|invited). Sees ONLY their own rows.
--   office   = public.is_office_user()  — reads all, moves statuses, notes.
--   money    = public.is_portal_admin() — placements, commission, bank details.

-- ── helpers ───────────────────────────────────────────────────────────────────
create table if not exists public.sales_partners (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          uuid,
  email                 text not null,
  name                  text not null,
  company               text,
  abn                   text,
  phone                 text,
  status                text not null default 'invited' check (status in ('active','invited','archived')),
  first_placement_bonus numeric(12,2) not null default 1000,
  residual_pct_y1       numeric(5,2)  not null default 10,
  residual_pct_y2       numeric(5,2)  not null default 5,
  notify_email          boolean not null default true,
  notify_sms            boolean not null default false,
  weekly_summary        boolean not null default false,
  profile_completed_at  timestamptz,
  invite_sent_at        timestamptz,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  archived_at           timestamptz,
  archived_reason       text
);
create unique index if not exists sales_partners_email_lower_idx on public.sales_partners (lower(email));

-- The signed-in partner's id (null for everyone else). Security definer so a
-- partner can resolve themselves before any policy on sales_partners applies.
create or replace function public.current_partner_id()
returns uuid
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select p.id from public.sales_partners p
  where lower(p.email) = lower((select auth.jwt() ->> 'email'))
    and p.status in ('active','invited')
    and p.archived_at is null
  limit 1;
$$;
revoke all on function public.current_partner_id() from public;
grant execute on function public.current_partner_id() to authenticated;

-- ── sales_partners RLS ────────────────────────────────────────────────────────
alter table public.sales_partners enable row level security;
drop policy if exists "sales_partners partner read own" on public.sales_partners;
create policy "sales_partners partner read own" on public.sales_partners
  for select to authenticated using (id = (select public.current_partner_id()));
drop policy if exists "sales_partners partner update own" on public.sales_partners;
create policy "sales_partners partner update own" on public.sales_partners
  for update to authenticated
  using (id = (select public.current_partner_id()))
  with check (id = (select public.current_partner_id()));
drop policy if exists "sales_partners office all" on public.sales_partners;
create policy "sales_partners office all" on public.sales_partners
  for all to authenticated
  using ((select public.is_office_user()))
  with check ((select public.is_office_user()));
grant select, insert, update on public.sales_partners to authenticated;

-- A partner may change contact + notification columns on their own row only.
-- Rates, status, e-mail and audit columns are office-only: a trigger refuses
-- the change when the caller is not office (column grants are role-wide and
-- the partner must still read their own rates).
create or replace function public.sales_partners_guard()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Service role / internal callers (partner-invite, notify-partner) have no JWT.
  if auth.uid() is null or (select public.is_office_user()) then return new; end if;
  if new.id is distinct from (select public.current_partner_id()) then
    raise exception 'not your partner record';
  end if;
  new.email := old.email;
  -- Finishing the profile flips an invited partner to active; nothing else moves status.
  if old.status = 'invited' and new.profile_completed_at is not null then new.status := 'active';
  else new.status := old.status; end if;
  new.auth_user_id := old.auth_user_id;
  new.first_placement_bonus := old.first_placement_bonus;
  new.residual_pct_y1 := old.residual_pct_y1;
  new.residual_pct_y2 := old.residual_pct_y2;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.archived_at := old.archived_at;
  new.archived_reason := old.archived_reason;
  new.invite_sent_at := old.invite_sent_at;
  return new;
end;
$$;
drop trigger if exists sales_partners_guard_trg on public.sales_partners;
create trigger sales_partners_guard_trg before update on public.sales_partners
  for each row execute function public.sales_partners_guard();

-- The self-signup trigger (20260602) turns EVERY new auth user into a workers
-- row. A sales partner is not a worker: skip them (metadata from partner-invite
-- or an e-mail already on sales_partners), otherwise they land in the worker app.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  is_first_user BOOLEAN;
  display_name  TEXT;
BEGIN
  IF NEW.raw_user_meta_data->>'portal_role' = 'sales_partner'
     OR EXISTS (SELECT 1 FROM public.sales_partners sp WHERE lower(sp.email) = lower(NEW.email) AND sp.archived_at IS NULL) THEN
    RETURN NEW;
  END IF;

  SELECT NOT EXISTS (SELECT 1 FROM workers) INTO is_first_user;

  display_name := COALESCE(
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'full_name',
    split_part(NEW.email, '@', 1)
  );

  IF EXISTS (SELECT 1 FROM workers WHERE lower(email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;

  INSERT INTO workers (name, email, role, access_level, app_status, worker_type)
  VALUES (display_name, NEW.email, 'worker', CASE WHEN is_first_user THEN 'admin' ELSE 'employee' END, 'Active', 'casual');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_auth_user failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

-- ── bank details — the partner and money users only ──────────────────────────
create table if not exists public.sales_partner_bank (
  partner_id    uuid primary key references public.sales_partners(id),
  account_name  text,
  bsb           text,
  account_no    text,
  updated_at    timestamptz not null default now()
);
alter table public.sales_partner_bank enable row level security;
drop policy if exists "partner bank own" on public.sales_partner_bank;
create policy "partner bank own" on public.sales_partner_bank
  for all to authenticated
  using (partner_id = (select public.current_partner_id()))
  with check (partner_id = (select public.current_partner_id()));
drop policy if exists "partner bank money" on public.sales_partner_bank;
create policy "partner bank money" on public.sales_partner_bank
  for select to authenticated using ((select public.is_portal_admin()));
grant select, insert, update on public.sales_partner_bank to authenticated;

-- ── referrals ────────────────────────────────────────────────────────────────
create table if not exists public.partner_referrals (
  id                    uuid primary key default gen_random_uuid(),
  partner_id            uuid not null references public.sales_partners(id),
  referral_type         text not null check (referral_type in ('new_client','specific_job','ongoing')),
  company_name          text not null,
  contact_name          text not null,
  contact_phone         text,
  contact_email         text,
  site_address          text not null,
  map_link              text,
  roles                 text[] not null default '{}',
  roles_other           text,
  people_count          integer not null default 1 check (people_count >= 1),
  start_date            date,
  duration_text         text,
  shift_pattern         text,
  special_requirements  text,
  source                text check (source in ('existing_relationship','cold_outreach','other')),
  partner_notes         text,
  attachment_path       text,
  status                text not null default 'submitted'
                        check (status in ('submitted','under_review','accepted','placement_in_progress','active','completed','declined','duplicate')),
  declined_reason       text,
  reason_visible        boolean not null default false,
  client_id             uuid references public.clients(id),
  client_name_snapshot  text,
  site_id               uuid references public.client_sites(id),
  site_name_snapshot    text,
  is_test               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz
);
create index if not exists partner_referrals_partner_idx on public.partner_referrals (partner_id, created_at desc);
create index if not exists partner_referrals_status_idx on public.partner_referrals (status);
alter table public.partner_referrals enable row level security;
drop policy if exists "referrals partner read own" on public.partner_referrals;
create policy "referrals partner read own" on public.partner_referrals
  for select to authenticated using (partner_id = (select public.current_partner_id()));
drop policy if exists "referrals partner insert own" on public.partner_referrals;
create policy "referrals partner insert own" on public.partner_referrals
  for insert to authenticated
  with check (partner_id = (select public.current_partner_id()) and status = 'submitted'
              and client_id is null and site_id is null);
drop policy if exists "referrals office all" on public.partner_referrals;
create policy "referrals office all" on public.partner_referrals
  for all to authenticated
  using ((select public.is_office_user()))
  with check ((select public.is_office_user()));
grant select, insert, update on public.partner_referrals to authenticated;

-- Status + note history. visible_to_partner = the partner sees this line.
create table if not exists public.partner_referral_events (
  id                  bigint generated always as identity primary key,
  referral_id         uuid not null references public.partner_referrals(id),
  kind                text not null check (kind in ('status','note','request_update','placement','commission')),
  from_status         text,
  to_status           text,
  note                text,
  visible_to_partner  boolean not null default true,
  actor_id            uuid,
  actor_name          text,
  created_at          timestamptz not null default now()
);
create index if not exists partner_referral_events_ref_idx on public.partner_referral_events (referral_id, created_at);
alter table public.partner_referral_events enable row level security;
drop policy if exists "referral events partner read visible" on public.partner_referral_events;
create policy "referral events partner read visible" on public.partner_referral_events
  for select to authenticated
  using (visible_to_partner and exists (
    select 1 from public.partner_referrals r
    where r.id = referral_id and r.partner_id = (select public.current_partner_id())));
-- A partner may add a "request_update" line on their own referral, nothing else.
drop policy if exists "referral events partner request update" on public.partner_referral_events;
create policy "referral events partner request update" on public.partner_referral_events
  for insert to authenticated
  with check (kind = 'request_update' and visible_to_partner and exists (
    select 1 from public.partner_referrals r
    where r.id = referral_id and r.partner_id = (select public.current_partner_id())));
drop policy if exists "referral events office all" on public.partner_referral_events;
create policy "referral events office all" on public.partner_referral_events
  for all to authenticated
  using ((select public.is_office_user()))
  with check ((select public.is_office_user()));
grant select, insert, update on public.partner_referral_events to authenticated;

-- ── placements: a period of work that came from a referral ───────────────────
-- gross_margin = revenue_collected - cost (collected only — never billed).
create table if not exists public.partner_placements (
  id                   uuid primary key default gen_random_uuid(),
  referral_id          uuid not null references public.partner_referrals(id),
  partner_id           uuid not null references public.sales_partners(id),
  client_id            uuid references public.clients(id),
  client_name_snapshot text,
  site_id              uuid references public.client_sites(id),
  site_name_snapshot   text,
  roles_text           text,
  period_start         date not null,
  period_end           date not null,
  hours                numeric(10,2) not null default 0,
  revenue_billed       numeric(12,2) not null default 0,
  revenue_collected    numeric(12,2) not null default 0,
  cost                 numeric(12,2) not null default 0,
  gross_margin         numeric(12,2) generated always as (revenue_collected - cost) stored,
  source               text not null default 'manual' check (source in ('manual','portal')),
  notes                text,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  archived_at          timestamptz,
  check (period_end >= period_start)
);
create index if not exists partner_placements_partner_idx on public.partner_placements (partner_id, period_start);
create index if not exists partner_placements_ref_idx on public.partner_placements (referral_id);
alter table public.partner_placements enable row level security;
drop policy if exists "placements partner read own" on public.partner_placements;
create policy "placements partner read own" on public.partner_placements
  for select to authenticated using (partner_id = (select public.current_partner_id()) and archived_at is null);
drop policy if exists "placements office read" on public.partner_placements;
create policy "placements office read" on public.partner_placements
  for select to authenticated using ((select public.is_office_user()));
drop policy if exists "placements money write" on public.partner_placements;
create policy "placements money write" on public.partner_placements
  for all to authenticated
  using ((select public.is_portal_admin()))
  with check ((select public.is_portal_admin()));
grant select, insert, update on public.partner_placements to authenticated;

-- ── commission lines: one bonus or residual per placement ────────────────────
create table if not exists public.partner_commission_lines (
  id            uuid primary key default gen_random_uuid(),
  placement_id  uuid not null references public.partner_placements(id),
  partner_id    uuid not null references public.sales_partners(id),
  kind          text not null check (kind in ('bonus','residual')),
  rate          numeric(12,2) not null default 0,
  base_amount   numeric(12,2) not null default 0,
  amount        numeric(12,2) not null default 0,
  status        text not null default 'pending' check (status in ('pending','approved','paid','void')),
  approved_by   uuid,
  approved_at   timestamptz,
  paid_at       timestamptz,
  payment_ref   text,
  calc          jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists partner_commission_lines_unique on public.partner_commission_lines (placement_id, kind);
create index if not exists partner_commission_lines_partner_idx on public.partner_commission_lines (partner_id, status);
alter table public.partner_commission_lines enable row level security;
drop policy if exists "commission partner read own" on public.partner_commission_lines;
create policy "commission partner read own" on public.partner_commission_lines
  for select to authenticated using (partner_id = (select public.current_partner_id()) and status <> 'void');
drop policy if exists "commission office read" on public.partner_commission_lines;
create policy "commission office read" on public.partner_commission_lines
  for select to authenticated using ((select public.is_office_user()));
drop policy if exists "commission money write" on public.partner_commission_lines;
create policy "commission money write" on public.partner_commission_lines
  for all to authenticated
  using ((select public.is_portal_admin()))
  with check ((select public.is_portal_admin()));
grant select, insert, update on public.partner_commission_lines to authenticated;

-- Approved / paid lines are locked: only the status chain and payment fields
-- may move, and never backwards.
create or replace function public.partner_commission_guard()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if old.status in ('approved','paid') then
    if new.amount <> old.amount or new.rate <> old.rate or new.base_amount <> old.base_amount
       or new.kind <> old.kind or new.placement_id <> old.placement_id then
      raise exception 'commission line is locked (%); void it and recompute instead', old.status;
    end if;
  end if;
  if old.status = 'paid' then
    raise exception 'a paid commission line is locked (ref %)', old.payment_ref;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists partner_commission_guard_trg on public.partner_commission_lines;
create trigger partner_commission_guard_trg before update on public.partner_commission_lines
  for each row execute function public.partner_commission_guard();

-- ── in-portal notifications for the partner ──────────────────────────────────
create table if not exists public.partner_notifications (
  id           uuid primary key default gen_random_uuid(),
  partner_id   uuid not null references public.sales_partners(id),
  kind         text not null,
  title        text not null,
  body         text,
  referral_id  uuid references public.partner_referrals(id),
  read         boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists partner_notifications_partner_idx on public.partner_notifications (partner_id, created_at desc);
alter table public.partner_notifications enable row level security;
drop policy if exists "partner notifications own read" on public.partner_notifications;
create policy "partner notifications own read" on public.partner_notifications
  for select to authenticated using (partner_id = (select public.current_partner_id()));
drop policy if exists "partner notifications own mark read" on public.partner_notifications;
create policy "partner notifications own mark read" on public.partner_notifications
  for update to authenticated
  using (partner_id = (select public.current_partner_id()))
  with check (partner_id = (select public.current_partner_id()));
drop policy if exists "partner notifications office all" on public.partner_notifications;
create policy "partner notifications office all" on public.partner_notifications
  for all to authenticated
  using ((select public.is_office_user()))
  with check ((select public.is_office_user()));
grant select, insert, update on public.partner_notifications to authenticated;

-- ── audit: every status change and commission adjustment lands in activity_events
create or replace function public.partner_audit_trg()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
begin
  select coalesce(
    (select w.name from public.workers w where lower(w.email) = lower((select auth.jwt() ->> 'email')) and w.archived_at is null limit 1),
    (select p.name from public.sales_partners p where p.id = (select public.current_partner_id())),
    (select auth.jwt() ->> 'email'), 'System') into v_name;
  if tg_table_name = 'partner_referrals' then
    if tg_op = 'INSERT' then
      insert into public.activity_events (actor_id, actor_name, verb, object_type, object_id, after)
      values (v_actor, v_name, 'submitted', 'partner_referral', new.id, jsonb_build_object('name', new.company_name, 'status', new.status));
    elsif new.status is distinct from old.status then
      insert into public.activity_events (actor_id, actor_name, verb, object_type, object_id, client_id, before, after)
      values (v_actor, v_name, 'moved', 'partner_referral', new.id, new.client_id,
              jsonb_build_object('status', old.status), jsonb_build_object('name', new.company_name, 'status', new.status));
    end if;
  elsif tg_table_name = 'partner_commission_lines' then
    if tg_op = 'INSERT' then
      insert into public.activity_events (actor_id, actor_name, verb, object_type, object_id, after)
      values (v_actor, v_name, 'calculated', 'partner_commission', new.id, jsonb_build_object('kind', new.kind, 'amount', new.amount, 'status', new.status));
    elsif new.status is distinct from old.status or new.amount is distinct from old.amount then
      insert into public.activity_events (actor_id, actor_name, verb, object_type, object_id, before, after)
      values (v_actor, v_name, case when new.status = 'paid' then 'paid' when new.status = 'approved' then 'approved' else 'adjusted' end,
              'partner_commission', new.id,
              jsonb_build_object('status', old.status, 'amount', old.amount),
              jsonb_build_object('kind', new.kind, 'status', new.status, 'amount', new.amount, 'payment_ref', new.payment_ref));
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists partner_referrals_audit on public.partner_referrals;
create trigger partner_referrals_audit after insert or update on public.partner_referrals
  for each row execute function public.partner_audit_trg();
drop trigger if exists partner_commission_audit on public.partner_commission_lines;
create trigger partner_commission_audit after insert or update on public.partner_commission_lines
  for each row execute function public.partner_audit_trg();

-- updated_at bookkeeping
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists partner_referrals_touch on public.partner_referrals;
create trigger partner_referrals_touch before update on public.partner_referrals
  for each row execute function public.touch_updated_at();
drop trigger if exists partner_placements_touch on public.partner_placements;
create trigger partner_placements_touch before update on public.partner_placements
  for each row execute function public.touch_updated_at();

-- ── lookups the referral form needs (partners cannot read staff tables) ──────
-- clients / job_roles are readable by every signed-in user already (name, id
-- only); this RPC just keeps the form to one call and hides archived rows.
create or replace function public.partner_lookup()
returns jsonb
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select jsonb_build_object(
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                         from public.clients c where c.archived_at is null), '[]'::jsonb),
    'roles',   coalesce((select jsonb_agg(r.name order by r.name)
                         from public.job_roles r where r.archived_at is null), '[]'::jsonb)
  )
  where (select public.current_partner_id()) is not null or (select public.is_office_user());
$$;
revoke all on function public.partner_lookup() from public;
grant execute on function public.partner_lookup() to authenticated;

-- ── private bucket for referral attachments ──────────────────────────────────
-- Folder = partner id. The partner writes/reads their own folder; office reads all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('partner-referrals', 'partner-referrals', false, 10485760,
        array['image/jpeg','image/png','image/webp','application/pdf',
              'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "partner referrals partner insert own" on storage.objects;
create policy "partner referrals partner insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'partner-referrals'
    and (storage.foldername(name))[1] = (select public.current_partner_id())::text);
drop policy if exists "partner referrals partner read own" on storage.objects;
create policy "partner referrals partner read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'partner-referrals'
    and (storage.foldername(name))[1] = (select public.current_partner_id())::text);
drop policy if exists "partner referrals office read" on storage.objects;
create policy "partner referrals office read" on storage.objects
  for select to authenticated
  using (bucket_id = 'partner-referrals' and (select public.is_office_user()));

-- ── weekly summary e-mail (opt-in per partner) — Monday 22:00 UTC ────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'partner-weekly-summary') then
    perform cron.unschedule('partner-weekly-summary');
  end if;
end $$;
select cron.schedule(
  'partner-weekly-summary',
  '0 22 * * 1',
  $cron$
  select net.http_post(
    url := 'https://tsizneslellcqusjwtub.supabase.co/functions/v1/notify-partner',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-digest-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'digest_secret' limit 1)),
    body := '{"weekly_summary": true}'::jsonb,
    timeout_milliseconds := 60000)
  $cron$
);
