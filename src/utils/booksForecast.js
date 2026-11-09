// Books · 13-week direct cash flow forecast (pure functions).
//   opening balance   = bank balance the admin typed (as at a date) rolled
//                       forward with the cash lines since that date
//   + receipts        = open sales invoices, landing in the week of
//                       due date + the client's historical days-late
//   − payroll         = weekly pattern from recent wage payments (or the
//                       approved-timesheet pay when Xero has none)
//   − recurring bills = suppliers that repeat weekly / monthly in the bank lines
//   − ATO / super     = compliance obligations with their estimates
// Runway = first week whose closing balance goes below zero.

import { weekStart } from './booksMargin';

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const p = (n) => String(n).padStart(2, '0');
const utc = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const iso = (d) => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
export const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

// Balance today from a typed balance + cash movements since that date.
export function rollForwardBalance(bankBalance, balanceDate, transactions, today) {
  if (bankBalance === null || bankBalance === undefined || !balanceDate) return null;
  let bal = num(bankBalance);
  for (const t of transactions || []) {
    if (!t.is_cash || !t.txn_date || t.txn_date <= balanceDate || t.txn_date > today) continue;
    bal += t.direction === 'in' ? num(t.total) : -num(t.total);
  }
  return r2(bal);
}

// Historical days-to-pay per contact from paid invoices:
// rows { contact, due_date, paid_date } → Map(contact → median days late, can be negative)
export function daysLateByContact(paid) {
  const m = new Map();
  for (const r of paid || []) {
    if (!r.contact || !r.due_date || !r.paid_date) continue;
    const d = daysBetween(r.due_date, r.paid_date);
    if (!m.has(r.contact)) m.set(r.contact, []);
    m.get(r.contact).push(d);
  }
  const out = new Map();
  for (const [k, arr] of m) {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    out.set(k, arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2));
  }
  return out;
}

// Expected receipt date for an open invoice. Already-overdue invoices with no
// history land next week (not in the past).
export function expectedReceiptDate(item, lateMap, today, defaultLate = 7) {
  const due = item.due_date || item.issue_date || today;
  const late = lateMap?.has(item.contact_name) ? lateMap.get(item.contact_name) : defaultLate;
  let when = addDays(due, Math.max(0, late));
  if (when < today) when = addDays(today, 7);
  return when;
}

// Weekly payroll from wage payments in the bank lines: median of the last 8
// weeks that had one. Falls back to timesheet pay when Xero has no wage lines.
export const WAGE_RE = /(wage|payroll|salary|net pay|staff pay)/i;
export function weeklyPayroll(transactions, today, fallbackWeekly = 0) {
  const byWeek = new Map();
  const from = addDays(today, -56);
  for (const t of transactions || []) {
    if (!t.is_cash || t.direction !== 'out' || !t.txn_date || t.txn_date < from || t.txn_date > today) continue;
    const text = `${t.contact_name || ''} ${t.description || ''} ${t.account_name || ''}`;
    if (!WAGE_RE.test(text)) continue;
    const w = weekStart(t.txn_date);
    byWeek.set(w, (byWeek.get(w) || 0) + num(t.total));
  }
  const vals = [...byWeek.values()].sort((a, b) => a - b);
  if (!vals.length) return { weekly: r2(fallbackWeekly), source: fallbackWeekly ? 'timesheets' : 'none', weeks: 0 };
  const mid = Math.floor(vals.length / 2);
  const med = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return { weekly: r2(med), source: 'bank', weeks: vals.length };
}

// Recurring suppliers: ≥ 3 spend lines, regular gap (weekly ±2 d or monthly
// ±5 d), amounts within ±25 % of their median. Returns next occurrences in the
// horizon.
export function recurringBills(transactions, today, horizonDays = 91) {
  const groups = new Map();
  const from = addDays(today, -190);
  for (const t of transactions || []) {
    if (!t.is_cash || t.direction !== 'out' || !t.txn_date || t.txn_date < from || t.txn_date > today) continue;
    if (!t.contact_name || WAGE_RE.test(t.contact_name)) continue;
    const key = String(t.contact_name).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!groups.has(key)) groups.set(key, { name: t.contact_name, rows: [] });
    groups.get(key).rows.push({ date: t.txn_date, amount: Math.abs(num(t.total)) });
  }
  const out = [];
  for (const g of groups.values()) {
    const rows = g.rows.sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length < 3) continue;
    const gaps = []; for (let i = 1; i < rows.length; i += 1) gaps.push(daysBetween(rows[i - 1].date, rows[i].date));
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
    let cadence = null;
    if (medGap >= 5 && medGap <= 9 && gaps.every((x) => Math.abs(x - 7) <= 2)) cadence = 7;
    else if (medGap >= 12 && medGap <= 16 && gaps.every((x) => Math.abs(x - 14) <= 3)) cadence = 14;
    else if (medGap >= 25 && medGap <= 36 && gaps.every((x) => Math.abs(x - 30) <= 5)) cadence = 30;
    if (!cadence) continue;
    const amts = rows.map((r) => r.amount).sort((a, b) => a - b);
    const medAmt = amts[Math.floor(amts.length / 2)];
    if (!medAmt || !amts.every((a) => Math.abs(a - medAmt) / medAmt <= 0.25)) continue;
    const last = rows[rows.length - 1].date;
    const occurrences = [];
    let next = addDays(last, cadence);
    while (next < today) next = addDays(next, cadence);
    const end = addDays(today, horizonDays);
    while (next <= end) { occurrences.push(next); next = addDays(next, cadence); }
    out.push({ name: g.name, cadence, amount: r2(medAmt), last, occurrences });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// Assemble the 13 weeks.
