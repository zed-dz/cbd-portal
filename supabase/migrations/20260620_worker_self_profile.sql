-- Worker self-service: a logged-in worker can update ONLY their own row and
-- only safe contact/ticket fields (never pay rates / access_level / role /
-- payroll / medical). Matches the worker by their auth email, mirroring the
-- existing SECURITY DEFINER onboarding pattern. Applied to prod via MCP
-- 2026-06-20; this file is the repo record. Powers the WorkerPortal "My Profile" tab.
create or replace function update_my_worker_profile(
  p_mobile text default null,
  p_alternate_phone text default null,
  p_address text default null,
  p_postal_address text default null,
  p_drivers_licence_number text default null,
  p_drivers_licence_expiry date default null,
  p_licences text default null,
  p_emergency_name text default null,
  p_emergency_relationship text default null,
  p_emergency_phone text default null,
  p_emergency_phone_alt text default null
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  w_id uuid;
begin
  if v_email is null then return false; end if;
  select id into w_id from workers where lower(email) = v_email and archived_at is null limit 1;
  if w_id is null then return false; end if;
  update workers set
    mobile                 = coalesce(p_mobile, mobile),
    alternate_phone        = coalesce(p_alternate_phone, alternate_phone),
    address                = coalesce(p_address, address),
    postal_address         = coalesce(p_postal_address, postal_address),
    drivers_licence_number = coalesce(p_drivers_licence_number, drivers_licence_number),
    drivers_licence_expiry = coalesce(p_drivers_licence_expiry, drivers_licence_expiry),
    licences               = coalesce(p_licences, licences),
    emergency_name         = coalesce(p_emergency_name, emergency_name),
    emergency_relationship = coalesce(p_emergency_relationship, emergency_relationship),
    emergency_phone        = coalesce(p_emergency_phone, emergency_phone),
    emergency_phone_alt    = coalesce(p_emergency_phone_alt, emergency_phone_alt)
  where id = w_id;
  return true;
end;
$$;

grant execute on function update_my_worker_profile(text,text,text,text,text,date,text,text,text,text,text) to authenticated;
