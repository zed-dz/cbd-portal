-- 20261023_contract_templates.sql
-- Employment contracts from templates (owner request 2026-10-23).
--   contract_templates  admin-only (money admins): the wording with {{placeholders}}
--   worker_contracts    one row per contract sent to a worker: frozen text, the values
--                       used, status, and the signature evidence (stamped by the server)
-- Additive only. RLS on both. Archive / withdraw, never delete. Contracts carry pay,
-- so templates are readable ONLY by public.is_portal_admin() (allocators excluded).

-- ───────────────────────────── templates ───────────────────────────────────
create table if not exists public.contract_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  worker_type   text check (worker_type is null or worker_type in ('full-time','part-time','casual','subcontractor')),
  body          text not null check (char_length(body) between 1 and 60000),
  is_default    boolean not null default false,
  version       int not null default 1,
  notes         text check (notes is null or char_length(notes) <= 400),
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
-- One live default per worker type.
create unique index if not exists contract_templates_default_uq
  on public.contract_templates (coalesce(worker_type, 'any')) where is_default and archived_at is null;

alter table public.contract_templates enable row level security;
drop policy if exists "contract_templates admin all" on public.contract_templates;
create policy "contract_templates admin all" on public.contract_templates
  for all to authenticated
  using ((select public.is_portal_admin())) with check ((select public.is_portal_admin()));
grant select, insert, update on public.contract_templates to authenticated;

create or replace function public.contract_templates_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists contract_templates_touch on public.contract_templates;
create trigger contract_templates_touch before update on public.contract_templates
  for each row execute function public.contract_templates_touch();

