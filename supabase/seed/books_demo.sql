-- Books demo dataset (NOT a migration). Every row carries is_demo = true, a
-- 'demo-…' xero_id and a 'DEMO - …' contact, so the page shows the purple
-- "Demo data" banner and "Remove demo data" (books_remove_demo()) wipes it.
-- Dates are relative to the Sydney date so the exceptions fire: recurring
-- bill, wage pattern, spend spike, round dollars, weekend spend, missing GST,
-- new vendor, duplicate, uncoded, large claim, overdue invoices + bill.
do $$
declare d date := (now() at time zone 'Australia/Sydney')::date;
        m1 date := date_trunc('month', d)::date;                 -- first of this month
        thu date;  i int;
begin
  -- Recurring supplier (monthly, 15th) ×4 → forecast "recurring bills"
  for i in 1..4 loop
    insert into public.books_transactions (xero_id, kind, direction, is_cash, txn_date, contact_id, contact_name, description, total, subtotal, gst, tax_type, account_code, account_name, bank_account, status, is_reconciled, is_demo)
    values ('demo-telco-'||i, 'spend', 'out', true, (m1 - make_interval(months => i))::date + 14, 'demo-c-telco', 'DEMO - Telco Pty Ltd', 'Monthly phone + data', 210.00, 190.91, 19.09, 'INPUT', '489', 'Telephone & Internet', 'Demo Bank', 'AUTHORISED', true, true)
    on conflict (xero_id) do nothing;
  end loop;
  -- Wages every Thursday for 8 weeks → payroll pattern (median 9,000)
  thu := d - ((extract(dow from d)::int - 4 + 7) % 7);           -- most recent Thursday on/before today
  for i in 0..7 loop
    insert into public.books_transactions (xero_id, kind, direction, is_cash, txn_date, contact_id, contact_name, description, total, subtotal, gst, tax_type, account_code, account_name, bank_account, status, is_reconciled, is_demo)
    values ('demo-wages-'||i, 'spend', 'out', true, thu - (7 * i), 'demo-c-wages', 'DEMO - Wages', 'Weekly pay run', case when i = 3 then 11500.00 else 9000.00 end, case when i = 3 then 11500.00 else 9000.00 end, 0, 'BASEXCLUDED', '477', 'Wages and Salaries', 'Demo Bank', 'AUTHORISED', true, true)
    on conflict (xero_id) do nothing;
  end loop;
  -- Fuel: 3 steady months then a spike this month (> 2× average)
  insert into public.books_transactions (xero_id, kind, direction, is_cash, txn_date, contact_id, contact_name, description, total, subtotal, gst, tax_type, account_code, account_name, bank_account, status, is_reconciled, is_demo) values
    ('demo-fuel-3', 'spend', 'out', true, (m1 - interval '3 months')::date + 9,  'demo-c-fuel', 'DEMO - Fleet Fuel', 'Fuel card', 1000.00, 909.09, 90.91, 'INPUT', '449', 'Motor Vehicle Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-fuel-2', 'spend', 'out', true, (m1 - interval '2 months')::date + 9,  'demo-c-fuel', 'DEMO - Fleet Fuel', 'Fuel card', 1100.00, 1000.00, 100.00, 'INPUT', '449', 'Motor Vehicle Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-fuel-1', 'spend', 'out', true, (m1 - interval '1 month')::date + 9,   'demo-c-fuel', 'DEMO - Fleet Fuel', 'Fuel card', 950.00, 863.64, 86.36, 'INPUT', '449', 'Motor Vehicle Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-fuel-0', 'spend', 'out', true, least(d, m1 + 5),              'demo-c-fuel', 'DEMO - Fleet Fuel', 'Fuel card', 2800.00, 2545.45, 254.55, 'INPUT', '449', 'Motor Vehicle Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-fuel-rcpt', 'spend', 'out', true, d - 3, 'demo-c-fuel', 'DEMO - Fleet Fuel', 'Fuel card (matches the demo receipt)', 249.00, 226.36, 22.64, 'INPUT', '449', 'Motor Vehicle Expenses', 'Demo Bank', 'AUTHORISED', true, true),
  -- Round dollars, weekend, missing GST, new vendor, uncoded, large claim
    ('demo-round-1', 'spend', 'out', true, least(d, m1 + 2), 'demo-c-hire', 'DEMO - Round Dollar Hire', 'Deposit', 1500.00, 1363.64, 136.36, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-weekend-1', 'spend', 'out', true, d - ((extract(dow from d)::int + 1) % 7) - 0, 'demo-c-hw', 'DEMO - Hardware Barn', 'Saturday run', 86.50, 78.64, 7.86, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-nogst-1', 'spend', 'out', true, least(d, m1 + 1), 'demo-c-print', 'DEMO - Print Shop', 'Site signage', 330.00, 330.00, 0, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-newv-1', 'spend', 'out', true, least(d, m1 + 3), 'demo-c-new', 'DEMO - New Vendor Pty Ltd', 'First job', 640.00, 581.82, 58.18, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', false, true),
    ('demo-uncoded-1', 'spend', 'out', true, m1 - 3, 'demo-c-card', 'DEMO - Unknown Card xx1234', 'Card purchase', 64.90, 59.00, 5.90, 'INPUT', null, null, 'Demo Bank', 'AUTHORISED', false, true),
    ('demo-large-1', 'spend', 'out', true, m1 - 15, 'demo-c-plant', 'DEMO - Big Plant Hire', 'Excavator hire', 6200.00, 5636.36, 563.64, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', true, true),
  -- Duplicate pair (same contact, amount, reference)
    ('demo-dup-1', 'spend', 'out', true, m1 - 20, 'demo-c-dup', 'DEMO - Dup Supplies', 'Consumables INV-77', 275.00, 250.00, 25.00, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-dup-2', 'spend', 'out', true, m1 - 19, 'demo-c-dup', 'DEMO - Dup Supplies', 'Consumables INV-77', 275.00, 250.00, 25.00, 'INPUT', '429', 'General Expenses', 'Demo Bank', 'AUTHORISED', true, true),
  -- Money in
    ('demo-rcv-1', 'receive', 'in', true, m1 - 10, 'demo-c-client', 'Demo Client Pty Ltd (test)', 'Labour hire week 41', 5500.00, 5000.00, 500.00, 'OUTPUT', '200', 'Sales', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-pay-1', 'invoice_payment', 'in', true, m1 - 40, 'demo-c-client', 'Demo Client Pty Ltd (test)', 'Payment DEMO-INV-0998', 4400.00, 4000.00, 400.00, 'OUTPUT', '200', 'Sales', 'Demo Bank', 'AUTHORISED', true, true),
    ('demo-rcv-2', 'receive', 'in', true, least(d, m1 + 4), 'demo-c-client', 'Demo Client Pty Ltd (test)', 'Labour hire week 44', 6600.00, 6000.00, 600.00, 'OUTPUT', '200', 'Sales', 'Demo Bank', 'AUTHORISED', true, true)
  on conflict (xero_id) do nothing;
  update public.books_transactions set reference = 'INV-77' where xero_id in ('demo-dup-1', 'demo-dup-2');

  -- Open sales invoices (debtors) + an ATO bill
  insert into public.books_open_items (xero_id, item_type, contact_id, contact_name, number, issue_date, due_date, total, amount_due, amount_paid, status, is_demo) values
    ('demo-inv-1001', 'ACCREC', 'demo-c-client', 'Demo Client Pty Ltd (test)', 'DEMO-INV-1001', d - 59, d - 45, 3300.00, 3300.00, 0, 'AUTHORISED', true),
    ('demo-inv-1002', 'ACCREC', 'demo-c-client', 'Demo Client Pty Ltd (test)', 'DEMO-INV-1002', d - 24, d - 10, 2750.00, 2750.00, 0, 'AUTHORISED', true),
    ('demo-inv-1003', 'ACCREC', 'demo-c-client', 'Demo Client Pty Ltd (test)', 'DEMO-INV-1003', d - 2,  d + 12, 1980.00, 1980.00, 0, 'AUTHORISED', true),
    ('demo-bill-ato',  'ACCPAY', 'demo-c-ato',    'DEMO - ATO', 'Oct IAS', d - 20, d + 13, 4200.00, 4200.00, 0, 'AUTHORISED', true)
  on conflict (xero_id) do nothing;
end $$;
select public.books_demo_count() as demo_rows;
