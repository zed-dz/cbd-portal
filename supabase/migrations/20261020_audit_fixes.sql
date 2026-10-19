-- Audit fixes (2026-10-20, independent audit 93/100). Additive and idempotent.
--
-- 1. Signed copy = the wording the worker actually signed.
--    site_induction_signatures / document_signatures get content_snapshot +
--    content_sha256, filled SERVER-SIDE by a BEFORE INSERT trigger from the
--    induction / document row as it is at that moment (whatever the caller
--    sends is overwritten). The snapshot is plain text:
--        <title>
--        Version <n>
--        PDF file: <storage path> (version <n>)      -- documents with a PDF only
--        <blank line>
--        <induction content / document body>
--    content_sha256 = hex SHA-256 of that text as UTF-8 (pgcrypto, schema
--    extensions), so anyone can recompute it from a printed copy.
--    A signature whose version is not the CURRENT version is refused (the old
--    wording is not stored anywhere, so it could not be snapshotted); a null
--    version is filled with the current one.
--    The write-once BEFORE UPDATE trigger now also freezes both new columns
--    (unconditionally: an old row without a snapshot can never be given one
--    later, because nobody can know what that worker saw).
-- 2. Archive, never delete: signature rows cannot be deleted through the API
--    by any role (anon, authenticated, service_role lose DELETE; the office
--    "all" policies become select / insert / update), nor through their
--    parents (site_inductions / company_documents cascade on delete, so they
--    lose DELETE too: they are archived, never deleted). anon loses every grant
--    on site_induction_signatures, document_signatures and clock_events: no
--    logged-out path uses them (grep 2026-10-20: only ClockInOut.jsx,
--    TimesheetDetailView.jsx, SiteInductionModal.jsx, DocumentsPage.jsx,
--    DocumentsTab.jsx, SiteInductionBanner.jsx — all signed-in screens — and
--    notify-admins-ops, which uses the service role).
-- 3. clock_events: a non-office caller may only link an event to a timesheet
--    header that belongs to the same worker (insert and update).
-- 4. Blank drawings: require_drawn_signature() also refuses a drawing that is
--    too small to be a signature. Threshold: 1,100 data-URL characters, plus a
--    real PNG header at least 100 x 50 px. Measured 2026-10-20 with the real
--    SignaturePad code (white fill, 2 px #0b0e14 strokes, export scaled to
--    600 px wide) in headless Chromium and WebKit at 260-688 css px wide,
--    160/170 px tall, pixel ratio 1-3.5:
--      blank pad, Chromium ............ 2,046 - 8,382 chars
--      blank pad, WebKit .............. 1,362 - 2,878 chars
--      4 px tick, WebKit (smallest) ... 1,226 chars
--      tiny 3-point scribble .......... 1,598+ (WebKit), 2,670+ (Chromium)
--      a real scribble ................ 8,226+ (Chromium), 10,242+ (WebKit)
--      blank 600x148 RGBA at deflate-9 .. 862 chars (tightest possible blank)
--    Browsers compress very differently, so a Chromium BLANK (up to 8.4 K) is
--    longer than a small genuine WebKit/iPhone mark: no single length can
--    refuse every browser's blank without refusing real iPhone signatures.
--    1,100 is the safe floor: below every genuine mark measured, above an
--    empty / 1x1 / tightly compressed blank. The full-size blank from the pad
--    itself is stopped on the phone (SignaturePad only emits a drawing once a
--    stroke has been drawn; signatureProblem() uses the same 1,100 floor).
-- 5. Xero token refresh in ONE place: xero_token_begin_refresh() /
--    xero_token_finish_refresh() / xero_token_abort_refresh() take a short
--    lease on the single xero_tokens row under SELECT ... FOR UPDATE, so
--    xero-invoice-sync, xero-invoice, xero-data and xero-push never spend the
--    same refresh token twice. Service role only (they hand out tokens).
--
-- Note on signature evidence (ip / user agent): stamp_signature_evidence()
-- stamps every insert made through the API, so the "fill a missing ip later"
-- update in notify-admins-ops never finds a row to change; it is left as a
-- harmless no-op (it only touches rows whose ip is still null).

-- ── 1. wording snapshot ──────────────────────────────────────────────────────
alter table public.site_induction_signatures add column if not exists content_snapshot text;
alter table public.site_induction_signatures add column if not exists content_sha256  text;
alter table public.document_signatures       add column if not exists content_snapshot text;
alter table public.document_signatures       add column if not exists content_sha256  text;

create or replace function public.snapshot_signed_content()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title   text;
  v_body    text;
  v_version integer;
  v_file    text;
  v_head    text;
