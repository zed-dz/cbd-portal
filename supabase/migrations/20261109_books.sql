-- 20261109_books.sql — Books module (ports the useful parts of A2Z Bookkeeping
-- into the portal, on the portal's EXISTING Xero connection).
--
-- Additive + idempotent. Every table here is MONEY: readable only by
-- public.is_portal_admin() (admin level AND not an allocator — the same
-- predicate the pay lockdown uses; 20261020_allocators_never_see_pay.sql).
-- Nothing in the browser may write: only the service role (books-sync) does.
--
-- Cash-basis figures live in SQL (security invoker) so a caller who fails the
-- money predicate gets no rows from the tables and therefore nothing from the
-- functions. Audit fixes designed in: #1 (truncated first import never advances
-- modified_since — see books_sync_runs.page_reached + books_sync_state), #4
-- (credit notes / prepayments / overpayments are synced, with a cash flag so
-- the BAS never double counts a document and its cash movement).

-- ── 1. Tables ───────────────────────────────────────────────────────────────
create table if not exists public.books_transactions (
  id             uuid primary key default gen_random_uuid(),
  xero_id        text not null unique,
  kind           text not null check (kind in ('spend','receive','invoice_payment','bill_payment','credit_note','prepayment','overpayment')),
  -- 'in' = money in / sales side, 'out' = money out / purchases side.
  direction      text not null default 'in' check (direction in ('in','out')),
  -- true = a cash movement (counts on a cash-basis BAS); false = a document
  -- view only (a credit note before it is refunded or allocated).
  is_cash        boolean not null default true,
  txn_date       date,
  contact_id     text,
  contact_name   text,
  description    text,
  reference      text,
  invoice_number text,
  invoice_xero_id text,
  total          numeric(14,2),
  subtotal       numeric(14,2),
  gst            numeric(14,2),
  tax_type       text,
  account_code   text,
  account_name   text,
  bank_account   text,
  status         text,
  is_reconciled  boolean,
  raw            jsonb,
  updated_utc    timestamptz,
  synced_at      timestamptz not null default now()
);
create index if not exists books_transactions_date_idx    on public.books_transactions (txn_date);
create index if not exists books_transactions_kind_idx    on public.books_transactions (kind, direction);
create index if not exists books_transactions_contact_idx on public.books_transactions (contact_id);
create index if not exists books_transactions_inv_idx     on public.books_transactions (invoice_xero_id);

create table if not exists public.books_open_items (
  id           uuid primary key default gen_random_uuid(),
  xero_id      text not null unique,
  item_type    text not null check (item_type in ('ACCREC','ACCPAY')),
  contact_id   text,
  contact_name text,
  number       text,
  issue_date   date,
  due_date     date,
  total        numeric(14,2),
  amount_due   numeric(14,2),
  amount_paid  numeric(14,2),
  status       text,
  raw          jsonb,
  synced_at    timestamptz not null default now()
);
create index if not exists books_open_items_due_idx on public.books_open_items (item_type, due_date);

create table if not exists public.books_accounts (
  code      text primary key,
  name      text,
  type      text,
  tax_type  text,
  class     text,
  status    text,
  synced_at timestamptz not null default now()
);

create table if not exists public.books_sync_state (
  endpoint        text primary key,
  modified_since  timestamptz,
  in_progress_run uuid,
  last_ok_at      timestamptz,
  last_error      text
);

