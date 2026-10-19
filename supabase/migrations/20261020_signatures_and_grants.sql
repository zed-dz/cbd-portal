-- Drawn signatures + grant hygiene (2026-10-20). Additive and idempotent.
--
-- 1. Site inductions and company documents keep the tick + typed full name and
--    now also carry the finger-drawn signature as a PNG data URL
--    (signature_png). Capped at 200 KB by a CHECK; a worker signing from the
--    portal must send one (trigger below). Old rows stay as they are (null).
--    stamp_signature_evidence() (ip + user agent from the request headers) is
--    untouched and still fires on insert.
-- 2. clock_events: defence in depth. Signed-in users may only UPDATE the
--    header_id column (the worker links an in/out pair to the timesheet it
--    saved). The guard trigger stays. Nothing in the client updates any other
--    column; office corrections do not exist in the UI, and edge functions use
--    the service role, which has its own grants.
-- 3. workers: logged-out (anon) callers lose INSERT / UPDATE / DELETE. Every
--    logged-out path (/onboard/:token, /p/:token, /apply, public profile)
--    goes through SECURITY DEFINER RPCs or edge functions, which do not use
--    anon's table grants. RLS already had no anon policy; this removes the
--    grants themselves (column grants go with the table-level revoke).
-- 4. Signature evidence (ip, user agent, drawing, name, time, version) is
--    write-once for every role: a BEFORE UPDATE trigger keeps the old value.
-- 5. get_admin_notification_recipients() answers the service role again (the
--    edge functions got an empty admin roster since 2026-10-15).

-- ── 1. drawn signatures ─────────────────────────────────────────────────────
alter table public.document_signatures       add column if not exists signature_png text;
alter table public.site_induction_signatures add column if not exists signature_png text;

alter table public.document_signatures drop constraint if exists document_signatures_signature_png_check;
alter table public.document_signatures add constraint document_signatures_signature_png_check
  check (signature_png is null
         or (signature_png like 'data:image/png;base64,%' and octet_length(signature_png) <= 204800));

alter table public.site_induction_signatures drop constraint if exists site_induction_signatures_signature_png_check;
alter table public.site_induction_signatures add constraint site_induction_signatures_signature_png_check
  check (signature_png is null
         or (signature_png like 'data:image/png;base64,%' and octet_length(signature_png) <= 204800));

-- A worker signing through the portal (role authenticated, not office) must
-- draw. Service-role writers and office users are not forced.
create or replace function public.require_drawn_signature()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'authenticated'
     and not public.is_office_user()
     and coalesce(new.signature_png, '') = '' then
    raise exception 'draw your signature with your finger to sign';
  end if;
  return new;
end
$$;

drop trigger if exists trg_require_drawn_document_signature on public.document_signatures;
create trigger trg_require_drawn_document_signature
  before insert on public.document_signatures
  for each row execute function public.require_drawn_signature();

drop trigger if exists trg_require_drawn_induction_signature on public.site_induction_signatures;
create trigger trg_require_drawn_induction_signature
  before insert on public.site_induction_signatures
  for each row execute function public.require_drawn_signature();

-- ── 2. clock_events: header_id is the only column a signed-in user updates ──
revoke update on public.clock_events from authenticated;
revoke update on public.clock_events from anon;
grant update (header_id) on public.clock_events to authenticated;

-- ── 3. workers: no writes for logged-out callers ────────────────────────────
revoke insert, update, delete on public.workers from anon;

-- ── 4. signature evidence is write-once (security review, 2026-10-20) ───────
-- Once ip, user_agent, signature_png, signed_name, signed_at or version hold a
-- value, no UPDATE can change it, for EVERY role (office, service role,
-- postgres): the new value is silently replaced by the old one. An empty
-- field (NULL, or '' for ip / user agent) could still be filled, but nothing
-- does that in practice: stamp_signature_evidence() stamps every API insert,
-- so the notify-admins-ops update (ip still null) never matches a row.
-- (Comment corrected 2026-10-20, 20261020_audit_fixes.sql; SQL unchanged.)
create or replace function public.keep_signature_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(old.ip, '') <> ''         then new.ip := old.ip; end if;
  if coalesce(old.user_agent, '') <> '' then new.user_agent := old.user_agent; end if;
  if old.signature_png is not null      then new.signature_png := old.signature_png; end if;
  if old.signed_name is not null        then new.signed_name := old.signed_name; end if;
  if old.signed_at is not null          then new.signed_at := old.signed_at; end if;
  if old.version is not null            then new.version := old.version; end if;
  return new;
end
$$;

drop trigger if exists trg_keep_document_signature_evidence on public.document_signatures;
create trigger trg_keep_document_signature_evidence
  before update on public.document_signatures
  for each row execute function public.keep_signature_evidence();

drop trigger if exists trg_keep_induction_signature_evidence on public.site_induction_signatures;
create trigger trg_keep_induction_signature_evidence
  before update on public.site_induction_signatures
  for each row execute function public.keep_signature_evidence();

-- ── 5. admin roster readable by the service role again ─────────────────────
-- Found by the fatigue dry run (2026-10-20): since 20261015_pretrial_hardening
-- this RPC only answered office users, so the service-role edge functions
-- (notify-admins, notify-admins-ops) got an EMPTY roster and every
-- worker-triggered admin alert (accept/decline, incident, time off, induction,
-- fatigue) reached only the ADMIN_EMAIL inbox: no allocator SMS or e-mail.
-- Workers (role authenticated, not office) still get nothing.
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
    and (public.is_office_user() or coalesce(auth.role(), '') = 'service_role');
$$;