begin
  if tg_table_name = 'site_induction_signatures' then
    select i.title, i.content, i.version
      into v_title, v_body, v_version
      from public.site_inductions i where i.id = new.induction_id;
    if not found then raise exception 'induction not found'; end if;
    v_head := concat_ws(E'\n', coalesce(v_title, ''), 'Version ' || coalesce(v_version, 1));
  else
    select d.title, d.body, d.version, nullif(trim(coalesce(d.file_path, '')), '')
      into v_title, v_body, v_version, v_file
      from public.company_documents d where d.id = new.document_id;
    if not found then raise exception 'document not found'; end if;
    v_head := concat_ws(E'\n', coalesce(v_title, ''), 'Version ' || coalesce(v_version, 1),
                        case when v_file is not null
                             then 'PDF file: ' || v_file || ' (version ' || coalesce(v_version, 1) || ')' end);
  end if;

  if new.version is null then
    new.version := coalesce(v_version, 1);
  elsif new.version <> coalesce(v_version, 1) then
    raise exception 'this text changed while you were reading it (it is now version %) — close it, open it again and sign the new version', coalesce(v_version, 1);
  end if;

  new.content_snapshot := v_head || E'\n\n' || coalesce(v_body, '');
  new.content_sha256   := encode(extensions.digest(convert_to(new.content_snapshot, 'UTF8'), 'sha256'), 'hex');
  return new;
end
$$;

drop trigger if exists trg_snapshot_document_signature on public.document_signatures;
create trigger trg_snapshot_document_signature
  before insert on public.document_signatures
  for each row execute function public.snapshot_signed_content();

drop trigger if exists trg_snapshot_induction_signature on public.site_induction_signatures;
create trigger trg_snapshot_induction_signature
  before insert on public.site_induction_signatures
  for each row execute function public.snapshot_signed_content();

-- Write-once evidence, now including the snapshot + its hash.
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
  new.content_snapshot := old.content_snapshot;   -- never set or changed after insert
  new.content_sha256   := old.content_sha256;
  return new;
end
$$;

-- ── 2. archive, never delete + no anon ──────────────────────────────────────
drop policy if exists "site_induction_signatures office all" on public.site_induction_signatures;
drop policy if exists "site_induction_signatures office select" on public.site_induction_signatures;
drop policy if exists "site_induction_signatures office insert" on public.site_induction_signatures;
drop policy if exists "site_induction_signatures office update" on public.site_induction_signatures;
create policy "site_induction_signatures office select" on public.site_induction_signatures
  for select to authenticated using (public.is_office_user());
create policy "site_induction_signatures office insert" on public.site_induction_signatures
  for insert to authenticated with check (public.is_office_user());
create policy "site_induction_signatures office update" on public.site_induction_signatures
  for update to authenticated using (public.is_office_user()) with check (public.is_office_user());

drop policy if exists "document_signatures office all" on public.document_signatures;
drop policy if exists "document_signatures office select" on public.document_signatures;
drop policy if exists "document_signatures office insert" on public.document_signatures;
drop policy if exists "document_signatures office update" on public.document_signatures;
create policy "document_signatures office select" on public.document_signatures
  for select to authenticated using (public.is_office_user());
create policy "document_signatures office insert" on public.document_signatures
  for insert to authenticated with check (public.is_office_user());
create policy "document_signatures office update" on public.document_signatures
  for update to authenticated using (public.is_office_user()) with check (public.is_office_user());

revoke delete, truncate on public.site_induction_signatures from authenticated, anon, service_role;
revoke delete, truncate on public.document_signatures       from authenticated, anon, service_role;
-- The parents cascade-delete their signatures (FK ON DELETE CASCADE), so they
-- must not be deletable through the API either. The UI only archives them
-- (SiteInductionModal / DocumentsPage set archived_at; grep 2026-10-20).
revoke delete, truncate on public.site_inductions   from authenticated, anon, service_role;
revoke delete, truncate on public.company_documents from authenticated, anon, service_role;

revoke all on public.site_induction_signatures from anon;
revoke all on public.document_signatures       from anon;
revoke all on public.clock_events              from anon;

-- ── 3. clock_events: header link must be the worker's own timesheet ─────────
create or replace function public.clock_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_office_user() then
      new.at := now();
      if new.header_id is not null
         and not exists (select 1 from public.timesheet_headers h
                          where h.id = new.header_id and h.worker_id = new.worker_id) then
        raise exception 'a clock event can only be linked to your own timesheet';
      end if;
    end if;
    return new;
  end if;
  if not public.is_office_user() then
    if new.at is distinct from old.at
       or new.kind is distinct from old.kind
       or new.worker_id is distinct from old.worker_id
       or new.lat is distinct from old.lat
       or new.lng is distinct from old.lng
       or new.accuracy_m is distinct from old.accuracy_m
       or new.allocation_id is distinct from old.allocation_id
       or new.device is distinct from old.device
       or new.created_at is distinct from old.created_at then
      raise exception 'clock events are read-only once recorded (only the timesheet link may be set)';
    end if;
    if new.header_id is not null
       and new.header_id is distinct from old.header_id
       and not exists (select 1 from public.timesheet_headers h
                        where h.id = new.header_id and h.worker_id = new.worker_id) then
      raise exception 'a clock event can only be linked to your own timesheet';
    end if;
  end if;
  return new;