create table if not exists public.books_sync_runs (
  id                  uuid primary key default gen_random_uuid(),
  endpoint            text not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  page_reached        integer not null default 0,
  rows_upserted       integer not null default 0,
  status              text not null default 'running' check (status in ('running','ok','error','partial')),
  error               text,
  triggered_by        text,
  -- the If-Modified-Since (or window start) this run asked Xero for; a resumed
  -- run keeps asking for the same value so no page is skipped (fix #1).
  modified_since_used timestamptz,
  full_sync           boolean not null default false,
  -- bumped after every page; a 'running' run with a stale heartbeat is resumable
  heartbeat_at        timestamptz
);
alter table public.books_sync_runs add column if not exists heartbeat_at timestamptz;
create index if not exists books_sync_runs_endpoint_idx on public.books_sync_runs (endpoint, started_at desc);

create table if not exists public.books_settings (
  id                    integer primary key default 1 check (id = 1),
  large_claim_threshold numeric(14,2) not null default 5000,
  bas_basis             text not null default 'cash' check (bas_basis in ('cash','accrual')),
  excluded_note         text not null default 'Not included: payroll journals, manual journals, transfers — read these in Xero.',
  updated_at            timestamptz not null default now()
);
insert into public.books_settings (id) values (1) on conflict (id) do nothing;

-- ── 2. RLS: money predicate, read-only from the API ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['books_transactions','books_open_items','books_accounts','books_sync_state','books_sync_runs','books_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s money read" on public.%I', t, t);
    execute format('create policy "%s money read" on public.%I for select to authenticated using ((select public.is_portal_admin()))', t, t);
    -- Default privileges hand `authenticated` ALL on new tables: take the writes back.
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ── 3. Figures (security INVOKER: RLS decides what the caller sees) ─────────
-- Tax types are Xero AU codes: OUTPUT (GST on income), INPUT (GST on expenses),
-- CAPEXINPUT (GST on capital), EXEMPTOUTPUT / EXEMPTEXPORT (GST-free sales),
-- EXEMPTEXPENSES (GST-free purchases), EXEMPTCAPITAL (GST-free capital),
-- BASEXCLUDED (never on the BAS), INPUTTAXED, GSTONIMPORTS.
create or replace function public.books_gst_of(p_total numeric, p_gst numeric, p_tax_type text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_gst is not null then p_gst
    when upper(coalesce(p_tax_type, '')) in ('OUTPUT','INPUT','CAPEXINPUT') then round(coalesce(p_total, 0) / 11, 2)
    else 0
  end
$$;

create or replace function public.books_bas_figures(p_from date, p_to date)
returns table (g1 numeric, g3 numeric, g10 numeric, g11 numeric, gst_1a numeric, gst_1b numeric, rows_counted bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with cash as (
    select t.direction, t.total, upper(coalesce(t.tax_type, '')) as tt,
           public.books_gst_of(t.total, t.gst, t.tax_type) as gst_amt,
           (upper(coalesce(t.tax_type, '')) in ('CAPEXINPUT','EXEMPTCAPITAL')
             or exists (select 1 from public.books_accounts a where a.code = t.account_code and upper(coalesce(a.type, '')) = 'FIXED')) as is_capital
      from public.books_transactions t
     where t.is_cash
       and t.txn_date between p_from and p_to
       and upper(coalesce(t.status, 'AUTHORISED')) in ('AUTHORISED','PAID')
  )
  select
    coalesce(sum(total)   filter (where direction = 'in'  and tt <> 'BASEXCLUDED'), 0)                       as g1,
    coalesce(sum(total)   filter (where direction = 'in'  and tt in ('EXEMPTOUTPUT','EXEMPTEXPORT')), 0)    as g3,
    coalesce(sum(total)   filter (where direction = 'out' and tt <> 'BASEXCLUDED' and is_capital), 0)       as g10,
    coalesce(sum(total)   filter (where direction = 'out' and tt <> 'BASEXCLUDED' and not is_capital), 0)   as g11,
    coalesce(sum(gst_amt) filter (where direction = 'in'), 0)                                                as gst_1a,
    coalesce(sum(gst_amt) filter (where direction = 'out'), 0)                                               as gst_1b,
    count(*)                                                                                                 as rows_counted
  from cash
$$;

create or replace function public.books_cash_by_month(p_months integer default 6)
returns table (month date, cash_in numeric, cash_out numeric, txn_count bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with m as (
    select (date_trunc('month', (now() at time zone 'Australia/Sydney')::date) - make_interval(months => g))::date as month
      from generate_series(0, greatest(coalesce(p_months, 6), 1) - 1) g
  )
  select m.month,
         coalesce(sum(t.total) filter (where t.direction = 'in'), 0)  as cash_in,
         coalesce(sum(t.total) filter (where t.direction = 'out'), 0) as cash_out,
         count(t.id)                                                   as txn_count
    from m
    left join public.books_transactions t
      on t.is_cash
     and upper(coalesce(t.status, 'AUTHORISED')) in ('AUTHORISED','PAID')
     and date_trunc('month', t.txn_date)::date = m.month
   group by m.month
   order by m.month
$$;

create or replace function public.books_debtor_ageing()
returns table (bucket text, amount numeric, item_count bigint, sort integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with today as (select (now() at time zone 'Australia/Sydney')::date as d),
  b as (
    select case
             when o.due_date is null or o.due_date >= today.d then 'current'
             when today.d - o.due_date <= 30 then '1-30'
             when today.d - o.due_date <= 60 then '31-60'
             when today.d - o.due_date <= 90 then '61-90'
             else '90+'
           end as bucket,
           o.amount_due
      from public.books_open_items o, today
     where o.item_type = 'ACCREC' and coalesce(o.amount_due, 0) > 0
  ),
  names(bucket, sort) as (values ('current', 0), ('1-30', 1), ('31-60', 2), ('61-90', 3), ('90+', 4))
  select n.bucket, coalesce(sum(b.amount_due), 0), count(b.bucket), n.sort
    from names n left join b on b.bucket = n.bucket
   group by n.bucket, n.sort
   order by n.sort
$$;

-- Exceptions: duplicates, uncoded spend, large claims, bills overdue > 30 days.
create or replace function public.books_exceptions()
returns table (flag text, xero_id text, kind text, contact_name text, amount numeric, txn_date date, number text, reason text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with s as (select large_claim_threshold as thr from public.books_settings where id = 1),
  cash as (
    select * from public.books_transactions t
     where t.is_cash and upper(coalesce(t.status, 'AUTHORISED')) in ('AUTHORISED','PAID')
       and t.txn_date >= ((now() at time zone 'Australia/Sydney')::date - interval '12 months')::date
  ),
  -- same contact + same total + same invoice number/reference; when both are
  -- blank, same contact + total within 3 days (audit fix #8: no false flags on
  -- two identical site invoices paid in the same week).
  dup_keyed as (
    select a.xero_id, a.kind, a.contact_name, a.total, a.txn_date, coalesce(a.invoice_number, a.reference) as num,
           count(*) over (partition by a.contact_id, a.total, a.kind, coalesce(nullif(a.invoice_number, ''), nullif(a.reference, ''))) as n
      from cash a
     where coalesce(nullif(a.invoice_number, ''), nullif(a.reference, '')) is not null and a.contact_id is not null
  ),
  dup_blank as (
    select a.xero_id, a.kind, a.contact_name, a.total, a.txn_date
      from cash a
     where coalesce(nullif(a.invoice_number, ''), nullif(a.reference, '')) is null and a.contact_id is not null
       and exists (select 1 from cash b
                    where b.xero_id <> a.xero_id and b.contact_id = a.contact_id and b.total = a.total and b.kind = a.kind
                      and coalesce(nullif(b.invoice_number, ''), nullif(b.reference, '')) is null
                      and abs(b.txn_date - a.txn_date) <= 3)
  )
  select 'duplicate', d.xero_id, d.kind, d.contact_name, d.total, d.txn_date, d.num,
         'Same contact, same amount and same number ' || coalesce(d.num, '') || ' appears ' || d.n || ' times'
    from dup_keyed d where d.n > 1
  union all
  select 'duplicate', d.xero_id, d.kind, d.contact_name, d.total, d.txn_date, null,
         'Same contact and same amount within 3 days, no number or reference to tell them apart'
    from dup_blank d
  union all
  select 'uncoded', c.xero_id, c.kind, c.contact_name, c.total, c.txn_date, coalesce(c.invoice_number, c.reference),
         case when c.account_code is null then 'No account code' else 'Coded to ' || coalesce(c.account_name, c.account_code) end
    from cash c
   where c.direction = 'out' and c.kind in ('spend','bill_payment')
     and (c.account_code is null
          or lower(coalesce(c.account_name, '')) ~ '(suspense|unknown|uncoded|unallocated)'
          or exists (select 1 from public.books_accounts a where a.code = c.account_code and lower(coalesce(a.name, '')) ~ '(suspense|unknown|uncoded|unallocated)'))
  union all
  select 'large', c.xero_id, c.kind, c.contact_name, c.total, c.txn_date, coalesce(c.invoice_number, c.reference),
         'Over the large-claim threshold of $' || to_char(s.thr, 'FM999,999,990.00')
    from cash c, s
   where c.direction = 'out' and abs(c.total) > s.thr
  union all
  select 'overdue_bill', o.xero_id, 'bill', o.contact_name, o.amount_due, o.due_date, o.number,
         'Bill ' || ((now() at time zone 'Australia/Sydney')::date - o.due_date) || ' days overdue'
    from public.books_open_items o
   where o.item_type = 'ACCPAY' and coalesce(o.amount_due, 0) > 0
     and o.due_date < ((now() at time zone 'Australia/Sydney')::date - 30)
$$;

-- ── 4. Service-role helpers used by books-sync (not SECURITY DEFINER: the
--      service role already bypasses RLS; nobody else may call them) ─────────
-- Payments carry no tax: apportion the invoice's GST onto each payment
-- (cash basis = payment × TotalTax / Total) and copy its coding.
create or replace function public.books_enrich_payments(p_invoices jsonb)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare n integer;
begin
  with inv as (
    select * from jsonb_to_recordset(p_invoices)
      as x(invoice_id text, total numeric, total_tax numeric, tax_type text, account_code text)
  )
  update public.books_transactions t
     set gst          = case when coalesce(inv.total, 0) <> 0 then round(t.total * (coalesce(inv.total_tax, 0) / inv.total), 2) else t.gst end,
         subtotal     = case when coalesce(inv.total, 0) <> 0 then round(t.total - t.total * (coalesce(inv.total_tax, 0) / inv.total), 2) else t.subtotal end,
         tax_type     = coalesce(inv.tax_type, t.tax_type),
         account_code = coalesce(inv.account_code, t.account_code)
    from inv
   where t.invoice_xero_id = inv.invoice_id
     and t.kind in ('invoice_payment','bill_payment','credit_note','prepayment','overpayment');
  get diagnostics n = row_count;
  return n;
end $$;

-- Fill account names from the chart; delete open items that are no longer open.
create or replace function public.books_post_sync()
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.books_transactions t
     set account_name = a.name
    from public.books_accounts a
   where a.code = t.account_code and (t.account_name is null or t.account_name <> a.name);
$$;

revoke all on function public.books_enrich_payments(jsonb) from public, anon, authenticated;
revoke all on function public.books_post_sync()           from public, anon, authenticated;
grant execute on function public.books_enrich_payments(jsonb) to service_role;
grant execute on function public.books_post_sync()           to service_role;

-- ── 5. Cron: hourly at :35, same shape as timesheet-pdf-daily-bundle ───────
do $$ begin perform cron.unschedule('books-sync-hourly'); exception when others then null; end $$;
select cron.schedule('books-sync-hourly', '35 * * * *',
  $$select net.http_post(
      url:='https://tsizneslellcqusjwtub.supabase.co/functions/v1/books-sync',
      headers:=jsonb_build_object('Content-Type','application/json','x-digest-secret',(select decrypted_secret from vault.decrypted_secrets where name='digest_secret' limit 1)),
      body:='{}'::jsonb)$$);
