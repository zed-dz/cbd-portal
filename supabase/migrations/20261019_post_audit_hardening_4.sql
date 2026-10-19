-- Post-audit hardening, part 4 (2026-10-19, review follow-ups).
-- 1. Xero link guard also covers INSERT (an office user creating a worker row
--    cannot pre-fill xero_employee_id unless they are an admin).
-- 2. Signature evidence is never client-supplied: for any non-service role the
--    trigger OVERWRITES ip + user_agent from the headers, preferring the IP the
--    edge (Cloudflare) attached, else the right-most X-Forwarded-For hop.

create or replace function public.guard_xero_employee_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if ((tg_op = 'INSERT' and new.xero_employee_id is not null)
      or (tg_op = 'UPDATE' and new.xero_employee_id is distinct from old.xero_employee_id))
     and not public.is_portal_admin() then
    raise exception 'only an admin can link a worker to Xero';
  end if;
  return new;
end
$$;

drop trigger if exists trg_guard_xero_employee_id on public.workers;
create trigger trg_guard_xero_employee_id
  before insert or update of xero_employee_id on public.workers
  for each row execute function public.guard_xero_employee_id();

create or replace function public.stamp_signature_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h jsonb;
  xff text;
  hops text[];
  ip text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;  -- server-side writers may carry their own evidence
  end if;
  begin
    h := current_setting('request.headers', true)::jsonb;
  exception when others then
    h := null;
  end;
  ip := null;
  if h is not null then
    ip := nullif(trim(h ->> 'cf-connecting-ip'), '');
    if ip is null then
      xff := h ->> 'x-forwarded-for';
      if xff is not null then
        hops := regexp_split_to_array(xff, '\s*,\s*');
        ip := nullif(trim(hops[array_length(hops, 1)]), '');
      end if;
    end if;
  end if;
  new.ip := left(ip, 64);
  new.user_agent := left(coalesce(h ->> 'user-agent', ''), 300);
  return new;
end
$$;
