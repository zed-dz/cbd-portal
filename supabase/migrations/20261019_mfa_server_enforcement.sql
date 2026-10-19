-- Server-side enforcement of two-step login (TOTP).
-- A user who has a VERIFIED TOTP factor must present an aal2 session
-- (passed the 6-digit code) before any RLS-protected table answers.
-- Users without a factor are unaffected (aal1 allowed).
-- The browser gate in App.jsx is only a courtesy; this is the real lock.

create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid()
        and f.status = 'verified'
    );
$$;

revoke all on function public.mfa_satisfied() from public;
grant execute on function public.mfa_satisfied() to authenticated, service_role;

-- Restrictive policy on every RLS table (restrictive = AND-ed with the
-- permissive ones). Idempotent: skips tables that already have it.
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t.relname
        and policyname = 'require_mfa_when_enrolled'
    ) then
      execute format(
        'create policy require_mfa_when_enrolled on public.%I as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied())',
        t.relname);
    end if;
  end loop;
end $$;
