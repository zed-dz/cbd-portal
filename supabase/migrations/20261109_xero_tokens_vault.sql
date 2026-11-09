-- 20261109_xero_tokens_vault.sql — Xero tokens encrypted at rest (A2Z audit fix #3).
--
-- Before: xero_tokens.access_token / refresh_token were plain text columns
-- (service-role only since 20261020_token_tables_lockdown.sql, but plain).
-- After: the two values live in Supabase Vault (vault.secrets, names
-- 'xero_access_token' / 'xero_refresh_token'); the table keeps only the
-- non-secret columns (expires_at, tenant_id, scope, the refresh lease).
--
-- Access is through two SECURITY DEFINER functions, service_role only:
--   xero_tokens_read()  → access_token, refresh_token, expires_at, tenant_id, scope
--   xero_tokens_write(p_access, p_refresh, p_expires, p_tenant, p_scope)
-- and the existing refresh lease (xero_token_begin_refresh / _finish_refresh /
-- _abort_refresh, 20261020_audit_fixes.sql) now reads and writes the vault too,
-- so every xero-* function keeps the same lock-safe refresh.
--
-- The ONE update of existing rows in this migration: after copying the current
-- values into the vault, the two plain columns on xero_tokens are set to NULL.

-- ── 0. Vault must be present (checked 2026-11-09: pg_extension supabase_vault = 1)
do $$ begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception 'supabase_vault extension is not installed — leave tokens as they are';
  end if;
end $$;

alter table public.xero_tokens alter column access_token  drop not null;
alter table public.xero_tokens alter column refresh_token drop not null;
-- Who connected (audit fix #2: bind the OAuth flow to the admin who started it).
alter table public.xero_tokens add column if not exists connected_by text;

-- ── 1. Vault helpers (postgres-owned, called only from the definer functions) ─
create or replace function public.xero_vault_set(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = p_name limit 1;
  if sid is null then
    perform vault.create_secret(coalesce(p_value, ''), p_name, 'Xero OAuth token (portal)');
  else
    perform vault.update_secret(sid, coalesce(p_value, ''));
  end if;
end $$;

create or replace function public.xero_vault_get(p_name text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select nullif(decrypted_secret, '') from vault.decrypted_secrets where name = p_name limit 1
$$;

revoke all on function public.xero_vault_set(text, text) from public, anon, authenticated, service_role;
revoke all on function public.xero_vault_get(text)       from public, anon, authenticated, service_role;

-- ── 2. One-time migration of the current row into the vault ────────────────
do $$
declare t public.xero_tokens%rowtype;
begin
  select * into t from public.xero_tokens where id = 1;
  if found then
    if t.access_token is not null and public.xero_vault_get('xero_access_token') is null then
      perform public.xero_vault_set('xero_access_token', t.access_token);
    end if;
    if t.refresh_token is not null and public.xero_vault_get('xero_refresh_token') is null then
      perform public.xero_vault_set('xero_refresh_token', t.refresh_token);
    end if;
    -- The one allowed UPDATE of existing rows: blank the plain-text copies.
    if public.xero_vault_get('xero_refresh_token') is not null then
      update public.xero_tokens set access_token = null, refresh_token = null where id = 1;
    end if;
  end if;
end $$;

-- ── 3. Read / write API for the edge functions (service_role only) ──────────
create or replace function public.xero_tokens_read()
returns table (access_token text, refresh_token text, expires_at timestamptz, tenant_id text, scope text, connected_by text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.xero_vault_get('xero_access_token'),
         public.xero_vault_get('xero_refresh_token'),
         x.expires_at, x.tenant_id, x.scope, x.connected_by, x.updated_at
    from public.xero_tokens x
   where x.id = 1
$$;

create or replace function public.xero_tokens_write(p_access text, p_refresh text, p_expires timestamptz, p_tenant text, p_scope text, p_connected_by text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.xero_vault_set('xero_access_token', p_access);
  perform public.xero_vault_set('xero_refresh_token', p_refresh);
  insert into public.xero_tokens (id, access_token, refresh_token, expires_at, tenant_id, scope, updated_at, connected_by, refresh_lock_holder, refresh_lock_until)
  values (1, null, null, p_expires, p_tenant, p_scope, now(), p_connected_by, null, null)
  on conflict (id) do update
    set access_token = null, refresh_token = null,
        expires_at = excluded.expires_at, tenant_id = excluded.tenant_id, scope = excluded.scope,
        updated_at = now(), connected_by = coalesce(excluded.connected_by, public.xero_tokens.connected_by),
        refresh_lock_holder = null, refresh_lock_until = null;
end $$;

revoke all on function public.xero_tokens_read()                                              from public, anon, authenticated;
revoke all on function public.xero_tokens_write(text, text, timestamptz, text, text, text)   from public, anon, authenticated;
grant execute on function public.xero_tokens_read()                                           to service_role;
grant execute on function public.xero_tokens_write(text, text, timestamptz, text, text, text) to service_role;

-- ── 4. The refresh lease, now vault-backed (same contract as before) ────────
create or replace function public.xero_token_begin_refresh(p_holder uuid, p_min_valid_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare t public.xero_tokens%rowtype; v_access text; v_refresh text;
begin
  select * into t from public.xero_tokens where id = 1 for update;
  if not found then return jsonb_build_object('state', 'missing'); end if;
  v_access  := coalesce(public.xero_vault_get('xero_access_token'),  t.access_token);
  v_refresh := coalesce(public.xero_vault_get('xero_refresh_token'), t.refresh_token);
  if v_refresh is null then return jsonb_build_object('state', 'missing'); end if;
  if v_access is not null
     and t.expires_at > now() + make_interval(secs => greatest(coalesce(p_min_valid_seconds, 300), 0)) then
    return jsonb_build_object('state', 'fresh', 'access_token', v_access);
  end if;
  if t.refresh_lock_until is not null and t.refresh_lock_until > now()
     and t.refresh_lock_holder is distinct from p_holder then
    return jsonb_build_object('state', 'busy');
  end if;
  update public.xero_tokens
     set refresh_lock_holder = p_holder, refresh_lock_until = now() + interval '30 seconds'
   where id = 1;
  return jsonb_build_object('state', 'refresh', 'refresh_token', v_refresh);
end $$;

create or replace function public.xero_token_finish_refresh(
  p_holder uuid, p_old_refresh text, p_access text, p_refresh text, p_expires_in integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare cur_refresh text; ok boolean := false;
begin
  perform 1 from public.xero_tokens where id = 1 for update;
  cur_refresh := coalesce(public.xero_vault_get('xero_refresh_token'), (select refresh_token from public.xero_tokens where id = 1));
  if cur_refresh = p_old_refresh then
    perform public.xero_vault_set('xero_access_token',  p_access);
    perform public.xero_vault_set('xero_refresh_token', p_refresh);
    update public.xero_tokens
       set access_token = null, refresh_token = null,
           expires_at = now() + make_interval(secs => greatest(coalesce(p_expires_in, 1800), 60)),
           updated_at = now(),
           refresh_lock_holder = null, refresh_lock_until = null
     where id = 1;
    ok := true;
  else
    update public.xero_tokens set refresh_lock_holder = null, refresh_lock_until = null
     where id = 1 and refresh_lock_holder = p_holder;
  end if;
  return ok;
end $$;

-- xero_token_abort_refresh is unchanged (lease columns only).
revoke all on function public.xero_token_begin_refresh(uuid, integer)                    from public, anon, authenticated;
revoke all on function public.xero_token_finish_refresh(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.xero_token_begin_refresh(uuid, integer)                    to service_role;
grant execute on function public.xero_token_finish_refresh(uuid, text, text, text, integer) to service_role;

-- The browser still only sees "connected until when" (unchanged grant).
revoke all on public.xero_tokens from anon, authenticated;
grant select (id, expires_at) on public.xero_tokens to authenticated;
