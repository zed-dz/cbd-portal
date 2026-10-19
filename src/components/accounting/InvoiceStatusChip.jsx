import { supabase } from '../../supabaseClient';
import { Badge } from '../ui/Badge';
import { invoiceChip } from '../../utils/invoiceStatus';

// Chip key → Badge palette colour.
const BADGE_COLOR = { draft: 'gray', awaiting: 'yellow', overdue: 'red', paid: 'green', voided: 'gray', failed: 'red', other: 'gray' };

// Status chip for one client_invoices row (Draft / Awaiting payment / Overdue /
// Paid dd/mm/yyyy / Voided). Admin screens only — the row carries money.
export function InvoiceStatusChip({ invoice, size = 'sm' }) {
  const chip = invoiceChip(invoice);
  const title = [chip.title, invoice?.sync_error ? `Last check: ${invoice.sync_error}` : ''].filter(Boolean).join(' · ');
  return (
    <span title={title || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Badge label={chip.label} color={BADGE_COLOR[chip.key] || 'gray'} size={size} />
      {invoice?.sync_error && <span aria-label="last check failed" style={{ fontSize: 11 }}>⚠</span>}
    </span>
  );
}

// "↻ Check payments": ask Xero for the latest status of open invoices.
// Resolves to the function's JSON (or null on a hard failure) and toasts a
// plain-English result. clientId limits the check to one client.
export async function checkInvoicePayments({ clientId = null, showToast } = {}) {
  const { data, error } = await supabase.functions.invoke('xero-invoice-sync', { body: clientId ? { client_id: clientId } : {} });
  if (error) {
    let msg = error.message;
    try { const b = await error.context.json(); msg = b?.errors?.[0] || b?.error || msg; } catch { /* keep msg */ }
    showToast?.(`Payment check failed: ${msg}`, 'error');
    return null;
  }
  if (data?.ok === false && data?.message) {
    showToast?.(data.message, 'error');
  } else if (!data?.checked) {
    showToast?.('Nothing to check — no open Xero invoices.', 'info');
  } else {
    const errs = (data.errors || []).length;
    showToast?.(
      `Checked ${data.checked} invoice${data.checked === 1 ? '' : 's'} in Xero · ${data.changed || 0} changed${errs ? ` · ${errs} problem${errs === 1 ? '' : 's'}` : ''}`,
      errs ? 'error' : 'success',
    );
  }
  return data || null;
}
