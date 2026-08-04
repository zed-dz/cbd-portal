-- 2026-08-04 team feedback round
--
-- F3  Allocator role: allocation notifications (SMS + email) go ONLY to workers
--     flagged as allocators, instead of every admin. This replaces the
--     hard-coded SMS_ALLOWLIST in utils/notify.js with a data-driven roster the
--     office can edit itself (Workers page → Allocator toggle). Seeded with the
--     current behaviour: Zeff only.
--
-- F1a Worker onboarding was blocked for EVERY worker: the onboarding page read
--     the worker via get_public_worker_profile(), which is the CLIENT-facing
--     safe subset and deliberately omits `email`. So `profile.email` was always
--     undefined and the page showed "No email is on file for you yet" even when
--     one was. Fixed with a separate onboarding RPC (reachable only with the
--     worker's own private profile_token) plus the ability to SET an email when
--     none is on file — previously update_worker_via_token had no email param,
--     so there was no way out of the block from the worker's side.

-- ── Backfill the notification-preference columns ────────────────────────────
-- These were added straight to the CBD and MRA databases in July 2026 and never
-- written as a repo migration, so a portal built from the migration chain alone
-- (Hecate) doesn't have them and the roster RPC below fails to compile. Adding
-- them here idempotently makes the schema rebuildable on every portal.
alter table public.workers
  add column if not exists notify_mode  text    not null default 'per_event',
  add column if not exists notify_sms   boolean not null default true,
  add column if not exists notify_email boolean not null default true;

-- ── F3: allocator flag ──────────────────────────────────────────────────────
alter table public.workers
  add column if not exists is_allocator boolean not null default false;

comment on column public.workers.is_allocator is
  'Receives allocation notifications (SMS + email). Set on the Workers page. Replaces the old hard-coded SMS allowlist.';

create index if not exists workers_is_allocator_idx
  on public.workers (is_allocator) where is_allocator;

-- Roster RPC now carries the flag so the client can filter on it. Return type
-- changes, so drop + recreate rather than CREATE OR REPLACE.
drop function if exists public.get_admin_notification_recipients();

create function public.get_admin_notification_recipients()
returns table (
  name text, mobile text, email text,
  notify_mode text, notify_sms boolean, notify_email boolean,
  is_allocator boolean
)
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
    and w.archived_at is null;
$$;

revoke all on function public.get_admin_notification_recipients() from public, anon;
grant execute on function public.get_admin_notification_recipients() to authenticated;

-- Seed: preserve today's behaviour exactly — Zeff is the only allocator.
update public.workers
   set is_allocator = true
 where lower(email) = 'zefflunam@gmail.com'
   and archived_at is null;

-- ── F1a: onboarding profile RPC (includes the worker's own email) ───────────
-- Distinct from get_public_worker_profile: THAT one is handed to clients via
-- /p/<token> and must never leak contact details. This one is only ever called
-- from /onboard/<token>, where the bearer is the worker themselves, so it may
-- return their own email.
create or replace function public.get_onboard_worker_profile(token uuid)
returns table (
  id uuid, name text, job_title text, email text, mobile text,
  licences text, worker_type text, app_status text, has_email boolean
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select w.id, w.name, w.job_title, w.email, w.mobile,
         w.licences, w.worker_type, w.app_status,
         (coalesce(nullif(trim(w.email), ''), null) is not null) as has_email
  from public.workers w
  where w.profile_token = token
    and w.archived_at is null
  limit 1;
$$;

grant execute on function public.get_onboard_worker_profile(uuid) to anon, authenticated;

-- ── F1a: let the worker supply an email when none is on file ───────────────
-- Adding a parameter would create an overload and make the named-parameter
-- call ambiguous for PostgREST ("function is not unique"), so drop first.
-- Dropped by resolved signature so this can't miss because of a hand-typed
-- argument list drifting from the deployed one.
do $drop$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_worker_via_token'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end
$drop$;

create function public.update_worker_via_token(
  token uuid,
  p_email text default null,
  p_mobile text default null,
  p_alternate_phone text default null,
  p_address text default null,
  p_postal_address text default null,
  p_date_of_birth date default null,
  p_gender text default null,
  p_drivers_licence_number text default null,
  p_drivers_licence_expiry date default null,
  p_citizenship_status text default null,
  p_visa_subclass text default null,
  p_visa_expiry date default null,
  p_claim_tax_free_threshold boolean default null,
  p_has_hecs_debt boolean default null,
  p_emergency_name text default null,
  p_emergency_relationship text default null,
  p_emergency_phone text default null,
  p_emergency_phone_alt text default null,
  p_licences text default null,
  p_photo_url text default null,
  p_tfn text default null,
  p_bank_account_name text default null,
  p_bank_bsb text default null,
  p_bank_account_number text default null,
  p_super_fund_name text default null,
  p_super_fund_usi text default null,
  p_super_member_number text default null,
  p_use_default_super boolean default null,
  p_blood_type text default null,
  p_allergies text default null,
  p_conditions text default null,
  p_medications text default null,
  p_gp_name text default null,
  p_gp_phone text default null,
  p_medicare_number text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  w_id uuid;
  v_email text := nullif(trim(p_email), '');
BEGIN
  SELECT id INTO w_id FROM workers
  WHERE profile_token = token AND archived_at IS NULL
  LIMIT 1;

  IF w_id IS NULL THEN
    RETURN false;
  END IF;

  -- A worker may only ADD an email when their row has none. Never let a
  -- token-bearer overwrite an email the office already set, and never let two
  -- live workers collide on one address (that produced the duplicate-row /
  -- misrouted-notification bug on 2026-07-28).
  IF v_email IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM workers
                WHERE lower(email) = lower(v_email)
                  AND id <> w_id
                  AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'email_taken' USING ERRCODE = 'unique_violation';
    END IF;

    UPDATE workers
       SET email = v_email
     WHERE id = w_id
       AND coalesce(nullif(trim(email), ''), '') = '';
  END IF;

  UPDATE workers SET
    mobile                    = COALESCE(p_mobile,                    mobile),
    alternate_phone           = COALESCE(p_alternate_phone,           alternate_phone),
    address                   = COALESCE(p_address,                   address),
    postal_address            = COALESCE(p_postal_address,            postal_address),
    date_of_birth             = COALESCE(p_date_of_birth,             date_of_birth),
    gender                    = COALESCE(p_gender,                    gender),
    drivers_licence_number    = COALESCE(p_drivers_licence_number,    drivers_licence_number),
    drivers_licence_expiry    = COALESCE(p_drivers_licence_expiry,    drivers_licence_expiry),
    citizenship_status        = COALESCE(p_citizenship_status,        citizenship_status),
    visa_subclass             = COALESCE(p_visa_subclass,             visa_subclass),
    visa_expiry               = COALESCE(p_visa_expiry,               visa_expiry),
    claim_tax_free_threshold  = COALESCE(p_claim_tax_free_threshold,  claim_tax_free_threshold),
    has_hecs_debt             = COALESCE(p_has_hecs_debt,             has_hecs_debt),
    emergency_name            = COALESCE(p_emergency_name,            emergency_name),
    emergency_relationship    = COALESCE(p_emergency_relationship,    emergency_relationship),
    emergency_phone           = COALESCE(p_emergency_phone,           emergency_phone),
    emergency_phone_alt       = COALESCE(p_emergency_phone_alt,       emergency_phone_alt),
    licences                  = COALESCE(p_licences,                  licences),
    photo_url                 = COALESCE(p_photo_url,                 photo_url),
    app_status                = 'Completing Profile',
    onboarding_completed_at   = NOW()
  WHERE id = w_id;

  INSERT INTO worker_payroll_details AS pd (
    worker_id, tfn, bank_account_name, bank_bsb, bank_account_number,
    super_fund_name, super_fund_usi, super_member_number, use_default_super
  ) VALUES (
    w_id, p_tfn, p_bank_account_name, p_bank_bsb, p_bank_account_number,
    p_super_fund_name, p_super_fund_usi, p_super_member_number,
    COALESCE(p_use_default_super, false)
  )
  ON CONFLICT (worker_id) DO UPDATE SET
    tfn                  = COALESCE(EXCLUDED.tfn,                  pd.tfn),
    bank_account_name    = COALESCE(EXCLUDED.bank_account_name,    pd.bank_account_name),
    bank_bsb             = COALESCE(EXCLUDED.bank_bsb,             pd.bank_bsb),
    bank_account_number  = COALESCE(EXCLUDED.bank_account_number,  pd.bank_account_number),
    super_fund_name      = COALESCE(EXCLUDED.super_fund_name,      pd.super_fund_name),
    super_fund_usi       = COALESCE(EXCLUDED.super_fund_usi,       pd.super_fund_usi),
    super_member_number  = COALESCE(EXCLUDED.super_member_number,  pd.super_member_number),
    use_default_super    = COALESCE(EXCLUDED.use_default_super,    pd.use_default_super),
    updated_at           = NOW();

  INSERT INTO worker_medical_details AS md (
    worker_id, blood_type, allergies, conditions, medications,
    gp_name, gp_phone, medicare_number
  ) VALUES (
    w_id, p_blood_type, p_allergies, p_conditions, p_medications,
    p_gp_name, p_gp_phone, p_medicare_number
  )
  ON CONFLICT (worker_id) DO UPDATE SET
    blood_type       = COALESCE(EXCLUDED.blood_type,       md.blood_type),
    allergies        = COALESCE(EXCLUDED.allergies,        md.allergies),
    conditions       = COALESCE(EXCLUDED.conditions,       md.conditions),
    medications      = COALESCE(EXCLUDED.medications,      md.medications),
    gp_name          = COALESCE(EXCLUDED.gp_name,          md.gp_name),
    gp_phone         = COALESCE(EXCLUDED.gp_phone,         md.gp_phone),
    medicare_number  = COALESCE(EXCLUDED.medicare_number,  md.medicare_number),
    updated_at       = NOW();

  RETURN true;
END;
$function$;

grant execute on function public.update_worker_via_token(
  uuid, text, text, text, text, text, date, text, text, date, text, text, date,
  boolean, boolean, text, text, text, text, text, text, text, text, text,
  text, text, text, text, boolean, text, text, text, text, text, text, text
) to anon, authenticated;