end
$$;

-- ── 4. blank drawings ────────────────────────────────────────────────────────
-- Thresholds and measurements: see the header (section 4). Keep 1100 in step
-- with SIGNATURE_MIN_CHARS in src/utils/signatures.js.
create or replace function public.require_drawn_signature()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hdr bytea;
  w   bigint;
  h   bigint;
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.is_office_user() then
    if coalesce(new.signature_png, '') = '' or length(new.signature_png) < 1100 then
      raise exception 'draw your signature with your finger to sign';
    end if;
    begin
      -- 'data:image/png;base64,' is 22 characters; the next 32 decode to the
      -- first 24 bytes: PNG magic (8), IHDR length + type (8), width, height.
      hdr := decode(substr(new.signature_png, 23, 32), 'base64');
    exception when others then
      raise exception 'the signature could not be read — tap Clear and sign again';
    end;
    if length(hdr) < 24 or substring(hdr from 1 for 8) <> '\x89504e470d0a1a0a'::bytea then
      raise exception 'the signature could not be read — tap Clear and sign again';
    end if;
    w := get_byte(hdr, 16)::bigint * 16777216 + get_byte(hdr, 17) * 65536 + get_byte(hdr, 18) * 256 + get_byte(hdr, 19);
    h := get_byte(hdr, 20)::bigint * 16777216 + get_byte(hdr, 21) * 65536 + get_byte(hdr, 22) * 256 + get_byte(hdr, 23);
    if w < 100 or h < 50 then
      raise exception 'draw your signature with your finger to sign';
    end if;
  end if;
  return new;
end
$$;

-- ── 5. Xero token refresh lease ─────────────────────────────────────────────
alter table public.xero_tokens add column if not exists refresh_lock_holder uuid;
alter table public.xero_tokens add column if not exists refresh_lock_until  timestamptz;

-- Returns {state:'missing'} | {state:'fresh', access_token} |
-- {state:'busy'} (another caller is refreshing: wait and ask again) |
-- {state:'refresh', refresh_token} (the caller now holds a 30 s lease and must
-- call xero_token_finish_refresh or xero_token_abort_refresh).
create or replace function public.xero_token_begin_refresh(p_holder uuid, p_min_valid_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare t public.xero_tokens%rowtype;
begin
  select * into t from public.xero_tokens where id = 1 for update;
  if not found then return jsonb_build_object('state', 'missing'); end if;
  if t.access_token is not null
     and t.expires_at > now() + make_interval(secs => greatest(coalesce(p_min_valid_seconds, 300), 0)) then
    return jsonb_build_object('state', 'fresh', 'access_token', t.access_token);
  end if;
  if t.refresh_lock_until is not null and t.refresh_lock_until > now()
     and t.refresh_lock_holder is distinct from p_holder then
    return jsonb_build_object('state', 'busy');
  end if;
  update public.xero_tokens
     set refresh_lock_holder = p_holder, refresh_lock_until = now() + interval '30 seconds'
   where id = 1;
  return jsonb_build_object('state', 'refresh', 'refresh_token', t.refresh_token);
end
$$;

-- Stores the new pair only if the row still carries the refresh token that was
-- spent (nobody rotated it meanwhile); always releases the caller's lease.
create or replace function public.xero_token_finish_refresh(
  p_holder uuid, p_old_refresh text, p_access text, p_refresh text, p_expires_in integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean;
begin
  update public.xero_tokens
     set access_token = p_access,
         refresh_token = p_refresh,
         expires_at = now() + make_interval(secs => greatest(coalesce(p_expires_in, 1800), 60)),
         updated_at = now(),
         refresh_lock_holder = null,
         refresh_lock_until = null
   where id = 1 and refresh_token = p_old_refresh;
  ok := found;
  if not ok then
    update public.xero_tokens set refresh_lock_holder = null, refresh_lock_until = null
     where id = 1 and refresh_lock_holder = p_holder;
  end if;
  return ok;
end
$$;

create or replace function public.xero_token_abort_refresh(p_holder uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.xero_tokens set refresh_lock_holder = null, refresh_lock_until = null
   where id = 1 and refresh_lock_holder = p_holder;
$$;

revoke all on function public.xero_token_begin_refresh(uuid, integer)                    from public, anon, authenticated;
revoke all on function public.xero_token_finish_refresh(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.xero_token_abort_refresh(uuid)                             from public, anon, authenticated;
grant execute on function public.xero_token_begin_refresh(uuid, integer)                    to service_role;
grant execute on function public.xero_token_finish_refresh(uuid, text, text, text, integer) to service_role;
grant execute on function public.xero_token_abort_refresh(uuid)                             to service_role;
-- Trigger functions are never called directly.
revoke all on function public.snapshot_signed_content() from public, anon, authenticated;
