// Pure helpers for the Books page (no React, no Supabase) — mirrored in SQL
// (books_debtor_ageing / books_exceptions, 20261109_books.sql). Keep in step.

export const BOOKS_KIND_LABELS = {
  spend: 'Spend money',
  receive: 'Receive money',
  invoice_payment: 'Invoice payment',
  bill_payment: 'Bill payment',
  credit_note: 'Credit note',
  prepayment: 'Prepayment',
  overpayment: 'Overpayment',
};

export const AGEING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'];

// Money for the screen: A$ with two decimals, negatives in brackets.
export function fmtMoney(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const s = `$${Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `(${s})` : s;
}

// Days from `due` (YYYY-MM-DD) to `today` (YYYY-MM-DD); positive = overdue.
export function daysOverdue(due, today) {
  if (!due || !today) return 0;
  const d = Date.parse(`${String(due).slice(0, 10)}T12:00:00Z`);
  const t = Date.parse(`${String(today).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return 0;
  return Math.round((t - d) / 86400000);
}

// Which ageing bucket an open item sits in. No due date = current.
export function ageingBucket(due, today) {
  const late = daysOverdue(due, today);
  if (!due || late <= 0) return 'current';
  if (late <= 30) return '1-30';
  if (late <= 60) return '31-60';
  if (late <= 90) return '61-90';
  return '90+';
}

// Sum open items into the five buckets: { bucket: { amount, count } }.
export function ageingTotals(items, today) {
  const out = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, { amount: 0, count: 0 }]));
  for (const it of items || []) {
    const due = Number(it.amount_due) || 0;
    if (due <= 0) continue;
    const b = ageingBucket(it.due_date, today);
    out[b].amount = Math.round((out[b].amount + due) * 100) / 100;
    out[b].count += 1;
  }
  return out;
}

// Duplicate key: same contact + same amount + same number/reference. When both
// the invoice number and the reference are blank, the key falls back to
// contact + amount + a 3-day window (audit fix #8: two identical site invoices
// paid in the same week with different numbers are NOT duplicates).
export function duplicateKey(t) {
  const contact = t.contact_id || t.contact_name || '';
  const amount = Number(t.total || 0).toFixed(2);
  const num = String(t.invoice_number || t.reference || '').trim();
  if (num) return `${contact}|${amount}|${t.kind || ''}|${num.toLowerCase()}`;
  const day = t.txn_date ? Math.floor(Date.parse(`${String(t.txn_date).slice(0, 10)}T12:00:00Z`) / 86400000) : 0;
  // 3-day window: bucket by every third day so neighbours share a key.
  return `${contact}|${amount}|${t.kind || ''}|~${Math.floor(day / 3)}`;
}

export function findDuplicates(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    const k = duplicateKey(r);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(r);
  }
  return [...seen.values()].filter((g) => g.length > 1);
}

// 'YYYY-MM' of a date string.
export function monthKey(dateStr) {
  const m = /^(\d{4}-\d{2})/.exec(String(dateStr || ''));
  return m ? m[1] : '';
}

// Group cash rows by month: [{ month: 'YYYY-MM', cash_in, cash_out, net }], oldest first.
export function groupByMonth(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const k = monthKey(r.txn_date);
    if (!k) continue;
    const g = m.get(k) || { month: k, cash_in: 0, cash_out: 0, net: 0 };
    const v = Number(r.total) || 0;
    if (r.direction === 'out') g.cash_out = Math.round((g.cash_out + v) * 100) / 100;
    else g.cash_in = Math.round((g.cash_in + v) * 100) / 100;
    g.net = Math.round((g.cash_in - g.cash_out) * 100) / 100;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Short month label for the bar list: '2026-11' → 'Nov 26'.
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return ym || '';
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1].slice(2)}`;
}

// The BAS quarter that contains `today` (YYYY-MM-DD): { from, to, label }.
export function basQuarter(today) {
  const y = Number(String(today).slice(0, 4));
  const mo = Number(String(today).slice(5, 7));
  const qStart = mo - ((mo - 1) % 3);
  const endMonth = qStart + 2;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return {
    from: `${y}-${p(qStart)}-01`,
    to: `${y}-${p(endMonth)}-${p(lastDay)}`,
    label: `${names[qStart - 1]}–${names[endMonth - 1]} ${y}`,
  };
}

// Months back from `today`, first day: used for the Transactions month picker.
export function monthOptions(today, count = 13) {
  const y = Number(String(today).slice(0, 4));
  const mo = Number(String(today).slice(5, 7));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(y, mo - 1 - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ value: ym, label: monthLabel(ym) });
  }
  return out;
}

export function monthBounds(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return { from: '', to: '' };
  const y = Number(m[1]); const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

// Does an open Xero invoice number belong to one of OUR portal invoices?
export function isOurs(number, portalNumbers) {
  if (!number || !portalNumbers) return false;
  const n = String(number).trim().toLowerCase();
  return n !== '' && portalNumbers.has(n);
}
