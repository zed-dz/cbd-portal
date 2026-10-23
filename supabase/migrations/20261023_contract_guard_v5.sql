-- 20261023_contract_guard_v5.sql
-- Same guard as v4; the SHA-256 now calls pgcrypto where Supabase installs it
-- (schema `extensions`), which the function's search_path does not include.
create or replace function public.worker_contracts_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  is_office boolean := coalesce(auth.role(), '') = 'service_role' or (select public.is_portal_admin());
  h jsonb; xff text; hops text[]; v_ip text; v_status text; v_name text; v_png text;
begin
  if tg_op = 'UPDATE' and old.status = 'signed' then raise exception 'A signed contract cannot be changed.'; end if;
  if tg_op = 'UPDATE' and old.status = 'withdrawn' then raise exception 'A withdrawn contract is final. Send a new one.'; end if;

  if not is_office then
    if tg_op = 'INSERT' then raise exception 'Only the office can create a contract.'; end if;
    v_status := new.status; v_name := new.signed_name; v_png := new.signature_png;
    new := old;
    new.status := v_status;
    if v_status = 'signed' then
      if old.status not in ('sent', 'viewed') then raise exception 'This contract is not open for signing.'; end if;
      if coalesce(char_length(btrim(v_name)), 0) < 3 then raise exception 'Type your full name to sign.'; end if;
      if v_png is null or left(v_png, 22) <> 'data:image/png;base64,' or char_length(v_png) > 400000 then raise exception 'Draw your signature to sign.'; end if;
      new.signed_name := btrim(v_name); new.signature_png := v_png;
      new.signed_at := now();
      new.content_sha256 := encode(extensions.digest(convert_to(old.body, 'UTF8'), 'sha256'::text), 'hex');
      begin h := current_setting('request.headers', true)::jsonb; exception when others then h := null; end;
      v_ip := null; new.user_agent := null;
      if h is not null then
        v_ip := nullif(btrim(h ->> 'cf-connecting-ip'), '');
        if v_ip is null then
          xff := h ->> 'x-forwarded-for';
          if xff is not null then hops := regexp_split_to_array(xff, '\s*,\s*'); v_ip := nullif(btrim(hops[array_length(hops, 1)]), ''); end if;
        end if;
        new.user_agent := left(h ->> 'user-agent', 300);
      end if;
      new.ip := left(v_ip, 64);
    elsif v_status = 'viewed' then
      if old.status not in ('sent', 'viewed') then raise exception 'This contract is not open.'; end if;
      new.viewed_at := coalesce(old.viewed_at, now());
    else
      raise exception 'A worker can only mark a contract viewed or signed.';
    end if;
  else
    if new.status = 'signed' then raise exception 'Only the worker can sign.'; end if;
    if tg_op = 'INSERT' then
      if new.status not in ('needs_details', 'sent') then raise exception 'A new contract starts as needs_details or sent.'; end if;
      new.signed_at := null; new.signed_name := null; new.signature_png := null; new.ip := null; new.user_agent := null; new.content_sha256 := null; new.viewed_at := null; new.withdrawn_at := null;
    else
      new.signed_at := old.signed_at; new.signed_name := old.signed_name; new.signature_png := old.signature_png;
      new.ip := old.ip; new.user_agent := old.user_agent; new.content_sha256 := old.content_sha256; new.viewed_at := old.viewed_at;
      if old.status <> 'needs_details' and (new.body <> old.body or new.title <> old.title or new.fields <> old.fields
         or new.worker_id <> old.worker_id or new.template_id is distinct from old.template_id or new.template_version <> old.template_version) then
        raise exception 'This contract has been sent. Withdraw it and send a new one to change the wording.';
      end if;
      if old.status in ('sent', 'viewed') and new.status not in (old.status, 'withdrawn') then
        raise exception 'A sent contract can only be withdrawn by the office.';
      end if;
      if old.status = 'needs_details' and new.status not in ('needs_details', 'sent', 'withdrawn') then
        raise exception 'A contract that needs details can only be sent or withdrawn.';
      end if;
    end if;
    if new.status = 'withdrawn' and (tg_op = 'INSERT' or old.status <> 'withdrawn') then new.withdrawn_at := now(); end if;
    if new.status = 'sent' and (tg_op = 'INSERT' or old.status = 'needs_details') then new.sent_at := coalesce(new.sent_at, now()); end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