// opts: { today, opening, openItems (ACCREC), lateMap, payroll { weekly }, bills, obligations [{due, amount, type, label}], weeks }
export function buildForecast(opts) {
  const { today, opening, openItems = [], lateMap = new Map(), payroll = { weekly: 0 }, bills = [], obligations = [], weeks = 13 } = opts;
  const start = weekStart(today);
  const rows = [];
  for (let i = 0; i < weeks; i += 1) {
    const ws = addDays(start, i * 7);
    rows.push({ week: ws, end: addDays(ws, 6), receipts: 0, payroll: 0, bills: 0, ato: 0, items: [] });
  }
  const bucket = (date) => { const i = Math.floor(daysBetween(start, date) / 7); return i >= 0 && i < weeks ? rows[i] : null; };
  for (const it of openItems) {
    if (num(it.amount_due) <= 0) continue;
    const when = expectedReceiptDate(it, lateMap, today);
    const b = bucket(when); if (!b) continue;
    b.receipts += num(it.amount_due);
    b.items.push({ kind: 'receipt', label: `${it.contact_name || 'Invoice'} ${it.number || ''}`.trim(), amount: num(it.amount_due), date: when });
  }
  for (const r of rows) { r.payroll = num(payroll.weekly); }
  for (const bill of bills) for (const d of bill.occurrences || []) {
    const b = bucket(d); if (!b) continue;
    b.bills += bill.amount;
    b.items.push({ kind: 'bill', label: bill.name, amount: -bill.amount, date: d });
  }
  for (const o of obligations) {
    if (!o.due || o.amount === null || o.amount === undefined) continue;
    const b = bucket(o.due); if (!b) continue;
    const amt = Math.max(0, num(o.amount));
    b.ato += amt;
    b.items.push({ kind: 'ato', label: o.label, amount: -amt, date: o.due });
  }
  let bal = opening === null || opening === undefined ? null : num(opening);
  let runway = null;
  let low = null;
  for (const r of rows) {
    r.opening = bal;
    r.out = r2(r.payroll + r.bills + r.ato);
    r.net = r2(r.receipts - r.out);
    r.receipts = r2(r.receipts); r.payroll = r2(r.payroll); r.bills = r2(r.bills); r.ato = r2(r.ato);
    if (bal !== null) {
      bal = r2(bal + r.net);
      r.closing = bal;
      if (low === null || bal < low.closing) low = { week: r.week, closing: bal };
      if (runway === null && bal < 0) runway = r.week;
    } else { r.closing = null; }
    r.items.sort((a, b) => a.date.localeCompare(b.date));
  }
  return {
    weeks: rows,
    opening: opening === null || opening === undefined ? null : r2(num(opening)),
    closing: rows.length ? rows[rows.length - 1].closing : null,
    runway_week: runway,                         // first week that goes negative, or null
    lowest: low,
    total_in: r2(rows.reduce((s, r) => s + r.receipts, 0)),
    total_out: r2(rows.reduce((s, r) => s + r.out, 0)),
  };
}

// SVG path points for the closing-balance line (no chart library).
export function forecastPolyline(weeksRows, width = 320, height = 120, pad = 6) {
  const vals = (weeksRows || []).map((r) => (r.closing === null ? 0 : r.closing));
  if (!vals.length) return { points: '', zeroY: height / 2, min: 0, max: 0 };
  const min = Math.min(0, ...vals); const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const x = (i) => pad + (i * (width - pad * 2)) / Math.max(1, vals.length - 1);
  const y = (v) => pad + ((max - v) / span) * (height - pad * 2);
  return { points: vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), zeroY: y(0), min, max, x, y };
}

export function forecastCSVRows(fc) {
  return (fc?.weeks || []).map((w) => ({
    'Week': w.week, 'Opening $': w.opening === null ? '' : w.opening.toFixed(2), 'Receipts $': w.receipts.toFixed(2),
    'Payroll $': w.payroll.toFixed(2), 'Bills $': w.bills.toFixed(2), 'ATO/super $': w.ato.toFixed(2),
    'Net $': w.net.toFixed(2), 'Closing $': w.closing === null ? '' : w.closing.toFixed(2),
  }));
}
