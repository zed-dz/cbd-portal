-- Post-audit hardening, part 3 (2026-10-19).
-- E-sign evidence stamped IN the insert path: PostgREST exposes the request
-- headers to SQL, so a BEFORE INSERT trigger fills ip + user_agent on every
-- signature row. The notify-admins-ops stamp stays as a fallback for rows
-- written any other way.

create or replace function public.stamp_signature_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h jsonb;
begin
  begin
    h := current_setting('request.headers', true)::jsonb;
  exception when others then
    h := null;
  end;
  if h is not null then
    if new.ip is null then
      new.ip := left(nullif(trim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'cf-connecting-ip', ''), ',', 1)), ''), 64);
    end if;
    if new.user_agent is null then
      new.user_agent := left(h ->> 'user-agent', 300);
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists trg_stamp_document_signature on public.document_signatures;
create trigger trg_stamp_document_signature
  before insert on public.document_signatures
  for each row execute function public.stamp_signature_evidence();

drop trigger if exists trg_stamp_induction_signature on public.site_induction_signatures;
create trigger trg_stamp_induction_signature
  before insert on public.site_induction_signatures
  for each row execute function public.stamp_signature_evidence();
