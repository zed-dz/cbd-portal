// Books · month-end close checklist + receipts matching (pure).

import { monthKey } from './books';
import { monthBounds } from './books';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (n) => Math.round(n * 100) / 100;

const UNCODED_RE = /(suspense|unknown|uncoded|unallocated)/i;

// Counts for a month (YYYY-MM). Every input is optional; missing → 0.
//   transactions: books_transactions rows (any month; filtered here)
//   receipts:     books_receipts rows
//   timesheets:   timesheets rows with status + date
//   headers:      timesheet_headers rows { status, invoiced_at, approved_at, created_at }
//   invoices:     client_invoices rows { period_to, status, xero_invoice_id }
export function closeChecklist({ month, transactions, receipts, timesheets, headers, invoices }) {
  const { from, to } = monthBounds(month);
  const inMonth = (d) => d && d >= from && d <= to;
  const tx = (transactions || []).filter((t) => t.is_cash && inMonth(t.txn_date) && ['AUTHORISED', 'PAID'].includes(String(t.status || 'AUTHORISED').toUpperCase()));
  const uncoded = tx.filter((t) => t.direction === 'out' && ['spend', 'bill_payment'].includes(t.kind) && (!t.account_code || UNCODED_RE.test(t.account_name || '')));
  const unreconciled = tx.filter((t) => t.is_reconciled === false);
  const spendCount = tx.filter((t) => t.direction === 'out' && t.kind === 'spend').length;
  const matchedIds = new Set((receipts || []).filter((r) => r.matched_xero_id && r.status !== 'rejected').map((r) => r.matched_xero_id));
  const unmatchedReceipts = (receipts || []).filter((r) => inMonth(r.receipt_date) && ['new', 'matched'].includes(r.status));
  const spendNoReceipt = tx.filter((t) => t.direction === 'out' && t.kind === 'spend' && !matchedIds.has(t.xero_id));
  const unapproved = (timesheets || []).filter((t) => inMonth(t.date) && !['approved', 'rejected'].includes(String(t.status || '').toLowerCase()));
  const unsent = (headers || []).filter((h) => inMonth(String(h.approved_at || h.created_at || '').slice(0, 10)) && String(h.status || '').toLowerCase() === 'approved' && !h.invoiced_at && !h.invoice_id);
  const invErrors = (invoices || []).filter((i) => inMonth(i.period_to) && (String(i.status || '') === 'error' || i.sync_error));
  const items = [
    { key: 'uncoded', label: 'Uncoded bank lines', count: uncoded.length, amount: r2(uncoded.reduce((s, t) => s + Math.abs(num(t.total)), 0)), tab: 'transactions' },
    { key: 'unreconciled', label: 'Unreconciled in Xero', count: unreconciled.length, amount: r2(unreconciled.reduce((s, t) => s + Math.abs(num(t.total)), 0)), tab: 'transactions' },
    { key: 'receipts_unmatched', label: 'Receipts not confirmed', count: unmatchedReceipts.length, amount: r2(unmatchedReceipts.reduce((s, r) => s + num(r.total), 0)), tab: 'receipts' },
    { key: 'spend_no_receipt', label: 'Spend lines with no receipt', count: spendNoReceipt.length, amount: r2(spendNoReceipt.reduce((s, t) => s + Math.abs(num(t.total)), 0)), tab: 'receipts', soft: true },
    { key: 'unapproved_ts', label: 'Timesheets not approved', count: unapproved.length, amount: null, tab: 'timesheets' },
    { key: 'unsent_invoices', label: 'Approved sheets not invoiced', count: unsent.length, amount: null, tab: 'invoices' },
    { key: 'invoice_errors', label: 'Invoice sync errors', count: invErrors.length, amount: null, tab: 'invoices' },
  ];
  const blocking = items.filter((i) => !i.soft && i.count > 0).length;
  return { month, from, to, items, blocking, ready: blocking === 0, spend_count: spendCount };
}

