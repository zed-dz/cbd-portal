// One loader for the Books page. Everything it reads is admin-only by RLS
// (is_portal_admin on books_*, the admin views for pay/charge rates), so a
// wrong caller gets empty arrays, never an error. Pure maths lives in
// src/utils/books*.js; this file only fetches and hands the rows over.

import { useState, useCallback, useEffect, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { todayISO } from '../../utils/dates';
import { basQuarter, monthOptions } from '../../utils/books';

const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function useBooksData(showToast) {
  const today = todayISO();
  const quarter = useMemo(() => basQuarter(today), [today]);
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState({
    settings: null, syncState: [], lastRun: null, bas: null, months: [], ageing: [], sqlExceptions: [],
    openItems: [], ourNumbers: new Set(), demoCount: 0, transactions: [], accounts: [],
    invoices: [], receipts: [], chases: [], budgets: [], closes: [], headers: [], notifications: 0,
    workers: [], clients: [], rateCards: [], roleRates: [], config: {}, tsLite: [],
  });
  // Margin range is its own query (the Margin tab moves it).
  const [marginRange, setMarginRange] = useState(() => ({ from: addDays(today, -55), to: today }));
  const [timesheets, setTimesheets] = useState([]);
  const [tsLoading, setTsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const txFrom = addDays(today, -400);
    const r = await Promise.all([
      supabase.from('books_sync_state').select('endpoint, modified_since, last_ok_at, last_error, in_progress_run'),
      supabase.from('books_sync_runs').select('endpoint, started_at, finished_at, status, rows_upserted, page_reached, error').order('started_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('books_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.rpc('books_bas_figures', { p_from: quarter.from, p_to: quarter.to }),
      supabase.rpc('books_cash_by_month', { p_months: 6 }),
      supabase.rpc('books_debtor_ageing'),
      supabase.rpc('books_exceptions'),
      supabase.from('books_open_items').select('xero_id, item_type, contact_id, contact_name, number, issue_date, due_date, total, amount_due, amount_paid, status, is_demo').gt('amount_due', 0).order('due_date', { ascending: true }).limit(1000),
      supabase.from('client_invoices').select('id, client, client_id, period_from, period_to, total, amount_cents, amount_due, amount_paid, due_date, fully_paid_on, status, sync_error, xero_invoice_id, xero_invoice_number, created_at').order('created_at', { ascending: false }).limit(2000),
      supabase.rpc('books_demo_count'),
      supabase.from('books_transactions').select('id, xero_id, kind, direction, is_cash, txn_date, contact_id, contact_name, description, reference, invoice_number, invoice_xero_id, total, subtotal, gst, tax_type, account_code, account_name, bank_account, status, is_reconciled, is_demo')
        .gte('txn_date', txFrom).order('txn_date', { ascending: false }).limit(6000),
      supabase.from('books_accounts').select('code, name, type, tax_type, class, status'),
      supabase.from('books_receipts').select('*').order('uploaded_at', { ascending: false }).limit(500),
      supabase.from('books_chases').select('*').order('created_at', { ascending: false }).limit(1000),
      supabase.from('books_budgets').select('account_group, month, amount'),
      supabase.from('books_month_close').select('*'),
      supabase.from('timesheet_headers').select('id, status, approved_at, created_at, invoiced_at, invoice_id, client_name_snapshot').gte('created_at', `${addDays(today, -120)}T00:00:00Z`).limit(3000),
      supabase.from('v_workers_admin').select('id, name, worker_type, pay_rate_regular, pay_rate_overtime, subcontractor_abn'),
      supabase.from('v_clients_admin').select('id, name, contact, contact_email, xero_contact_id, rate_a, rate_b, rate_c, rate_regular, rate_overtime, rate_night, rate_weekend, archived_at'),
      supabase.from('client_rate_cards').select('client_id, role_name, rate_a, rate_b, rate_c'),
      supabase.from('worker_role_rates').select('worker_id, role_name, rate_normal, rate_overtime').is('archived_at', null),
      supabase.from('v_payroll_config').select('config_key, config_value'),
      // Lite timesheet rows for the close checklist + "invoice with no hours": status + hours only.
      supabase.from('timesheets').select('id, date, status, client_id, client, charge_hours').gte('date', addDays(today, -400)).limit(20000),
    ]);
    const [st, run, settings, bas, months, ageing, exc, open, invoices, demo, tx, acc, receipts, chases, budgets, closes, headers, workers, clients, rateCards, roleRates, cfg, tsLite] = r;
    const firstErr = r.find((x) => x?.error)?.error;
    if (firstErr) showToast?.(firstErr.message, 'error');
    const config = {}; (cfg.data || []).forEach((x) => { config[x.config_key] = x.config_value; });
    setD({
      settings: settings.data || null, syncState: st.data || [], lastRun: run.data || null,
      bas: Array.isArray(bas.data) ? bas.data[0] : bas.data, months: months.data || [], ageing: ageing.data || [], sqlExceptions: exc.data || [],
      openItems: open.data || [], invoices: invoices.data || [],
      ourNumbers: new Set((invoices.data || []).map((x) => String(x.xero_invoice_number || '').trim().toLowerCase()).filter(Boolean)),
      demoCount: Number(demo.data) || 0, transactions: tx.data || [], accounts: acc.data || [],
      receipts: receipts.data || [], chases: chases.data || [], budgets: budgets.data || [], closes: closes.data || [], headers: headers.data || [],
      workers: workers.data || [], clients: clients.data || [], rateCards: rateCards.data || [], roleRates: roleRates.data || [], config,
      tsLite: tsLite.data || [],
    });
    setLoading(false);
  }, [quarter.from, quarter.to, showToast, today]);

  const loadTimesheets = useCallback(async () => {
    setTsLoading(true);
    const { data, error } = await supabase.from('timesheets').select('*, workers(name)')
      .eq('status', 'approved').gte('date', marginRange.from).lte('date', marginRange.to).order('date').limit(5000);
    if (error) showToast?.(error.message, 'error');
    setTimesheets(data || []);
    setTsLoading(false);
  }, [marginRange.from, marginRange.to, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTimesheets(); }, [loadTimesheets]);

  const monthOpts = useMemo(() => monthOptions(today, 13), [today]);
  return { today, quarter, loading, ...d, reload: load, marginRange, setMarginRange, timesheets, tsLoading, reloadTimesheets: loadTimesheets, monthOpts,
    patch: (p) => setD((x) => ({ ...x, ...p })) };
}

// Write a snapshot "Ask the books" can quote. Fire-and-forget.
export async function saveSnapshot(key, payload, who) {
  try {
    await supabase.from('books_snapshots').upsert([{ key, payload, computed_by: who || null, computed_at: new Date().toISOString() }], { onConflict: 'key' });
  } catch { /* RLS says no → nothing to do */ }
}
