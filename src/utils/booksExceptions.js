// Books · exceptions v2 (pure). v1 (duplicates, uncoded, large, overdue bills)
// lives in SQL (books_exceptions); these six are computed here over the same
// rows and appended to the list on the Exceptions tab.
//   missing_gst     taxable line (OUTPUT/INPUT) with no GST on it
//   round_dollar    direct spend (not a bill payment) of $1,000+ that is an exact multiple of $100
//   out_of_hours    spend dated on a weekend (bank lines carry no time; weekend is what we can see)
//   new_vendor      first time this contact appears, in the last 30 days
//   spend_spike     this month's spend on an account > 2× its average over the 3 months before (≥ 2 of them with spend)
//   invoice_no_hours  a portal client invoice with no approved timesheet hours in its period

import { monthKey } from './books';

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const p = (n) => String(n).padStart(2, '0');
const utc = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; };
const prevMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`; };

export const V2_FLAG_LABEL = {
  missing_gst: 'Missing GST', round_dollar: 'Round dollars', out_of_hours: 'Weekend spend',
  new_vendor: 'New vendor', spend_spike: 'Spend spike', invoice_no_hours: 'Invoice, no hours',
};
export const V2_FLAG_COLOR = {
  missing_gst: 'yellow', round_dollar: 'orange', out_of_hours: 'blue', new_vendor: 'blue', spend_spike: 'red', invoice_no_hours: 'red',
};

const live = (t) => t.is_cash && ['AUTHORISED', 'PAID'].includes(String(t.status || 'AUTHORISED').toUpperCase());
const row = (flag, t, reason, extra = {}) => ({
  flag, xero_id: t.xero_id, kind: t.kind, contact_name: t.contact_name, amount: num(t.total), txn_date: t.txn_date,
  number: t.invoice_number || t.reference || null, reason, ...extra,
});

export function missingGst(transactions) {
  return (transactions || []).filter(live).filter((t) => {
    const tt = String(t.tax_type || '').toUpperCase();
    return (tt === 'OUTPUT' || tt === 'INPUT') && Math.abs(num(t.total)) >= 1 && num(t.gst) === 0;
  }).map((t) => row('missing_gst', t, `Tax type ${String(t.tax_type).toUpperCase()} but GST is $0.00 — expected about $${r2(Math.abs(num(t.total)) / 11).toFixed(2)}`));
}

export function roundDollar(transactions, min = 1000) {
  return (transactions || []).filter(live).filter((t) => t.direction === 'out' && t.kind === 'spend').filter((t) => {
    const v = Math.abs(num(t.total));
    return v >= min && Math.abs(v / 100 - Math.round(v / 100)) < 1e-9;
  }).map((t) => row('round_dollar', t, 'Exact round-dollar amount — check it is not an estimate or a cash withdrawal'));
}

export function outOfHours(transactions) {
  return (transactions || []).filter(live).filter((t) => t.direction === 'out' && t.kind === 'spend' && t.txn_date).filter((t) => {
    const dow = utc(t.txn_date)?.getUTCDay();
    return dow === 0 || dow === 6;
  }).map((t) => row('out_of_hours', t, `Spent on a ${utc(t.txn_date).getUTCDay() === 6 ? 'Saturday' : 'Sunday'}`));
}

// First appearance of a contact in the window, when that first appearance is recent.
export function newVendors(transactions, today, recentDays = 30) {
  const first = new Map();
  for (const t of (transactions || []).filter(live)) {
    if (t.direction !== 'out' || !t.contact_name || !t.txn_date) continue;
    const k = String(t.contact_name).trim().toLowerCase();
    const cur = first.get(k);
    if (!cur || t.txn_date < cur.txn_date) first.set(k, t);
  }
  const from = addDays(today, -recentDays);
  return [...first.values()].filter((t) => t.txn_date >= from && t.txn_date <= today)
    .map((t) => row('new_vendor', t, `First payment to this supplier (${t.txn_date})`));
}

// This month's spend per account vs the average of the three months before.
export function spendSpikes(transactions, today, factor = 2, minAmount = 500) {
  const ym = monthKey(today);
  const prior = [prevMonth(ym, 1), prevMonth(ym, 2), prevMonth(ym, 3)];
  const acc = new Map();
  for (const t of (transactions || []).filter(live)) {
    if (t.direction !== 'out' || !t.account_code) continue;
    const k = monthKey(t.txn_date);
    if (k !== ym && !prior.includes(k)) continue;
    const a = acc.get(t.account_code) || { code: t.account_code, name: t.account_name || t.account_code, cur: 0, prior: 0, priorMonths: new Set(), last: null };
    if (k === ym) { a.cur += Math.abs(num(t.total)); if (!a.last || t.txn_date > a.last.txn_date) a.last = t; } else { a.prior += Math.abs(num(t.total)); a.priorMonths.add(k); }
    acc.set(t.account_code, a);
  }
  const out = [];
  for (const a of acc.values()) {
    // Average over the prior months that had spend; one month of history is not a pattern.
    if (a.priorMonths.size < 2) continue;
    const avg = a.prior / a.priorMonths.size;
    if (a.cur >= minAmount && avg > 0 && a.cur > factor * avg) {
      out.push({ flag: 'spend_spike', xero_id: `acct-${a.code}-${ym}`, kind: 'account', contact_name: `${a.code} ${a.name}`, amount: r2(a.cur), txn_date: a.last?.txn_date || `${ym}-01`, number: null,
        reason: `$${r2(a.cur).toFixed(2)} this month vs $${r2(avg).toFixed(2)} a month on average (×${(a.cur / avg).toFixed(1)})` });
    }
  }
  return out.sort((x, y) => y.amount - x.amount);
}

// Portal invoices (client_invoices) with no approved hours in their period.
// invoices: [{ id, client, client_id, period_from, period_to, total|amount_cents, xero_invoice_number }]
// timesheets: approved rows [{ client_id, client, date, charge_hours }]
export function invoicesWithoutHours(invoices, timesheets) {
  const out = [];
  for (const inv of invoices || []) {
    if (!inv.period_from || !inv.period_to) continue;
    const hrs = (timesheets || []).filter((t) => t.date >= inv.period_from && t.date <= inv.period_to
      && ((inv.client_id && t.client_id === inv.client_id) || (!inv.client_id && t.client === inv.client)))
      .reduce((s, t) => s + num(t.charge_hours), 0);
    if (hrs > 0) continue;
    const total = inv.total !== null && inv.total !== undefined ? num(inv.total) : num(inv.amount_cents) / 100;
    out.push({ flag: 'invoice_no_hours', xero_id: inv.id, kind: 'invoice', contact_name: inv.client, amount: r2(total), txn_date: inv.period_to,
      number: inv.xero_invoice_number || null, reason: `Invoice for ${inv.period_from} → ${inv.period_to} but no approved timesheet hours for this client in that period` });
  }
  return out;
}

export function exceptionsV2({ transactions, invoices, timesheets, today }) {
  return [
    ...spendSpikes(transactions, today),
    ...invoicesWithoutHours(invoices, timesheets),
    ...missingGst(transactions),
    ...roundDollar(transactions),
    ...newVendors(transactions, today),
    ...outOfHours(transactions),
  ];
}

export function exceptionsCSVRows(list) {
  return (list || []).map((e) => ({ 'Flag': e.flag, 'Date': e.txn_date || '', 'Contact': e.contact_name || '', 'Number': e.number || '', 'Amount': num(e.amount).toFixed(2), 'Reason': e.reason || '' }));
}