// Months that could be closed: every month with a cash line, oldest first,
// plus the state from books_month_close.
export function closeableMonths(transactions, closes, today) {
  const set = new Set();
  for (const t of transactions || []) { const k = monthKey(t.txn_date); if (k && k < monthKey(today)) set.add(k); }
  const byMonth = Object.fromEntries((closes || []).map((c) => [monthKey(c.month), c]));
  return [...set].sort().reverse().map((ym) => ({ month: ym, close: byMonth[ym] || null, closed: !!(byMonth[ym]?.closed_at && !byMonth[ym]?.reopened_at) }));
}

// Is a date inside a closed month?
export function isMonthClosed(dateStr, closes) {
  const ym = monthKey(dateStr);
  const c = (closes || []).find((x) => monthKey(x.month) === ym);
  return !!(c && c.closed_at && !c.reopened_at);
}

// ── Receipts ────────────────────────────────────────────────────────────────
// The word of a vendor name worth matching on: skip generic tokens
// (demo, pty, ltd, the, …) and anything under 4 letters.
const VENDOR_STOP = new Set(['demo', 'test', 'pty', 'ltd', 'the', 'and', 'inc', 'co', 'group', 'australia', 'aust', 'services', 'service', 'trading']);
export function vendorToken(vendor) {
  const words = String(vendor || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.find((w) => w.length >= 4 && !VENDOR_STOP.has(w)) || words.find((w) => !VENDOR_STOP.has(w)) || '';
}
// Candidate bank lines for a receipt: amount within ±2 %, date within ±5 days,
// spend/bill_payment only, best first.
export function suggestMatches(receipt, transactions, { pct = 0.02, days = 5 } = {}) {
  const total = Math.abs(num(receipt.total));
  if (!total) return [];
  const d0 = Date.parse(`${String(receipt.receipt_date || '').slice(0, 10)}T12:00:00Z`);
  const out = [];
  for (const t of transactions || []) {
    if (!t.is_cash || t.direction !== 'out' || !['spend', 'bill_payment'].includes(t.kind)) continue;
    const amt = Math.abs(num(t.total));
    const diffPct = Math.abs(amt - total) / total;
    if (diffPct > pct) continue;
    let dayDiff = 0;
    if (!Number.isNaN(d0) && t.txn_date) {
      dayDiff = Math.abs(Math.round((Date.parse(`${t.txn_date}T12:00:00Z`) - d0) / 86400000));
      if (dayDiff > days) continue;
    }
    const tok = vendorToken(receipt.vendor);
    const vendorHit = !!tok && !!t.contact_name && String(t.contact_name).toLowerCase().includes(tok);
    out.push({ ...t, score: r2(diffPct * 100 + dayDiff - (vendorHit ? 3 : 0) - (amt === total ? 2 : 0)), day_diff: dayDiff, amount_diff: r2(amt - total), vendor_hit: !!vendorHit });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 5);
}

// Most-used account code for this vendor in the ledger (or for the matched line).
export function suggestAccountCode(receipt, transactions, matched) {
  if (matched?.account_code) return { code: matched.account_code, name: matched.account_name || matched.account_code, why: 'from the matched bank line' };
  const v = vendorToken(receipt.vendor);
  if (!v) return null;
  const counts = new Map();
  for (const t of transactions || []) {
    if (!t.account_code || !t.contact_name || !String(t.contact_name).toLowerCase().includes(v)) continue;
    const c = counts.get(t.account_code) || { code: t.account_code, name: t.account_name || t.account_code, n: 0 };
    c.n += 1; counts.set(t.account_code, c);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { code: best.code, name: best.name, why: `used ${best.n}× for this supplier` } : null;
}

export function receiptsCSVRows(list) {
  return (list || []).map((r) => ({ 'Uploaded': String(r.uploaded_at || '').slice(0, 10), 'Vendor': r.vendor || '', 'Date': r.receipt_date || '', 'Total': num(r.total).toFixed(2), 'GST': num(r.gst).toFixed(2), 'Account': r.account_code || '', 'Matched line': r.matched_xero_id || '', 'Status': r.status }));
}