-- ───────────────────────────── sent contracts ──────────────────────────────
create table if not exists public.worker_contracts (
  id                      uuid primary key default gen_random_uuid(),
  worker_id               uuid not null references public.workers(id) on delete cascade,
  template_id             uuid references public.contract_templates(id),
  template_name_snapshot  text not null,
  template_version        int not null default 1,
  title                   text not null check (char_length(btrim(title)) between 1 and 160),
  body                    text not null,                 -- the filled wording, frozen at send time
  fields                  jsonb not null default '{}',   -- the values used to fill it
  missing                 text[] not null default '{}',  -- placeholders still to be typed by the office
  status                  text not null default 'needs_details'
                          check (status in ('needs_details','sent','viewed','signed','withdrawn')),
  sent_by_id              uuid references public.workers(id) on delete set null,
  sent_by_name            text,
  sent_at                 timestamptz,
  reminded_at             timestamptz,
  viewed_at               timestamptz,
  withdrawn_at            timestamptz,
  withdrawn_reason        text,
  -- signature evidence (worker writes name + drawing; the server stamps the rest)
  signed_at               timestamptz,
  signed_name             text,
  signature_png           text,
  ip                      text,
  user_agent              text,
  content_sha256          text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists worker_contracts_worker_idx on public.worker_contracts (worker_id, created_at desc);
create index if not exists worker_contracts_status_idx on public.worker_contracts (status, created_at desc);

alter table public.worker_contracts enable row level security;
-- Office (money admins) manage contracts.
drop policy if exists "worker_contracts admin all" on public.worker_contracts;
create policy "worker_contracts admin all" on public.worker_contracts
  for all to authenticated
  using ((select public.is_portal_admin())) with check ((select public.is_portal_admin()));
-- The worker sees their own contracts once sent (never drafts that still need details).
drop policy if exists "worker_contracts worker select own" on public.worker_contracts;
create policy "worker_contracts worker select own" on public.worker_contracts
  for select to authenticated
  using (worker_id = (select public.current_worker_id()) and status in ('sent','viewed','signed','withdrawn'));
-- The worker may update their own sent/viewed row (the trigger below limits WHAT they may change).
drop policy if exists "worker_contracts worker update own" on public.worker_contracts;
create policy "worker_contracts worker update own" on public.worker_contracts
  for update to authenticated
  using (worker_id = (select public.current_worker_id()) and status in ('sent','viewed'))
  with check (worker_id = (select public.current_worker_id()) and status in ('viewed','signed'));
grant select, insert, update on public.worker_contracts to authenticated;

-- Guard rails: what a worker may change, server-side stamping, and "signed is final".
create or replace function public.worker_contracts_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  is_office boolean := coalesce(auth.role(), '') = 'service_role' or (select public.is_portal_admin());
  h jsonb; xff text; hops text[]; v_ip text;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and old.status = 'signed' then
    raise exception 'A signed contract cannot be changed.';
  end if;
  if not is_office then
    -- A worker: only status (→ viewed / signed), viewed_at, and the signature fields may change.
    if new.worker_id <> old.worker_id or new.body <> old.body or new.title <> old.title or new.fields <> old.fields
       or new.template_id is distinct from old.template_id or new.sent_by_id is distinct from old.sent_by_id
       or new.withdrawn_at is distinct from old.withdrawn_at then
      raise exception 'Only the office can change that.';
    end if;
    if new.status = 'signed' then
      if coalesce(char_length(btrim(new.signed_name)), 0) < 3 then raise exception 'Type your full name to sign.'; end if;
      if new.signature_png is null or left(new.signature_png, 22) <> 'data:image/png;base64,' then raise exception 'Draw your signature to sign.'; end if;
      new.signed_at := now();
      new.content_sha256 := encode(digest(new.body, 'sha256'), 'hex');
      -- IP and device from the request, never from the client body.
      begin h := current_setting('request.headers', true)::jsonb; exception when others then h := null; end;
      v_ip := null;
      if h is not null then
        v_ip := nullif(btrim(h ->> 'cf-connecting-ip'), '');
        if v_ip is null then
          xff := h ->> 'x-forwarded-for';
          if xff is not null then hops := regexp_split_to_array(xff, '\s*,\s*'); v_ip := nullif(btrim(hops[array_length(hops, 1)]), ''); end if;
        end if;
        new.user_agent := left(h ->> 'user-agent', 300);
      end if;
      new.ip := left(v_ip, 64);
    elsif new.status = 'viewed' then
      new.viewed_at := coalesce(old.viewed_at, now());
      new.signed_name := old.signed_name; new.signature_png := old.signature_png; new.signed_at := old.signed_at;
    else
      raise exception 'A worker can only mark a contract viewed or signed.';
    end if;
  else
    if tg_op = 'UPDATE' and new.status = 'signed' and old.status <> 'signed' then
      raise exception 'Only the worker can sign.';
    end if;
    if new.status = 'withdrawn' and (tg_op = 'INSERT' or old.status <> 'withdrawn') then new.withdrawn_at := now(); end if;
    if new.status = 'sent' and (tg_op = 'INSERT' or old.status = 'needs_details') then new.sent_at := coalesce(new.sent_at, now()); end if;
  end if;
  return new;
end $$;
drop trigger if exists worker_contracts_guard on public.worker_contracts;
create trigger worker_contracts_guard before insert or update on public.worker_contracts
  for each row execute function public.worker_contracts_guard();
create extension if not exists pgcrypto;

-- ───────────────────────────── starter templates ───────────────────────────
-- Plain-English starter wording. Every one carries a note to have it checked.
insert into public.contract_templates (name, worker_type, is_default, notes, created_by, body)
select v.name, v.worker_type, true, 'Starter wording. Have your accountant or lawyer check it before the first real send.', 'portal', v.body
from (values
('Full-time employment agreement', 'full-time', $body$EMPLOYMENT AGREEMENT — FULL-TIME

Between {{company_name}} ("the Company") and {{worker_name}} ("you").

1. Start date and role. You start on {{start_date}} as {{job_title}}. You are employed full-time.
2. Hours. Your ordinary hours are {{hours_per_week}} hours a week, Monday to Friday, plus reasonable extra hours when the job needs it. Overtime and penalties are paid under the award and the Company's payroll rules.
3. Pay. Your base rate is ${{pay_rate}} an hour, paid weekly into the bank account you give us. Superannuation is paid on top at the legal rate.
4. Where you work. Sites set by the Company. You may be moved between clients and sites.
5. Leave. Annual leave, personal leave and public holidays as set by the National Employment Standards.
6. Safety. You follow every site induction, SWMS and instruction, wear the PPE provided, and report hazards and incidents in the app straight away.
7. Tickets and licences. You keep every ticket and licence your role needs current and tell us before any of them expires.
8. Probation. The first 6 months are a probation period. Either side may end the employment with one week's notice during probation.
9. Notice. After probation, notice is as set by the Fair Work Act.
10. Policies. You agree to the Company policies in the app, as updated from time to time.

Signed for the Company by {{sender_name}} on {{today}}.
Signed by you below.$body$),
('Part-time employment agreement', 'part-time', $body$EMPLOYMENT AGREEMENT — PART-TIME

Between {{company_name}} ("the Company") and {{worker_name}} ("you").

1. Start date and role. You start on {{start_date}} as {{job_title}}. You are employed part-time.
2. Hours. Your agreed hours are {{hours_per_week}} hours a week on the days {{days_of_work}}. Changes to these hours are agreed in writing.
3. Pay. Your base rate is ${{pay_rate}} an hour, paid weekly into the bank account you give us. Superannuation is paid on top at the legal rate.
4. Where you work. Sites set by the Company. You may be moved between clients and sites.
5. Leave. Pro-rata annual and personal leave as set by the National Employment Standards.
6. Safety. You follow every site induction, SWMS and instruction, wear the PPE provided, and report hazards and incidents in the app straight away.
7. Tickets and licences. You keep every ticket and licence your role needs current and tell us before any of them expires.
8. Probation and notice. 6 months probation with one week's notice either side; after that, notice as set by the Fair Work Act.
9. Policies. You agree to the Company policies in the app, as updated from time to time.

Signed for the Company by {{sender_name}} on {{today}}.
Signed by you below.$body$),
('Casual employment agreement', 'casual', $body$CASUAL EMPLOYMENT AGREEMENT

Between {{company_name}} ("the Company") and {{worker_name}} ("you").

1. Start date and role. Your first engagement is on {{start_date}} as {{job_title}}. You are a casual employee: there is no promise of ongoing work, and you may accept or decline any shift offered.
2. Pay. Your casual rate is ${{pay_rate}} an hour, which includes the {{casual_loading}} casual loading in place of paid leave. Overtime and penalties are paid under the award. Paid weekly. Superannuation on top at the legal rate.
3. Shifts. Shifts are offered in the app. Accept them there. Tell the office as early as you can if you cannot make a shift you accepted.
4. Timesheets. Submit a timesheet in the app each day you work. The site supervisor signs it off.
5. Safety. You follow every site induction, SWMS and instruction, wear the PPE provided, and report hazards and incidents in the app straight away.
6. Tickets and licences. You keep every ticket and licence your role needs current and tell us before any of them expires.
7. Policies. You agree to the Company policies in the app, as updated from time to time.

Signed for the Company by {{sender_name}} on {{today}}.
Signed by you below.$body$),
('Subcontractor agreement', 'subcontractor', $body$SUBCONTRACTOR AGREEMENT

Between {{company_name}} ("the Company") and {{worker_name}}, ABN {{abn}} ("the Contractor").

1. Engagement. The Company engages the Contractor from {{start_date}} to provide {{job_title}} services on sites the Company nominates.
2. Rate. ${{pay_rate}} an hour plus GST if registered, invoiced {{invoice_cycle}} with timesheets approved in the app. The Company pays within 14 days of a correct invoice.
3. Own business. The Contractor runs their own business, carries their own insurances ({{insurances}}), and is responsible for their own tax and superannuation.
4. Tickets and licences. The Contractor holds every ticket and licence the work needs and shows them on request.
5. Safety. The Contractor follows every site induction, SWMS and instruction, wears the PPE required, and reports hazards and incidents in the app straight away.
6. Ending. Either side may end this agreement with 7 days' written notice.
7. Policies. The Contractor agrees to the Company site policies in the app, as updated from time to time.

Signed for the Company by {{sender_name}} on {{today}}.
Signed by the Contractor below.$body$)
) as v(name, worker_type, body)
where not exists (select 1 from public.contract_templates t where t.worker_type = v.worker_type and t.archived_at is null);
