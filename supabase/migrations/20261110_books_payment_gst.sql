-- Books: payments keep their GST (2026-11-09). Two causes of "1A = $0":
-- (1) the Payments upsert sent gst/tax_type as NULL and wiped what the invoice
--     pass had filled (fixed in books-sync: those columns are no longer sent);
-- (2) enrichment only ran when the invoice page happened to be processed after
--     the payment. Now every invoice's tax facts are kept in books_invoice_tax
--     and books_post_sync() fills any payment that still has no tax_type.
create table if not exists public.books_invoice_tax (
  invoice_id   text primary key,
  total        numeric,
  total_tax    numeric,
  tax_type     text,
  account_code text,
  updated_at   timestamptz not null default now()
);
alter table public.books_invoice_tax enable row level security;
revoke all on public.books_invoice_tax from anon, authenticated;
grant select on public.books_invoice_tax to authenticated;
drop policy if exists "books_invoice_tax money read" on public.books_invoice_tax;
create policy "books_invoice_tax money read" on public.books_invoice_tax for select to authenticated using (public.is_portal_admin());

create or replace function public.books_enrich_payments(p_invoices jsonb)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare n integer;
begin
  insert into public.books_invoice_tax (invoice_id, total, total_tax, tax_type, account_code, updated_at)
  select x.invoice_id, x.total, x.total_tax, x.tax_type, x.account_code, now()
    from jsonb_to_recordset(p_invoices) as x(invoice_id text, total numeric, total_tax numeric, tax_type text, account_code text)
   where x.invoice_id is not null
  on conflict (invoice_id) do update
    set total = excluded.total, total_tax = excluded.total_tax, tax_type = excluded.tax_type, account_code = excluded.account_code, updated_at = now();

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
  -- Payments that still carry no tax facts: take them from the invoice cache.
  update public.books_transactions t
     set gst          = case when coalesce(i.total, 0) <> 0 then round(t.total * (coalesce(i.total_tax, 0) / i.total), 2) else t.gst end,
         subtotal     = case when coalesce(i.total, 0) <> 0 then round(t.total - t.total * (coalesce(i.total_tax, 0) / i.total), 2) else t.subtotal end,
         tax_type     = coalesce(t.tax_type, i.tax_type),
         account_code = coalesce(t.account_code, i.account_code)
    from public.books_invoice_tax i
   where t.invoice_xero_id = i.invoice_id
     and t.kind in ('invoice_payment','bill_payment','credit_note','prepayment','overpayment')
     and (t.tax_type is null or t.gst is null);
$$;
revoke all on function public.books_enrich_payments(jsonb) from public, anon, authenticated;
revoke all on function public.books_post_sync()           from public, anon, authenticated;
grant execute on function public.books_enrich_payments(jsonb) to service_role;
grant execute on function public.books_post_sync()           to service_role;
