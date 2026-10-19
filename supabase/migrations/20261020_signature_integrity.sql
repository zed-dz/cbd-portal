-- Signature + clock evidence integrity (2026-10-20, after the 94/100 audit).
-- Requires 20261020_audit_fixes.sql.
-- 1. A signature's time is the server's: signed_at := now() on every insert
--    (the write-once trigger already protects it afterwards).
-- 2. Only the worker can sign for themselves — no office proxy signatures.
--    (Grep 2026-10-20: the only client inserts are the worker's own
--    SiteInductionBanner / DocumentsTab.)
-- 3. Clock events are evidence: nobody deletes them through the API.
-- 4. Logged-out (anon) role keeps no grants on inductions / documents.

create or replace function public.signature_time_is_now()
returns trigger
language plpgsql
as $$
begin
  new.signed_at := now();
  return new;
end
$$;

drop trigger if exists trg_aa_induction_signed_at_now on public.site_induction_signatures;
create trigger trg_aa_induction_signed_at_now
  before insert on public.site_induction_signatures
  for each row execute function public.signature_time_is_now();

drop trigger if exists trg_aa_document_signed_at_now on public.document_signatures;
create trigger trg_aa_document_signed_at_now
  before insert on public.document_signatures
  for each row execute function public.signature_time_is_now();

drop policy if exists "site_induction_signatures office insert" on public.site_induction_signatures;
drop policy if exists "document_signatures office insert" on public.document_signatures;

revoke delete on public.clock_events from authenticated, anon;

revoke all on public.site_inductions   from anon;
revoke all on public.company_documents from anon;
