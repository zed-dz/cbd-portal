// Client invoice status — one place that turns a client_invoices row (Xero
// status + due date + amounts) into the chip the office sees.
//
// The xero-invoice-sync edge function carries a port of `isOverdue` (keep the
// two in step): AUTHORISED + something still owing + due date before today
// (Sydney calendar date) = OVERDUE. Xero itself has no "overdue" status.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

// Chip colours (hex so the chip works on both the dark app and a print page).
export const CHIP_COLORS = {
  draft:    '#8a92a8',
  awaiting: '#eab308',
  overdue:  '#ef4444',
  paid:     '#22c55e',
  voided:   '#5b6276',
  failed:   '#ef4444',
  other:    '#8a92a8',
};

// 'YYYY-MM-DD' → 'DD/MM/YYYY' without going through a Date (no TZ drift).
export function fmtISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Whole days from a to b (both 'YYYY-MM-DD'); positive when b is later.
export function daysBetween(a, b) {
  const ta = Date.parse(`${String(a).slice(0, 10)}T12:00:00Z`);
  const tb = Date.parse(`${String(b).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

// Today's calendar date in Sydney, 'YYYY-MM-DD'.
export function sydneyTodayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(now);
}

// The overdue rule. amountDue null = never synced yet → still counts as owing.
export function isOverdue(xeroStatus, dueDate, amountDue, today) {
  if (String(xeroStatus || '').toUpperCase() !== 'AUTHORISED') return false;
  if (!dueDate || !today) return false;
  const due = num(amountDue);
  if (due !== null && due <= 0) return false;
  return String(dueDate).slice(0, 10) < String(today).slice(0, 10);
}

// Money on a row: Xero's figures once synced (inc GST), else the portal's own
// ex-GST total from when the draft was created.
export function invoiceAmounts(inv) {
  const portalTotal = num(inv?.amount_cents) !== null ? num(inv.amount_cents) / 100 : null;
  const total = num(inv?.total) !== null ? num(inv.total) : portalTotal;
  const paid = num(inv?.amount_paid) !== null ? num(inv.amount_paid) : 0;
  const status = String(inv?.xero_status || '').toUpperCase();
  let due = num(inv?.amount_due);
  // Rows that never reached Xero (old Stripe attempts) have no tracked balance.
  if (due === null && inv?.xero_invoice_id) {
    due = ['PAID', 'VOIDED', 'DELETED'].includes(status) ? 0 : (total !== null ? Math.max(0, total - paid) : null);
  }
  return { total, paid, due, synced: num(inv?.total) !== null };
}

// → { key, label, color, title }
//   key ∈ draft | awaiting | overdue | paid | voided | failed | other
export function invoiceChip(inv, today = sydneyTodayISO()) {
  const xs = String(inv?.xero_status || '').toUpperCase();
  const chip = (key, label, title = '') => ({ key, label, color: CHIP_COLORS[key], title });

  if (!inv?.xero_invoice_id) {
    // Older Stripe rows (and anything not in Xero).
    const s = String(inv?.status || '').toLowerCase();
    if (s === 'error') return chip('failed', 'Failed', inv?.error ? String(inv.error).slice(0, 200) : 'The invoice was not created.');
    if (s === 'paid') return chip('paid', 'Paid');
    return chip('other', s ? s.charAt(0).toUpperCase() + s.slice(1) : '—');
  }

  const { due, paid } = invoiceAmounts(inv);
  switch (xs) {
    case 'DRAFT':
    case '':
      return chip('draft', 'Draft', 'Still a draft in Xero — not sent to the client yet.');
    case 'SUBMITTED':
      return chip('draft', 'Awaiting approval', 'Submitted for approval in Xero — not sent to the client yet.');
    case 'PAID':
      return chip('paid', inv.fully_paid_on ? `Paid ${fmtISODate(inv.fully_paid_on)}` : 'Paid');
    case 'VOIDED':
      return chip('voided', 'Voided');
    case 'DELETED':
      return chip('voided', 'Deleted');
    case 'AUTHORISED': {
      if (isOverdue(xs, inv.due_date, inv.amount_due, today)) {
        const late = daysBetween(inv.due_date, today);
        return chip('overdue', 'Overdue', `Due ${fmtISODate(inv.due_date)} — ${late} day${late === 1 ? '' : 's'} late.`);
      }
      const dueTxt = inv.due_date ? `Due ${fmtISODate(inv.due_date)}` : '';
      if (paid > 0 && (due === null || due > 0)) return chip('awaiting', 'Part paid', dueTxt);
      return chip('awaiting', 'Awaiting payment', dueTxt);
    }
    default:
      return chip('other', xs.charAt(0) + xs.slice(1).toLowerCase());
  }
}

// Filter buckets on the Invoices page.
export const INVOICE_FILTERS = [
  { id: 'all',     label: 'All' },
  { id: 'unpaid',  label: 'Unpaid' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid',    label: 'Paid' },
];
export function matchesFilter(inv, filter, today = sydneyTodayISO()) {
  const key = invoiceChip(inv, today).key;
  if (filter === 'unpaid') return key === 'awaiting' || key === 'overdue';
  if (filter === 'overdue') return key === 'overdue';
  if (filter === 'paid') return key === 'paid';
  return true;
}

// Totals row: what is still owed, and how much of that is overdue.
export function invoiceTotals(invoices, today = sydneyTodayISO()) {
  let outstanding = 0; let overdue = 0; let overdueCount = 0; let unpaidCount = 0;
  for (const inv of invoices || []) {
    const key = invoiceChip(inv, today).key;
    if (key !== 'awaiting' && key !== 'overdue') continue;
    const { due } = invoiceAmounts(inv);
    const d = due || 0;
    outstanding += d; unpaidCount += 1;
    if (key === 'overdue') { overdue += d; overdueCount += 1; }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return { outstanding: r2(outstanding), overdue: r2(overdue), unpaidCount, overdueCount };
}

// Xero dates arrive either as '/Date(1760832000000+0000)/' or '2026-10-19T00:00:00'.
// → 'YYYY-MM-DD' (Xero dates are calendar dates, so UTC is right here) or null.
export function parseXeroDate(v) {
  if (!v) return null;
  const s = String(v);
  const ms = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}
