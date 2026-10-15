-- 2026-10-15 (part 2). Run ONLY after the client build that reads
-- v_clients_admin / v_payroll_config is live (cbd commit after 2148c56).
-- Money is private: rates/charges on clients and the client charge-rate
-- defaults in payroll_config are no longer readable by workers.

-- clients: everyone reads the non-money columns, office writes, money via the view.
drop policy if exists "Auth users full access" on public.clients;
drop policy if exists "clients read" on public.clients;
create policy "clients read" on public.clients for select to authenticated using (true);
drop policy if exists "clients office write" on public.clients;
create policy "clients office write" on public.clients
  for all to authenticated using (public.is_office_user()) with check (public.is_office_user());
revoke select on public.clients from authenticated;
grant select (id, name, site, contact, contact_email, contact_phone, notes, created_at,
              email_domains, rate_set_id, award_profile, archived_at)
  on public.clients to authenticated;
-- No DELETE from the API: clients are archived (archived_at), never deleted.
revoke delete, truncate, references, trigger on public.clients from authenticated;

-- payroll_config: admins through the table, everyone else through v_payroll_config.
drop policy if exists "Auth users full access" on public.payroll_config;
drop policy if exists "payroll_config admin all" on public.payroll_config;
create policy "payroll_config admin all" on public.payroll_config
  for all to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());

-- Master data is never deleted from the API.
revoke delete on public.rate_sets from authenticated;
revoke delete on public.job_roles from authenticated;
revoke delete on public.client_sites from authenticated;
revoke delete on public.workers from authenticated;
